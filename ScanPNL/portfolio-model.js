// builds the data axiom's portfolio page shows, from the paper account
(function (root)
{
  "use strict";

  // portfolio periods and their length in ms
  const PERIODS = {
    oneDay: 86400000,
    sevenDay: 7 * 86400000,
    thirtyDay: 30 * 86400000,
    allTime: Infinity,
  };
  const HOLD_TIME_LIMITS = [60000, 600000, 3600000, 86400000, 604800000, Infinity];
  const SIZE_LIMITS = [0.1, 0.5, 1, 5, 20, Infinity];

  // a position across paper wallets: wallet id + mint, or just the mint for the main wallet
  const positionKey = (fill) =>
    fill.walletId && fill.walletId !== "main" ? fill.walletId + ":" + fill.mint : fill.mint;

  // sum of a value over rows
  const total = (rows, value) => rows.reduce((sum, row) => sum + value(row), 0);

  // median of numbers, or null when there are none
  function median(values)
  {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // an empty calendar day
  const calendarDay = (time) => ({
    time,
    usd: 0,
    native: 0,
    nativeToken: "sol",
    closedPositions: 0,
    buyCount: 0,
    sellCount: 0,
    volumeBuyNative: 0,
    volumeBuyUsd: 0,
    volumeSellNative: 0,
    volumeSellUsd: 0,
    transferFundedUsd: 0,
    transferFundedCloses: 0,
  });

  // account equity, value held in tokens and unrealized pnl
  function totals(account, solUsd)
  {
    const unrealized = Object.values(account.positions).reduce(
      (sum, position) =>
        sum +
        (position.qty > 0 ? ScanPNLCore.metrics(position, solUsd).holding - position.basis : 0),
      0,
    );
    return { ...ScanPNLCore.portfolio(account, solUsd), unrealized };
  }

  // stats over closed positions (bought and fully sold) closed at or after `since`
  function edgeInsights(rows, startPositions = {}, since = -Infinity)
  {
    const open = new Map(
      Object.entries(startPositions).map(([key, held]) => [
        key,
        {
          qty: held.qty,
          peakQty: held.qty,
          cost: held.native || 0,
          costUsd: held.usd || 0,
          pnlUsd: 0,
          pnl: 0,
          buys: 0,
          sells: 0,
          opened: null,
        },
      ]),
    );
    const closed = [];
    for (const fill of [...rows].sort((a, b) => a.at - b.at))
    {
      const key = positionKey(fill);
      const position = open.get(key) || {
        qty: 0,
        peakQty: 0,
        cost: 0,
        costUsd: 0,
        pnl: 0,
        pnlUsd: 0,
        buys: 0,
        sells: 0,
        opened: fill.at,
      };

      // fills of one multi-wallet order count as one buy or one sell
      if (fill.side === "buy")
      {
        position.qty += fill.qty;
        position.peakQty = Math.max(position.peakQty, position.qty);
        position.cost += fill.cash;
        position.costUsd += fill.cash * (fill.solUsd || 0);
        if (!fill.batchId || position.lastBuyBatch !== fill.batchId) position.buys++;
        position.lastBuyBatch = fill.batchId;
        position.opened ??= fill.at;
      }
      else
      {
        position.qty = Math.max(0, position.qty - fill.qty);
        position.pnl += fill.pnl;
        position.pnlUsd += fill.pnlUsd || 0;
        if (!fill.batchId || position.lastSellBatch !== fill.batchId) position.sells++;
        position.lastSellBatch = fill.batchId;
      }
      if (position.qty <= Math.max(1e-12, position.peakQty * 1e-12) && position.sells)
      {
        if (position.cost > 0 && fill.at >= since)
        {
          closed.push({
            ...position,
            at: fill.at,
            pct: (position.pnl / position.cost) * 100,
            hold: position.opened == null ? null : fill.at - position.opened,
          });
        }
        open.delete(key);
      }
      else open.set(key, position);
    }
    const wins = closed.filter((trade) => trade.pnl > 0);
    const losses = closed.filter((trade) => trade.pnl < 0);

    // count, wins, pnl and medians for a group of closed positions
    const bucket = (group) => ({
      count: group.length,
      wins: group.filter((trade) => trade.pnl > 0).length,
      totalPnlNative: total(group, (trade) => trade.pnl),
      medianPnlPct: median(group.map((trade) => trade.pct)),
      medianHoldMs: median(group.map((trade) => trade.hold).filter((hold) => hold != null)),
    });

    // buckets by a field against ascending upper limits
    const groupBy = (limits, field) =>
      limits.map((limit, index) =>
        bucket(
          closed.filter(
            (trade) =>
              trade[field] != null &&
              trade[field] >= (index ? limits[index - 1] : 0) &&
              trade[field] < limit,
          ),
        ),
      );

    // win and loss streaks, and how many times the result flipped
    let winStreak = 0;
    let lossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let runs = 0;
    let lastSign;
    for (const trade of closed)
    {
      const sign = Math.sign(trade.pnl);
      if (sign !== lastSign)
      {
        runs++;
        lastSign = sign;
      }
      winStreak = sign > 0 ? winStreak + 1 : 0;
      lossStreak = sign < 0 ? lossStreak + 1 : 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }

    // worst 5% of results (value at risk) and the average size
    const pcts = closed.map((trade) => trade.pct).sort((a, b) => a - b);
    const worst = pcts.slice(0, Math.max(1, Math.ceil(pcts.length * 0.05)));
    const averageCost = closed.length ? total(closed, (trade) => trade.cost) / closed.length : 0;
    return {
      closedCount: closed.length,
      closedNativePnl: total(closed, (trade) => trade.pnl),
      closedUsdPnl: total(closed, (trade) => trade.pnlUsd),
      closedNativeCost: total(closed, (trade) => trade.cost),
      closedUsdCost: total(closed, (trade) => trade.costUsd),
      winCount: wins.length,
      lossCount: losses.length,
      sumWinsNative: total(wins, (trade) => trade.pnl),
      sumLossesNative: total(losses, (trade) => trade.pnl),
      medianWinPnlPct: median(wins.map((trade) => trade.pct)),
      medianLossPnlPct: median(losses.map((trade) => trade.pct)),
      var95PnlPct: worst.at(-1) ?? null,
      cvar95PnlPct: worst.length ? worst.reduce((sum, pct) => sum + pct, 0) / worst.length : null,
      holdTimeBuckets: groupBy(HOLD_TIME_LIMITS, "hold"),
      sizeBuckets: groupBy(SIZE_LIMITS, "cost"),
      singleBuy: bucket(closed.filter((trade) => trade.buys === 1)),
      multiBuy: bucket(closed.filter((trade) => trade.buys > 1)),
      sizingStddevNative: closed.length
        ? Math.sqrt(total(closed, (trade) => (trade.cost - averageCost) ** 2) / closed.length)
        : 0,
      maxWinStreak,
      maxLossStreak,
      runsCount: runs,
      ladderExitCount: closed.filter((trade) => trade.sells > 1).length,
      singleSellExitCount: closed.filter((trade) => trade.sells === 1).length,
    };
  }

  // everything axiom's portfolio page reads, for the selected period
  function nativeBundle(account, solUsd, now = Date.now(), period = "allTime")
  {
    const summary = totals(account, solUsd);

    // every trade with its cost basis and realized pnl, in time order
    const held = new Map();
    const rows = [];
    for (const fill of [...account.trades].sort((a, b) => a.at - b.at))
    {
      const key = positionKey(fill);
      const position = held.get(key) || { qty: 0, native: 0, usd: 0 };
      let cost = 0;
      let costUsd = 0;
      let pnl = 0;
      let pnlUsd = 0;
      if (fill.side === "buy")
      {
        position.qty += fill.qty;
        position.native += fill.cash;
        position.usd += fill.cash * fill.solUsd;
      }
      else
      {
        const share = position.qty > 0 ? Math.min(1, fill.qty / position.qty) : 0;
        cost = Number.isFinite(fill.releasedBasis) ? fill.releasedBasis : position.native * share;
        costUsd = position.usd * share;
        pnl = fill.cash - cost;
        pnlUsd = fill.cash * fill.solUsd - costUsd;
        position.qty = Math.max(0, position.qty - fill.qty);
        position.native = Math.max(0, position.native - cost);
        position.usd = Math.max(0, position.usd - costUsd);
      }
      held.set(key, position);
      rows.push({ ...fill, cost, costUsd, pnl, pnlUsd });
    }

    // the reset that applies to a period: the newest of all-time and that period's own
    function resetFor(name)
    {
      const resets = [account.pnlResets?.allTime, account.pnlResets?.[name]].filter(Boolean);
      if (!resets.length && account.pnlResetAt) resets.push({ at: account.pnlResetAt });
      return resets.sort((a, b) => b.at - a.at)[0];
    }

    // trades after a reset, with costs measured from what was held at the reset
    function project(reset)
    {
      if (!reset) return { rows, unrealized: summary.unrealized };
      if (!reset.positions)
      {
        return {
          rows: rows.filter((row) => row.at > reset.at),
          unrealized: summary.unrealized - (reset.unrealizedNative || 0),
        };
      }
      const positions = new Map(
        Object.entries(reset.positions).map(([key, position]) => [key, { ...position }]),
      );
      const projected = [];
      for (const row of rows.filter((item) => item.at > reset.at))
      {
        const key = positionKey(row);
        const position = positions.get(key) || { qty: 0, native: 0, usd: 0 };
        let cost = 0;
        let costUsd = 0;
        if (row.side === "buy")
        {
          position.qty += row.qty;
          position.native += row.cash;
          position.usd += row.cash * row.solUsd;
        }
        else
        {
          const share = position.qty ? Math.min(1, row.qty / position.qty) : 0;
          cost = position.native * share;
          costUsd = position.usd * share;
          position.qty = Math.max(0, position.qty - row.qty);
          position.native -= cost;
          position.usd -= costUsd;
        }
        positions.set(key, position);
        projected.push({
          ...row,
          cost,
          costUsd,
          pnl: row.side === "sell" ? row.cash - cost : 0,
          pnlUsd: row.side === "sell" ? row.cash * row.solUsd - costUsd : 0,
        });
      }
      return {
        rows: projected,
        unrealized:
          summary.holding -
          [...positions.values()].reduce((sum, position) => sum + position.native, 0),
      };
    }

    // calendar: one entry per day since the newest reset of any kind
    const latestReset = [
      ...Object.values(account.pnlResets || {}),
      ...(account.pnlResetAt ? [{ at: account.pnlResetAt }] : []),
    ].sort((a, b) => b.at - a.at || Number(!!b.positions) - Number(!!a.positions))[0];
    const calendarView = project(latestReset);
    const calendar = new Map();
    const heldAtReset = new Map(
      Object.entries(latestReset?.positions || {}).map(([key, position]) => [key, position.qty]),
    );
    for (const row of calendarView.rows)
    {
      const date = new Date(row.at);
      const time = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
      const day = calendar.get(time) || calendarDay(time);
      day.usd += row.pnlUsd;
      day.native += row.pnl;
      day[row.side === "buy" ? "buyCount" : "sellCount"]++;
      day[row.side === "buy" ? "volumeBuyNative" : "volumeSellNative"] += row.cash;
      day[row.side === "buy" ? "volumeBuyUsd" : "volumeSellUsd"] += row.cash * row.solUsd;
      const qty = Math.max(
        0,
        (heldAtReset.get(row.mint) || 0) + (row.side === "buy" ? row.qty : -row.qty),
      );
      heldAtReset.set(row.mint, qty);
      if (row.side === "sell" && qty === 0) day.closedPositions++;
      calendar.set(time, day);
    }

    // starting capital for the calendar's percent view
    const cashBeforeRows =
      account.balance -
      calendarView.rows.reduce((sum, row) => sum + (row.side === "buy" ? -row.cash : row.cash), 0);
    const startingCapital = latestReset?.positions
      ? cashBeforeRows +
        Object.values(latestReset.positions).reduce((sum, position) => sum + position.native, 0)
      : account.initial;
    const selectedView = project(resetFor(period));

    // performance and pnl chart per period
    const views = {};
    const performance = {};
    const charts = {};
    for (const [name, length] of Object.entries(PERIODS))
    {
      const reset = resetFor(name);
      const view = project(reset);
      views[name] = { reset, view };
      const inPeriod = view.rows.filter((row) => now - row.at <= length);
      const buys = inPeriod.filter((row) => row.side === "buy");
      const sells = inPeriod.filter((row) => row.side === "sell");
      const breakdown = {
        over500Percent: 0,
        between200And500Percent: 0,
        between0And200Percent: 0,
        between0AndNeg50Percent: 0,
        underNeg50Percent: 0,
      };
      for (const sell of sells)
      {
        const pct = sell.cost ? (sell.pnl / sell.cost) * 100 : 0;
        breakdown[
          pct > 500
            ? "over500Percent"
            : pct > 200
              ? "between200And500Percent"
              : pct >= 0
                ? "between0And200Percent"
                : pct >= -50
                  ? "between0AndNeg50Percent"
                  : "underNeg50Percent"
        ]++;
      }
      performance[name] = {
        totalPnl: total(sells, (row) => row.pnl) + view.unrealized,
        buyCount: buys.length,
        sellCount: sells.length,
        pnlBreakdown: breakdown,
        usdSold: total(sells, (row) => row.cash * row.solUsd),
        usdBought: total(buys, (row) => row.cash * row.solUsd),
        nativeSold: total(sells, (row) => row.cash),
        nativeBought: total(buys, (row) => row.cash),
        nativeToken: "sol",
        realizedNativeBought: total(sells, (row) => row.cost),
        realizedNativePnl: total(sells, (row) => row.pnl),
        realizedNativeSold: total(sells, (row) => row.cash),
        realizedUsdBought: total(sells, (row) => row.costUsd),
        realizedUsdPnl: total(sells, (row) => row.pnlUsd),
        realizedUsdSold: total(sells, (row) => row.cash * row.solUsd),
        transferFundedUsd: 0,
        transferFundedCloses: 0,
      };

      // cumulative usd pnl, one point per second, starting at zero from the reset
      let running = 0;
      const points = view.rows.map((row) => ({
        time: Math.floor(row.at / 1000),
        value: (running += row.pnlUsd),
      }));
      const recent = points.filter((point) => now - point.time * 1000 <= length);
      charts[name] = [...new Map(recent.map((point) => [point.time, point])).values()];
      if (reset)
      {
        const start = Math.floor(
          Math.max(reset.at, Number.isFinite(length) ? now - length : reset.at) / 1000,
        );
        charts[name].unshift({ time: start, value: 0 });
        charts[name] = [...new Map(charts[name].map((point) => [point.time, point])).values()];
        if (charts[name].length === 1)
        {
          charts[name].push({ time: Math.max(start + 1, Math.floor(now / 1000)), value: 0 });
        }
      }
    }

    // closed-position stats per period
    const insights = {};
    const edgePerformance = {};
    for (const [name, length] of Object.entries(PERIODS))
    {
      const { reset, view } = views[name];
      const stats = edgeInsights(view.rows, reset?.positions, now - length);
      insights[name] = stats;
      edgePerformance[name] = {
        ...performance[name],
        sellCount: stats.closedCount,
        buyCount: stats.closedCount,
        realizedNativePnl: stats.closedNativePnl,
        realizedUsdPnl: stats.closedUsdPnl,
        realizedNativeBought: stats.closedNativeCost,
        realizedUsdBought: stats.closedUsdCost,
        realizedNativeSold: stats.closedNativeCost + stats.closedNativePnl,
        realizedUsdSold: stats.closedUsdCost + stats.closedUsdPnl,
      };
    }
    const paperInsights = {
      ...(insights[period] || insights.allTime),
      exitStyles: Object.fromEntries(
        Object.entries(insights).map(([name, stats]) => [
          name,
          {
            closedCount: stats.closedCount,
            singleSellExitCount: stats.singleSellExitCount,
            ladderExitCount: stats.ladderExitCount,
          },
        ]),
      ),
    };

    // the all-time chart always has a starting point
    const allTimeChart = charts.allTime;
    if (!allTimeChart.length)
    {
      allTimeChart.push(
        { time: Math.floor(now / 1000) - 1, value: 0 },
        { time: Math.floor(now / 1000), value: 0 },
      );
    }
    else allTimeChart.unshift({ time: allTimeChart[0].time - 1, value: 0 });

    // one row per token, in axiom's position format
    const positions = Object.values(account.positions).map((position) =>
    {
      const fills = rows.filter((row) => row.mint === position.mint);
      const buys = fills.filter((row) => row.side === "buy");
      const sells = fills.filter((row) => row.side === "sell");
      return {
        tokenAddress: position.mint,
        pairAddress: position.pairAddress || position.mint,
        tokenTicker: position.ticker || position.name,
        tokenName: position.name,
        tokenImage: position.image || "",
        tokenDecimals: 0,
        protocol: position.protocol || "",
        displayProtocol: position.protocol || "",
        nativeToken: "sol",
        tokensBought: total(buys, (row) => row.qty),
        tokensSold: total(sells, (row) => row.qty),
        nativeSpent: position.bought,
        nativeReceived: position.sold,
        usdSpent: total(buys, (row) => row.cash * row.solUsd),
        usdReceived: total(sells, (row) => row.cash * row.solUsd),
        remainingTokens: position.qty,
        buyCount: buys.length,
        sellCount: sells.length,
        createdAt: new Date(fills[0]?.at || position.at || now),
        updatedAt: new Date(fills.at(-1)?.at || position.at || now),
        pairCreatedAt: new Date(fills[0]?.at || position.at || now),
        priceNative: position.usd / (solUsd || position.solUsd),
        liquidityNative: 0,
        liquidityToken: 0,
        protocolDetails: undefined,
        extra: {},
        closedUnheld: false,
      };
    });

    // trade history, newest first, in axiom's transaction format
    const transactions = rows
      .slice()
      .reverse()
      .map((row) =>
      {
        const position = account.positions[row.mint] || {};
        return {
          makerAddress: "",
          pairAddress: row.mint,
          tokenAddress: row.mint,
          signature: "",
          marketCapNative: position.supply ? (row.usd / row.solUsd) * position.supply : 0,
          marketCapUsd: position.supply ? row.usd * position.supply : 0,
          totalNative: row.cash,
          totalUsd: row.cash * row.solUsd,
          liquidityNative: 0,
          liquidityToken: 0,
          nativeToken: "sol",
          type: row.side,
          supply: position.supply || 0,
          createdAt: new Date(row.at),
          tokenTicker: position.ticker || position.name || "",
          tokenName: position.name || "",
          tokenImage: position.image || "",
          tokenDecimals: 0,
          protocol: position.protocol || "",
          displayProtocol: position.protocol || "",
          extra: {},
          pairCreatedAt: new Date(row.at),
        };
      });

    const loaded = (data) => ({ data, loading: false });
    return {
      calendarCapital: {
        initial: startingCapital,
        rate: solUsd,
        records: calendarView.rows.map((row) => ({
          at: row.at,
          pnl: row.pnl,
          pnlUsd: row.pnlUsd,
          solUsd: row.solUsd,
          side: row.side,
        })),
      },
      paperInsights,
      edgePerformance,
      balance: loaded({
        totalValueNative: summary.equity,
        availableBalanceNative: account.balance,
        unrealizedPnlNative: selectedView.unrealized,
        heldTokenTotals: new Map(),
        nativeToken: "sol",
        stableBalance: new Map(),
      }),
      performance: loaded(performance),
      chart: { data: allTimeChart, periods: charts, loading: false },
      calendar: loaded([...calendar.values()].sort((a, b) => a.time - b.time)),
      activePositions: loaded(positions.filter((position) => position.remainingTokens > 0)),
      historical: loaded(positions),
      topHistorical: loaded(positions),
      devTokens: loaded([]),
      transactions: { data: transactions, loading: false, delayed: false },
      walletFunding: loaded([]),
      insights: loaded(undefined),
    };
  }

  root.ScanPNLPortfolio = { nativeBundle };
  if (typeof module !== "undefined") module.exports = root.ScanPNLPortfolio;
})(globalThis);
