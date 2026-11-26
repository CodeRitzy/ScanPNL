// paper trading math: fills, fees, position stats and number formatting
(function (root)
{
  "use strict";

  // default trade costs: platform fee, token tax and slippage are fractions, fixed is
  // priority fee + bribe in sol paid per wallet per trade
  const DEFAULT_COSTS = { platform: 0.01, fee: 0, slip: 0, fixed: 0.002 };

  // subscript digits used to show how many zeros follow "0.0"
  const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

  // pumpswap fee by market cap in sol: [market cap from, total fee %]
  const PUMP_SWAP_FEES = [
    [0, 1.25],
    [420, 1.2],
    [1470, 1.15],
    [2460, 1.1],
    [3440, 1.05],
    [4420, 1],
    [9820, 0.95],
    [14740, 0.9],
    [19650, 0.85],
    [24560, 0.8],
    [29470, 0.75],
    [34380, 0.7],
    [39300, 0.65],
    [44210, 0.6],
    [49120, 0.55],
    [54030, 0.525],
    [58940, 0.5],
    [63860, 0.475],
    [68770, 0.45],
    [73681, 0.425],
    [78590, 0.4],
    [83500, 0.375],
    [88400, 0.35],
    [93330, 0.325],
    [98240, 0.3],
  ];

  // formats a number: tiny values as 0.0₂84 (up to 9 hidden zeros), others with up to 3 decimals
  function displayNumber(input, digits = 2)
  {
    let value = Number(input || 0);
    const size = Math.abs(value);
    if (size > 0 && size < 0.01)
    {
      const [mantissa, exponent] = size.toExponential(digits - 1).split("e");
      const zeros = -Number(exponent) - 1;
      if (zeros > 9) return "0";
      // one zero means rounding carried the value up to 0.01, shown as a normal number
      if (zeros >= 2)
      {
        const subscript = String(zeros).replace(/\d/g, (digit) => SUBSCRIPTS[digit]);
        const significant = mantissa.replace(".", "").replace(/0+$/, "");
        return (value < 0 ? "-" : "") + "0.0" + subscript + significant;
      }
      value = Math.sign(value) * Number(size.toExponential(digits - 1));
    }
    return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  }

  // formats a pnl percent as a signed whole number rounded down
  function pnlPercent(percent)
  {
    const whole = Math.floor(Number(percent) || 0) || 0;
    return (whole >= 0 ? "+" : "") + whole + "%";
  }

  // throws unless the value is a positive finite number
  function requirePositive(value, label)
  {
    if (!Number.isFinite(value) || value <= 0) throw Error(`Invalid ${label}`);
  }

  // creates an empty paper account with a starting balance
  function create(balance = 10)
  {
    requirePositive(balance, "starting balance");
    return { version: 1, initial: balance, balance, positions: {}, trades: [] };
  }

  // throws unless the quote names a token and is fresh (at most 5 s old)
  function quote(token, now = Date.now())
  {
    if (!token || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.mint))
    {
      throw Error("Token identity unavailable");
    }
    requirePositive(token.usd, "token price");
    requirePositive(token.solUsd, "SOL price");
    if (!Number.isFinite(token.at) || now - token.at > 5000 || token.at > now + 1000)
    {
      throw Error("Read a fresh displayed quote first");
    }
  }

  // fills one paper order and returns the new account; buys spend sol, sells a fraction
  function trade(account, side, amount, token, costs = DEFAULT_COSTS, now = Date.now())
  {
    quote(token, now);
    requirePositive(amount, "amount");
    if (!["buy", "sell"].includes(side)) throw Error("Unsupported order");
    // orders saved before the platform fee existed charge none
    const platform = costs.platform ?? 0;
    for (const cost of [costs.fee, costs.slip, costs.fixed, platform])
    {
      if (!Number.isFinite(cost) || cost < 0) throw Error("Invalid simulation costs");
    }
    if (costs.fee >= 1 || costs.slip >= 1 || platform >= 1)
    {
      throw Error("Invalid simulation costs");
    }
    const next = structuredClone(account);
    const position = (next.positions[token.mint] ||= {
      mint: token.mint,
      name: String(token.name || token.mint.slice(0, 6)).slice(0, 64),
      url: token.url,
      qty: 0,
      basis: 0,
      bought: 0,
      sold: 0,
      realized: 0,
    });
    const priceSol = token.usd / token.solUsd;
    let qty, cash, fee, platformFee, taxFee;
    if (side === "buy")
    {
      if (amount > next.balance) throw Error("Insufficient paper SOL");
      if (amount <= costs.fixed) throw Error("Amount is smaller than the simulated fee");
      // priority + bribe first, then the platform fee and the token tax come out of the amount
      const swap = amount - costs.fixed;
      platformFee = swap * platform;
      taxFee = (swap - platformFee) * costs.fee;
      const spent = swap - platformFee - taxFee;
      fee = amount - spent;
      cash = amount;
      qty = spent / (priceSol * (1 + costs.slip));
      next.balance -= cash;
      position.qty += qty;
      position.basis += cash;
      position.bought += cash;
    }
    else
    {
      if (amount > 1) throw Error("Sell fraction must be at most 100%");
      if (!(position.qty > 0)) throw Error("No paper position to sell");
      qty = position.qty * amount;
      // tax and platform fee come off the proceeds, then priority + bribe
      const proceeds = qty * priceSol * (1 - costs.slip);
      taxFee = proceeds * costs.fee;
      platformFee = (proceeds - taxFee) * platform;
      fee = taxFee + platformFee + costs.fixed;
      cash = proceeds - fee;
      if (cash <= 0) throw Error("Sale is smaller than the simulated fee");
      const basisSold = position.basis * amount;
      next.balance += cash;
      position.qty -= qty;
      position.basis -= basisSold;
      position.sold += cash;
      position.realized += cash - basisSold;
      if (amount === 1)
      {
        position.qty = 0;
        position.basis = 0;
      }
    }
    position.usd = token.usd;
    position.solUsd = token.solUsd;
    position.at = token.at;
    next.trades.push({
      side,
      mint: token.mint,
      qty,
      cash,
      fee,
      platformFee,
      taxFee,
      networkFee: costs.fixed,
      usd: token.usd,
      solUsd: token.solUsd,
      at: now,
    });
    return next;
  }

  // position stats in sol (and in usd when the trades are given)
  function metrics(position, solUsd, trades)
  {
    if (!position) return { bought: 0, sold: 0, holding: 0, pnl: 0, pct: 0, fees: 0 };
    const holding = (position.qty * position.usd) / (solUsd || position.solUsd);
    const pnl = position.sold + holding - position.bought;
    const stats = {
      bought: position.bought,
      sold: position.sold,
      holding,
      pnl,
      pct: position.bought ? (pnl / position.bought) * 100 : 0,
    };
    if (Array.isArray(trades))
    {
      let boughtUsd = 0;
      let soldUsd = 0;
      // fees are already inside bought and sold; this is their total for display
      stats.fees = 0;
      for (const fill of trades)
      {
        if (fill.mint !== position.mint) continue;
        if (Number.isFinite(fill.fee)) stats.fees += fill.fee;
        const usd = fill.cash * fill.solUsd;
        if (!Number.isFinite(usd)) continue;
        if (fill.side === "buy") boughtUsd += usd;
        else if (fill.side === "sell") soldUsd += usd;
      }
      const holdingUsd = position.qty > 0 ? position.qty * position.usd : 0;
      const pnlUsd = soldUsd + holdingUsd - boughtUsd;
      stats.usd = {
        bought: boughtUsd,
        sold: soldUsd,
        holding: holdingUsd,
        pnl: pnlUsd,
        pct: boughtUsd ? (pnlUsd / boughtUsd) * 100 : 0,
      };
    }
    return stats;
  }

  // a token's trades since the buy that reopened it after the last full exit
  function roundTrades(trades, mint)
  {
    const fills = trades.filter((fill) => fill.mint === mint).sort((a, b) => a.at - b.at);
    let held = 0;
    let peak = 0;
    let start = 0;
    fills.forEach((fill, index) =>
    {
      if (fill.side === "buy")
      {
        // holdings down to float dust of the round's peak count as a full exit
        if (held <= peak * 1e-9)
        {
          start = index;
          held = peak = 0;
        }
        held += fill.qty;
        peak = Math.max(peak, held);
      }
      else held -= fill.qty;
    });
    return fills.slice(start);
  }

  // fills one order split evenly across several paper wallets
  function tradeMany(
    account,
    side,
    amount,
    token,
    wallets = 1,
    costs = DEFAULT_COSTS,
    now = Date.now(),
  )
  {
    if (!Number.isInteger(wallets) || wallets < 1 || wallets > 20)
    {
      throw Error("Choose 1–20 simulated wallets");
    }
    if (wallets === 1) return trade(account, side, amount, token, costs, now);
    const fields = ["qty", "basis", "bought", "sold", "realized"];
    // trade one wallet's share of the account, then scale the result back up
    const share = structuredClone(account);
    share.balance /= wallets;
    share.initial /= wallets;
    share.trades = [];
    for (const position of Object.values(share.positions))
    {
      for (const field of fields) position[field] /= wallets;
    }
    const filled = trade(share, side, amount, token, costs, now);
    const next = structuredClone(account);
    next.balance = filled.balance * wallets;
    next.positions = filled.positions;
    for (const position of Object.values(next.positions))
    {
      for (const field of fields) position[field] *= wallets;
    }
    const batchId = `${now}-${account.trades.length}`;
    for (let wallet = 0; wallet < wallets; wallet++)
    {
      next.trades.push({ ...filled.trades[0], wallet: wallet + 1, walletCount: wallets, batchId });
    }
    next.walletCount = wallets;
    return next;
  }

  // token tax for pump launchpads when axiom shows none: 1.25% on the curve, pumpswap by market cap
  function pumpTax(protocol, mcapSol)
  {
    const name = String(protocol || "").toLowerCase();
    if (/pump\s*(?:amm|swap)/.test(name))
    {
      let percent = PUMP_SWAP_FEES[0][1];
      for (const [from, fee] of PUMP_SWAP_FEES) if (mcapSol >= from) percent = fee;
      return percent / 100;
    }
    return /^pump/.test(name) ? 0.0125 : null;
  }

  // true for axiom token page paths
  function tokenRoute(pathname)
  {
    return /^\/(meme|t|token)\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(pathname);
  }

  // account totals: free sol, value held in tokens, equity and pnl since the start or last reset
  function portfolio(account, solUsd)
  {
    const holding = Object.values(account.positions).reduce(
      (sum, position) => sum + metrics(position, solUsd).holding,
      0,
    );
    return {
      balance: account.balance,
      holding,
      equity: account.balance + holding,
      pnl: account.balance + holding - account.initial - (account.pnlResetOffset || 0),
    };
  }

  // parses a displayed price; with a zero count it reads axiom's 0.0₄12 form
  function priceText(text, zeroCount, digits)
  {
    if (zeroCount != null)
    {
      const zeros = Number(zeroCount);
      if (!Number.isInteger(zeros) || zeros < 1 || zeros > 30 || !/^\d+$/.test(digits)) return NaN;
      return Number("0." + "0".repeat(zeros) + digits);
    }
    const plain = text.replace(/[$,\s]/g, "");
    return /^\d+(\.\d+)?$/.test(plain) ? Number(plain) : NaN;
  }

  const api = {
    defaults: DEFAULT_COSTS,
    create,
    trade,
    tradeMany,
    quote,
    metrics,
    roundTrades,
    priceText,
    pumpTax,
    tokenRoute,
    portfolio,
    displayNumber,
    pnlPercent,
  };
  root.ScanPNLCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
