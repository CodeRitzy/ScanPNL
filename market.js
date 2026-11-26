// market prices from dexscreener for tokens without a live axiom price
(function (root)
{
  "use strict";

  const SOL = "So11111111111111111111111111111111111111112";

  // turns a dexscreener response into quotes, keeping the most liquid pair per token
  function parse(pairs, mints, now = Date.now(), previous = {})
  {
    if (!Array.isArray(pairs)) throw Error("Unexpected market response");
    const best = {};
    for (const pair of pairs)
    {
      const mint = pair?.baseToken?.address;
      if (pair?.chainId !== "solana" || !mints.includes(mint) || !(Number(pair.priceUsd) > 0))
      {
        continue;
      }
      const liquidity = Number(pair.liquidity?.usd) || 0;
      if (!best[mint] || liquidity > (Number(best[mint].liquidity?.usd) || 0)) best[mint] = pair;
    }
    const solUsd = Number(best[SOL]?.priceUsd) || previous.solUsd;
    const quotes = { ...previous.quotes };
    for (const mint of mints)
    {
      const pair = best[mint];
      if (!pair || !(solUsd > 0)) continue;
      quotes[mint] = {
        mint,
        usd: Number(pair.priceUsd),
        solUsd,
        at: now,
        source: "dexscreener",
        pair: pair.pairAddress,
        name: pair.baseToken.symbol,
        image: pair.info?.imageUrl,
      };
    }
    return {
      solUsd,
      solUsdAt: best[SOL] ? now : previous.solUsdAt,
      quotes,
      checkedAt: now,
    };
  }

  // fetches prices for the mints (and sol) in batches of 30
  async function refresh(mints, previous = {}, request = fetch, now)
  {
    const all = [...new Set([SOL, ...mints])];
    const pairs = [];
    for (let start = 0; start < all.length; start += 30)
    {
      const response = await request(
        "https://api.dexscreener.com/tokens/v1/solana/" + all.slice(start, start + 30).join(","),
        {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw Error("Market data HTTP " + response.status);
      pairs.push(...(await response.json()));
    }
    return parse(pairs, all, now ?? Date.now(), previous);
  }

  const api = { SOL, parse, refresh };
  root.ScanPNLMarket = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
