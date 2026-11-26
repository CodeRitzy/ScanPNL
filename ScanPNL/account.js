// paper account: validation, orders and fills, paper wallets, pnl resets and backups
(function (root)
{
  "use strict";

  const core = root.ScanPNLCore;
  const VERSION = 2;
  const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const RESET_PERIODS = ["allTime", "oneDay", "sevenDay", "thirtyDay"];
  const POSITION_TOTALS = ["qty", "basis", "bought", "sold", "realized"];

  // preferences a new account starts with
  const PREFERENCE_DEFAULTS = {
    walletSizing: "per-wallet",
    walletCount: 1,
    pnlCurrency: "SOL",
    pnlChartMode: "total",
    shareRank: "native",
    tokenDisplay: "market-cap",
    executionDelayMs: 100,
    costs: { ...core.defaults },
    paperEnabled: true,
    buyPresets: [0.01, 0.1, 0.5, 1],
    sellPresets: [0.1, 0.25, 0.5, 1],
  };

  // true for a finite number within [min, max]
  const finite = (value, min = 0, max = Number.MAX_VALUE) =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

  // delay before an order fills: fixed, or random within the chosen range
  function executionDelay(preferences, random = Math.random)
  {
    if (preferences.executionDelayMode !== "random") return preferences.executionDelayMs;
    const min = preferences.executionDelayMinMs ?? preferences.executionDelayMs;
    const max = preferences.executionDelayMaxMs ?? preferences.executionDelayMs;
    return Math.round(min + random() * (max - min));
  }

  // throws unless every preference is valid; returns the preferences
  function validatePreferences(preferences)
  {
    if (
      preferences.executionDelayMode !== undefined &&
      !["fixed", "random"].includes(preferences.executionDelayMode)
    )
    {
      throw Error("Invalid delay mode");
    }
    if (
      preferences.executionDelayMode === "random" &&
      (!finite(preferences.executionDelayMinMs, 0, 5000) ||
        !finite(preferences.executionDelayMaxMs, 0, 5000) ||
        preferences.executionDelayMinMs > preferences.executionDelayMaxMs)
    )
    {
      throw Error("Delay range must be between 0 and 5 seconds, minimum first");
    }
    if (
      !preferences ||
      !Number.isInteger(preferences.walletCount) ||
      !finite(preferences.walletCount, 1, 20) ||
      !["USD", "SOL"].includes(preferences.pnlCurrency) ||
      !finite(preferences.executionDelayMs, 0, 5000) ||
      typeof preferences.paperEnabled !== "boolean"
    )
    {
      throw Error("Invalid preferences");
    }
    if (
      preferences.pnlChartMode !== undefined &&
      !["total", "realized", "unrealized"].includes(preferences.pnlChartMode)
    )
    {
      throw Error("Invalid PnL chart mode");
    }
    const rank = preferences.shareRank;
    if (
      rank !== undefined &&
      rank !== "native" &&
      (!Number.isInteger(rank) || rank < 1 || rank > 8)
    )
    {
      throw Error("Invalid paper card rank");
    }
    if (
      preferences.tokenDisplay !== undefined &&
      !["market-cap", "token-price"].includes(preferences.tokenDisplay)
    )
    {
      throw Error("Invalid token display");
    }
    if (
      preferences.walletSizing !== undefined &&
      !["split", "per-wallet"].includes(preferences.walletSizing)
    )
    {
      throw Error("Invalid wallet sizing mode");
    }
    const costs = preferences.costs;
    if (
      !costs ||
      !finite(costs.fee, 0, 0.99) ||
      !finite(costs.slip, 0, 0.99) ||
      !finite(costs.fixed, 0, 1) ||
      (costs.platform !== undefined && !finite(costs.platform, 0, 0.99))
    )
    {
      throw Error("Invalid simulation costs");
    }
    for (const [key, max] of [
      ["buyPresets", 1e6],
      ["sellPresets", 1],
    ])
    {
      const presets = preferences[key];
      if (
        !Array.isArray(presets) ||
        !presets.length ||
        presets.length > 12 ||
        !presets.every((preset) => finite(preset, Number.MIN_VALUE, max))
      )
      {
        throw Error("Invalid presets");
      }
    }
    return preferences;
  }

  // checks a stored account, fills in missing fields and upgrades it to the current version
  function normalize(input, legacyPreferences = {}, now = Date.now())
  {
    const account = structuredClone(input || core.create());
    if (account.version > VERSION) throw Error("Account comes from a newer scanpnl version");
    if (
      !finite(account.balance) ||
      !finite(account.initial, -1e6, 1e6) ||
      !account.positions ||
      Array.isArray(account.positions) ||
      !Array.isArray(account.trades)
    )
    {
      throw Error("Invalid account");
    }
    if (account.trades.length > 100000 || Object.keys(account.positions).length > 10000)
    {
      throw Error("Account is too large");
    }
    const latest = now + 60000;

    // positions
    for (const [mint, position] of Object.entries(account.positions))
    {
      if (
        !MINT.test(mint) ||
        position.mint !== mint ||
        !["sol", undefined].includes(position.chain)
      )
      {
        throw Error("Invalid position identity");
      }
      for (const field of ["qty", "basis", "bought", "sold"])
      {
        if (!finite(position[field])) throw Error("Invalid position " + field);
      }
      if (!finite(position.realized, -1e12, 1e12)) throw Error("Invalid realized PnL");
      position.chain = "sol";
      position.name = String(position.name || mint.slice(0, 6)).slice(0, 64);
      position.ticker = String(position.ticker || position.name).slice(0, 64);
      position.url = safeUrl(position.url, mint);
      position.image = safeImage(position.image);
      position.status = position.qty > 0 ? "open" : "closed";
    }

    // trades
    const tradeIds = new Set();
    account.trades.forEach((fill, index) =>
    {
      if (
        !MINT.test(fill.mint) ||
        !["buy", "sell"].includes(fill.side) ||
        !finite(fill.at, 0, latest) ||
        !finite(fill.qty, Number.MIN_VALUE) ||
        !finite(fill.cash) ||
        !finite(fill.fee) ||
        !finite(fill.usd, Number.MIN_VALUE) ||
        !finite(fill.solUsd, Number.MIN_VALUE)
      )
      {
        throw Error("Invalid trade");
      }
      fill.id ||= `legacy-${fill.at}-${index}`;
      if (typeof fill.id !== "string" || tradeIds.has(fill.id)) throw Error("Duplicate trade ID");
      tradeIds.add(fill.id);
      fill.chain = "sol";
    });

    // preferences; accounts from older versions take the legacy values passed in
    const legacy =
      account.version === VERSION
        ? {}
        : Object.fromEntries(
          ["walletCount", "pnlCurrency", "executionDelayMs"]
            .filter((key) => legacyPreferences[key] != null)
            .map((key) => [key, legacyPreferences[key]]),
        );
    account.preferences = validatePreferences({
      ...PREFERENCE_DEFAULTS,
      ...account.preferences,
      ...legacy,
    });

    // orders
    account.orders ||= [];
    if (!Array.isArray(account.orders) || account.orders.length > 100000)
    {
      throw Error("Invalid orders");
    }
    const orderIds = new Set();
    for (const order of account.orders)
    {
      if (
        !order ||
        typeof order.id !== "string" ||
        order.id.length > 128 ||
        orderIds.has(order.id) ||
        !["pending", "filled", "cancelled", "failed"].includes(order.status) ||
        !["buy", "sell"].includes(order.side) ||
        !MINT.test(order.mint) ||
        !finite(order.amount, Number.MIN_VALUE) ||
        !finite(order.createdAt, 0, latest)
      )
      {
        throw Error("Invalid order");
      }
      orderIds.add(order.id);
    }

    // pnl resets
    if (account.pnlResetOffset !== undefined && !finite(account.pnlResetOffset, -1e18, 1e18))
    {
      throw Error("Invalid PNL reset baseline");
    }
    if (account.pnlResets !== undefined)
    {
      const resets = account.pnlResets;
      if (
        !resets ||
        Array.isArray(resets) ||
        Object.keys(resets).some((period) => !RESET_PERIODS.includes(period))
      )
      {
        throw Error("Invalid PNL reset periods");
      }
      for (const reset of Object.values(resets))
      {
        if (
          !reset ||
          !finite(reset.at, 0, latest) ||
          !finite(reset.unrealizedNative, -1e18, 1e18) ||
          !finite(reset.solUsd, 0, 1e9)
        )
        {
          throw Error("Invalid PNL reset period baseline");
        }
      }
      for (const reset of Object.values(resets))
      {
        if (!reset.positions) continue;
        for (const [mint, held] of Object.entries(reset.positions))
        {
          if (
            !MINT.test(mint) ||
            !held ||
            !finite(held.qty) ||
            !finite(held.native) ||
            !finite(held.usd)
          )
          {
            throw Error("Invalid reset position baseline");
          }
        }
      }
    }
    if (account.pnlResetAt !== undefined && !finite(account.pnlResetAt, 0, latest))
    {
      throw Error("Invalid PNL reset timestamp");
    }

    // pnl history
    account.history ||= [];
    if (
      !Array.isArray(account.history) ||
      account.history.length > 50000 ||
      !account.history.every(
        (point) => finite(point.at, 0, latest) && finite(point.pnl, -1e12, 1e12),
      )
    )
    {
      throw Error("Invalid account history");
    }

    // identity
    account.schemaVersion = VERSION;
    account.version = VERSION;
    account.accountId ||= crypto.randomUUID();
    account.createdAt ||= now;
    account.resetCount ||= 0;
    account.updatedAt ||= now;

    // paper wallets, each a full account of its own
    if (account.paperWallets !== undefined)
    {
      const wallets = account.paperWallets;
      if (
        !wallets ||
        Array.isArray(wallets) ||
        typeof wallets !== "object" ||
        Object.keys(wallets).length > 19
      )
      {
        throw Error("Invalid paper wallets");
      }
      for (const [id, wallet] of Object.entries(wallets))
      {
        if (
          !/^[a-f0-9-]{36}$/.test(id) ||
          !wallet ||
          wallet.paperWallets !== undefined ||
          typeof wallet.name !== "string" ||
          !wallet.name.trim() ||
          wallet.name.length > 32
        )
        {
          throw Error("Invalid paper wallet");
        }
        wallets[id] = normalize(wallet, {}, now);
      }
      selectWallets(account, account.selectedPaperWallets || ["main"]);
    }
    return account;
  }

  // an axiom token path for the mint; anything off axiom falls back to /token/<mint>
  function safeUrl(url, mint)
  {
    try
    {
      const parsed = new URL(url || "/token/" + mint, "https://axiom.trade");
      if (parsed.origin === "https://axiom.trade" && core.tokenRoute(parsed.pathname))
      {
        return parsed.pathname + parsed.search;
      }
    }
    catch {}
    return "/token/" + mint + "?chain=sol";
  }

  // an https image url, or nothing
  function safeImage(url)
  {
    try
    {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ? parsed.href : undefined;
    }
    catch
    {
      return undefined;
    }
  }

  // the account with the latest market prices applied and each position's quote status
  function view(account, market = {}, now = Date.now())
  {
    const result = structuredClone(account);
    const quotes = market.quotes || {};
    if (finite(market.solUsd, Number.MIN_VALUE)) result.solUsd = market.solUsd;
    for (const position of Object.values(result.positions))
    {
      const latest = quotes[position.mint];
      if (
        latest &&
        finite(latest.usd, Number.MIN_VALUE) &&
        finite(latest.at, 0) &&
        latest.at >= (position.at || 0)
      )
      {
        position.usd = latest.usd;
        position.solUsd = latest.solUsd || result.solUsd || position.solUsd;
        position.at = latest.at;
        position.quoteSource = latest.source;
      }
      position.quoteStatus = !position.usd
        ? "unavailable"
        : !position.at || now - position.at > 60000
          ? "stale"
          : "fresh";
    }
    return result;
  }

  // [id, account] for the main account and every paper wallet
  function walletEntries(account)
  {
    return [["main", account], ...Object.entries(account.paperWallets || {})];
  }

  // the wallet entries selected for trading
  function selectedEntries(account)
  {
    const selected = new Set(account.selectedPaperWallets || ["main"]);
    return walletEntries(account).filter(([id]) => selected.has(id));
  }

  // adds a paper wallet funded from the main balance and selects it
  function createWallet(account, name, funding)
  {
    name = typeof name === "string" ? name.trim() : "";
    if (!name || name.length > 32) throw Error("Enter a wallet name up to 32 characters");
    if (walletEntries(account).length >= 20) throw Error("Maximum of 20 paper wallets");
    if (!finite(funding, 0, account.balance))
    {
      throw Error("Funding must come from available Main SOL");
    }
    const id = crypto.randomUUID();
    account.paperWallets ||= {};
    account.paperWallets[id] = { ...core.create(), initial: funding, balance: funding, name };
    account.balance -= funding;
    account.initial -= funding;
    account.selectedPaperWallets = [
      ...new Set([...(account.selectedPaperWallets || ["main"]), id]),
    ];
    return account;
  }

  // sets which wallets trade
  function selectWallets(account, ids)
  {
    if (
      !Array.isArray(ids) ||
      ids.length > 20 ||
      ids.some(
        (id) => typeof id !== "string" || !walletEntries(account).some(([known]) => known === id),
      )
    )
    {
      throw Error("Invalid paper wallet selection");
    }
    account.selectedPaperWallets = [...new Set(ids)];
    return account;
  }

  // one combined account of the selected wallets, as the page shows it
  function tradingView(account, market, now)
  {
    if (!account.paperWallets || !Object.keys(account.paperWallets).length)
    {
      return view(account, market, now);
    }
    const selected = selectedEntries(account);
    const selectedIds = selected.map(([id]) => id);
    const combined = {
      ...account,
      balance: 0,
      initial: 0,
      pnlResetOffset: 0,
      positions: {},
      trades: [],
      history: [],
      pnlResets: {},
      pnlResetAt: undefined,
      accountId: account.accountId + ":" + selectedIds.join(","),
    };
    delete combined.paperWallets;

    // sum balances, trades and positions; a merged position keeps its newest quote
    for (const [, wallet] of selected)
    {
      combined.balance += wallet.balance;
      combined.initial += wallet.initial;
      combined.pnlResetOffset += wallet.pnlResetOffset || 0;
      combined.trades.push(...wallet.trades);
      for (const [mint, position] of Object.entries(wallet.positions))
      {
        if (!combined.positions[mint])
        {
          combined.positions[mint] = { ...position };
          continue;
        }
        const existing = combined.positions[mint];
        const merged = { ...((position.at || 0) > (existing.at || 0) ? position : existing) };
        for (const field of POSITION_TOTALS) merged[field] = existing[field] + position[field];
        merged.status = merged.qty > 0 ? "open" : "closed";
        combined.positions[mint] = merged;
      }
    }
    if (selected.length === 1) combined.history = selected[0][1].history || [];

    // a period reset carries over only when every selected wallet reset at the same time
    for (const period of RESET_PERIODS)
    {
      const resets = selected.map(([id, wallet]) => [id, wallet.pnlResets?.[period]]);
      const first = resets[0]?.[1];
      if (!first || !resets.every(([, reset]) => reset?.at === first.at)) continue;
      combined.pnlResets[period] = {
        ...first,
        unrealizedNative: resets.reduce((sum, [, reset]) => sum + reset.unrealizedNative, 0),
        positions: Object.fromEntries(
          resets.flatMap(([id, reset]) =>
            Object.entries(reset.positions || {}).map(([mint, held]) => [
              id === "main" ? mint : id + ":" + mint,
              held,
            ]),
          ),
        ),
      };
    }
    if (selected.length === 1) combined.pnlResetAt = selected[0][1].pnlResetAt;
    combined.trades.sort((a, b) => a.at - b.at);
    combined.walletSummaries = walletEntries(account).map(([id, wallet]) => ({
      id,
      name: id === "main" ? "scanpnl. Main" : wallet.name,
      balance: wallet.balance,
      tokens: Object.values(wallet.positions).filter((position) => position.qty > 0).length,
      selected: selectedIds.includes(id),
    }));
    return view(combined, market, now);
  }

  // records a pending order; an order id seen before returns the existing order
  function begin(account, request, now = Date.now())
  {
    if (typeof request.id !== "string" || request.id.length < 8 || request.id.length > 128)
    {
      throw Error("An execution ID is required");
    }
    const existing = account.orders.find((order) => order.id === request.id);
    if (existing) return { state: account, order: existing };
    if (!account.preferences.paperEnabled) throw Error("Paper execution is paused");
    if (
      !["buy", "sell"].includes(request.side) ||
      !MINT.test(request.mint) ||
      !finite(request.amount, Number.MIN_VALUE) ||
      (request.side === "sell" && request.amount > 1)
    )
    {
      throw Error("Invalid order");
    }

    // with paper wallets: the selected ones that can take this order
    const hasWallets = Object.keys(account.paperWallets || {}).length > 0;
    const walletIds = hasWallets
      ? selectedEntries(account)
        .filter(([, wallet]) => request.side === "buy" || wallet.positions[request.mint]?.qty > 0)
        .map(([id]) => id)
      : null;
    if (walletIds && !walletIds.length)
    {
      throw Error(
        request.side === "buy"
          ? "Select a paper wallet before trading"
          : "No selected paper wallet holds this token",
      );
    }
    const walletCount = walletIds?.length ?? request.walletCount ?? account.preferences.walletCount;
    if (!Number.isInteger(walletCount) || walletCount < 1 || walletCount > 20)
    {
      throw Error("Select 1–20 wallets in Axiom");
    }
    const next = structuredClone(account);
    const order = {
      id: request.id,
      mint: request.mint,
      chain: "sol",
      side: request.side,
      amount: request.amount,
      status: "pending",
      createdAt: now,
      executeAfter: now + executionDelay(next.preferences),
      walletCount,
      ...(walletIds ? { walletIds } : {}),
      walletSizing: next.preferences.walletSizing || "per-wallet",
      costs: { ...next.preferences.costs },
      url: safeUrl(request.url, request.mint),
      accountId: next.accountId,
    };

    // axiom's own trade settings: their costs and a slippage limit against the clicked price
    if (request.nativeSettings)
    {
      const settings = request.nativeSettings;
      if (
        settings.source !== "axiom-native-panel" ||
        !finite(settings.tolerance, 0, 1) ||
        !finite(settings.referenceUsd, Number.MIN_VALUE)
      )
      {
        throw Error("Invalid native execution settings");
      }
      validatePreferences({ ...next.preferences, costs: settings.costs });
      order.costs = { ...settings.costs };
      order.nativeSettings = {
        source: settings.source,
        tolerance: settings.tolerance,
        referenceUsd: settings.referenceUsd,
      };
    }
    next.orders.push(order);
    return { state: next, order };
  }

  // fills a pending order at the given quote and marks it filled
  function fill(account, request, token, now = Date.now())
  {
    const order = account.orders.find((item) => item.id === request.id);
    if (!order) throw Error("Order was not prepared");
    if (order.status !== "pending") return account;
    if (!account.preferences.paperEnabled) throw Error("Paper execution is paused");
    if (now < order.executeAfter) throw Error("Order delay has not elapsed");
    if (!token || token.mint !== order.mint) throw Error("Token changed before execution");
    core.quote(token, now);
    if (order.nativeSettings)
    {
      const settings = order.nativeSettings;
      const move =
        order.side === "buy"
          ? token.usd / settings.referenceUsd - 1
          : 1 - token.usd / settings.referenceUsd;
      if (move > settings.tolerance) throw Error("Native slippage tolerance exceeded");
    }
    const amount =
      order.side === "buy" && order.walletSizing === "split"
        ? order.amount / order.walletCount
        : order.amount;
    const knownSupply = finite(token.supply, Number.MIN_VALUE, 1e18);

    // fills one wallet and tags its new trades; returns [account, new trade ids]
    const apply = (wallet, walletId, wallets) =>
    {
      const before = wallet.trades.length;
      const filled = core.tradeMany(wallet, order.side, amount, token, wallets, order.costs, now);
      filled.trades.slice(before).forEach((fillRecord, index) =>
        Object.assign(fillRecord, {
          id: `${order.id}:${walletId}:${index}`,
          orderId: order.id,
          ...(order.walletIds ? { walletId, batchId: order.id } : {}),
          chain: "sol",
          ...(knownSupply ? { supply: token.supply } : {}),
          fillPriceUsd:
            token.usd * (fillRecord.side === "buy" ? 1 + order.costs.slip : 1 - order.costs.slip),
          releasedBasis:
            fillRecord.side === "sell"
              ? wallet.positions[order.mint].basis *
                (fillRecord.qty / wallet.positions[order.mint].qty)
              : 0,
          slippageSol: ((fillRecord.qty * token.usd) / token.solUsd) * order.costs.slip,
        }),
      );
      const position = filled.positions[order.mint];
      Object.assign(position, {
        chain: "sol",
        status: position.qty > 0 ? "open" : "closed",
        ticker: token.name || position.name,
        pairAddress: token.pairAddress || position.pairAddress,
        protocol: token.protocol || position.protocol,
        image: safeImage(token.image) || position.image,
      });
      if (knownSupply) position.supply = token.supply;
      return [filled, filled.trades.slice(before).map((fillRecord) => fillRecord.id)];
    };

    let next = account;
    let tradeIds = [];
    if (order.walletIds)
    {
      if (
        !Array.isArray(order.walletIds) ||
        order.walletIds.length !== order.walletCount ||
        new Set(order.walletIds).size !== order.walletCount ||
        order.walletIds.some((id) => !walletEntries(account).some(([known]) => id === known))
      )
      {
        throw Error("Invalid paper wallet order");
      }
      for (const walletId of order.walletIds)
      {
        const wallet = walletId === "main" ? next : next.paperWallets?.[walletId];
        if (!wallet) throw Error("Paper wallet no longer exists");
        const [filled, ids] = apply(wallet, walletId, 1);
        if (walletId === "main") next = filled;
        else next = { ...next, paperWallets: { ...next.paperWallets, [walletId]: filled } };
        tradeIds.push(...ids);
      }
    }
    else [next, tradeIds] = apply(account, "main", order.walletCount);
    next.orders = next.orders.map((item) =>
      item.id === order.id ? { ...item, status: "filled", filledAt: now, tradeIds } : item,
    );
    return next;
  }

  // starts pnl over for a period, remembering what was held at that moment
  function resetPnl(account, priced = account, now = Date.now(), period = "allTime")
  {
    if (!RESET_PERIODS.includes(period)) throw Error("Invalid PNL reset period");
    const next = structuredClone(account);
    const totals = core.portfolio(priced, priced.solUsd);
    const unrealized = Object.values(priced.positions).reduce(
      (sum, position) =>
        sum +
        (position.qty > 0 ? core.metrics(position, priced.solUsd).holding - position.basis : 0),
      0,
    );
    next.pnlResets ||= {};
    next.pnlResets[period] = {
      at: now,
      unrealizedNative: unrealized,
      solUsd:
        priced.solUsd ||
        Object.values(priced.positions).find((position) => position.solUsd > 0)?.solUsd ||
        0,
      positions: Object.fromEntries(
        Object.values(priced.positions)
          .filter((position) => position.qty > 0)
          .map((position) => [
            position.mint,
            {
              qty: position.qty,
              native: core.metrics(position, priced.solUsd).holding,
              usd: position.qty * position.usd,
            },
          ]),
      ),
    };
    if (period !== "allTime") return next;
    next.pnlResetOffset = totals.equity - next.initial;
    next.pnlResetAt = now;
    next.history.push({ at: now, pnl: 0 });
    next.history = next.history.slice(-5000);
    return next;
  }

  // cancels orders left pending for over 30 s (the page that placed them is gone)
  function cancelOrphans(account, now = Date.now())
  {
    const next = structuredClone(account);
    for (const order of next.orders)
    {
      if (order.status === "pending" && now - order.createdAt > 30000)
      {
        Object.assign(order, {
          status: "cancelled",
          cancelledAt: now,
          reason: "Execution session expired; no automatic replay",
        });
      }
    }
    return next;
  }

  // wraps the account in a backup file
  function backup(account)
  {
    return {
      format: "scanpnl-simulation",
      schemaVersion: VERSION,
      simulationOnly: true,
      exportedAt: Date.now(),
      account,
    };
  }

  // reads a backup file; refuses anything holding wallet secrets
  function restore(file, now = Date.now())
  {
    if (
      !file ||
      file.format !== "scanpnl-simulation" ||
      file.simulationOnly !== true ||
      file.schemaVersion !== VERSION
    )
    {
      throw Error("Not a supported scanpnl simulation backup");
    }
    const text = JSON.stringify(file.account);
    if (/"(?:privateKey|secretKey|seedPhrase|mnemonic|signingCredentials)"\s*:/i.test(text))
    {
      throw Error("Backup contains forbidden wallet secrets");
    }
    const account = normalize(file.account, {}, now);
    for (const order of account.orders)
    {
      if (order.status === "pending")
      {
        Object.assign(order, {
          status: "cancelled",
          cancelledAt: now,
          reason: "Cancelled on import",
        });
      }
    }
    return account;
  }

  const api = {
    walletEntries,
    selectedEntries,
    tradingView,
    createWallet,
    selectWallets,
    executionDelay,
    resetPnl,
    VERSION,
    preferenceDefaults: PREFERENCE_DEFAULTS,
    validatePreferences,
    normalize,
    view,
    begin,
    fill,
    cancelOrphans,
    backup,
    restore,
    safeUrl,
  };
  root.ScanPNLAccount = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
