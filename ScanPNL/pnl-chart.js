// pnl curves for the pnl tracker: total, realized and cash flow
(function (root)
{
  "use strict";

  // last computed summary, reused until the trades change
  let cached;

  // total, realized and cash-flow pnl since the last all-time reset, with their curves
  function summary(account, solUsd)
  {
    const total = ScanPNLCore.portfolio(account, solUsd).pnl;
    const reset = account.pnlResets?.allTime;
    const last = account.trades.at(-1);
    const key = JSON.stringify([
      account.accountId,
      account.updatedAt,
      account.trades.length,
      last?.id,
      last?.at,
      last?.cash,
      last?.qty,
      reset?.at,
      account.pnlResetAt,
    ]);
    if (cached?.key === key)
    {
      return {
        total,
        realized: cached.realized,
        unrealized: total - cached.realized,
        curve: cached.curve,
        flow: cached.flow,
        flowCurve: cached.flowCurve,
      };
    }

    // cost basis per token, starting from what was held at the reset
    const holdings = new Map(
      Object.entries(reset?.positions || {}).map(([mint, held]) => [
        mint,
        { qty: held.qty, cost: held.native },
      ]),
    );
    let realized = 0;
    let flow = 0;
    const curve = [];
    const flowCurve = [];
    for (const fill of [...account.trades].sort((a, b) => a.at - b.at))
    {
      if (reset && fill.at <= reset.at) continue;
      // cash flow: a buy takes its sol (fees included) off as it fills, a sell adds its proceeds
      flow += fill.side === "buy" ? -fill.cash : fill.cash;
      flowCurve.push({ at: fill.at, pnl: flow });
      const holding = holdings.get(fill.mint) || { qty: 0, cost: 0 };
      if (fill.side === "buy")
      {
        holding.qty += fill.qty;
        holding.cost += fill.cash;
      }
      else
      {
        const cost =
          holding.qty > 0
            ? holding.cost * Math.min(1, fill.qty / holding.qty)
            : Number(fill.releasedBasis) || 0;
        realized += fill.cash - cost;
        holding.qty = Math.max(0, holding.qty - fill.qty);
        holding.cost = Math.max(0, holding.cost - cost);
      }
      holdings.set(fill.mint, holding);
      curve.push({ at: fill.at, pnl: realized });
    }

    // accounts reset before period resets existed: measure from that reset
    if (!reset && account.pnlResetAt)
    {
      const atReset = curve.filter((point) => point.at <= account.pnlResetAt).at(-1)?.pnl || 0;
      realized -= atReset;
      for (const point of curve) point.pnl -= atReset;
      const flowAtReset =
        flowCurve.filter((point) => point.at <= account.pnlResetAt).at(-1)?.pnl || 0;
      flow -= flowAtReset;
      for (const point of flowCurve) point.pnl -= flowAtReset;
    }
    cached = { key, realized, curve, flow, flowCurve };
    return { total, realized, unrealized: total - realized, curve, flow, flowCurve };
  }

  // the value and chart points for one mode: total, realized, unrealized or flow
  function series(account, solUsd, mode = "total", now = Date.now())
  {
    if (mode === "unrealized") mode = "total";
    const totals = summary(account, solUsd);
    const since = account.pnlResets?.allTime?.at || account.pnlResetAt || 0;
    let points;
    if (mode === "realized" || mode === "flow")
    {
      points = (mode === "flow" ? totals.flowCurve : totals.curve).filter(
        (point) => point.at >= since,
      );
    }
    else
    {
      // total: the sampled history, each point paired with the realized pnl at its time
      let index = 0;
      let realizedAt = 0;
      points = (account.history || [])
        .filter((point) => point.at >= since)
        .map((point) =>
        {
          while (index < totals.curve.length && totals.curve[index].at <= point.at)
          {
            realizedAt = totals.curve[index++].pnl;
          }
          return { at: point.at, pnl: mode === "unrealized" ? point.pnl - realizedAt : point.pnl };
        });
    }
    const value = totals[mode] ?? totals.total;
    return {
      value,
      points: [...(since ? [{ at: since, pnl: 0 }] : []), ...points, { at: now, pnl: value }],
    };
  }

  root.ScanPNLPnlChart = { series };
  if (typeof module !== "undefined") module.exports = root.ScanPNLPnlChart;
})(globalThis);
