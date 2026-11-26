// draws the average buy and sell price lines of the paper position on axiom's chart (runs in the page)
(() =>
{
  "use strict";

  // shows the line state on the page for diagnosis
  const status = (text) =>
  {
    try
    {
      document.documentElement.dataset.scanpnlAvgStatus = text;
    }
    catch {}
  };

  // line colors when axiom's settings have none
  const DEFAULT_COLORS = { buy: "#427a2e", sell: "#aa5139" };

  // the open token's paper trades and chart state
  let trades = [];
  let mint = "";
  let pathname = "";
  let supply = 0;
  let solUsd = 0;
  let chartMode;
  let enabled = true;
  const chartModes = new Map();
  const supplies = new Map();
  const lines = { buy: null, sell: null };
  const lineVersions = { buy: 0, sell: 0 };
  let activeChart = null;
  let drawnKey = "";

  // orders in progress: lines wait until they fill
  const pendingOrders = new Set();
  let pendingSince = 0;
  let settleUntil = 0;
  let syncTimer = 0;

  // runs sync once, 250 ms after the last change
  function scheduleSync()
  {
    try
    {
      if (syncTimer) return;
      syncTimer = setTimeout(() =>
      {
        syncTimer = 0;
        sync();
      }, 250);
    }
    catch (error)
    {
      status("schedule failed: " + error.message);
    }
  }

  // average buy and sell prices of the current position, using axiom's own calculation when available
  function averages()
  {
    const settings = window.ScanPNLNativeAverages?.read?.() || {};
    const showFees = settings.showFees === true;
    const fills = trades
      .filter((fill) => fill.mint === mint && fill.qty > 0 && fill.usd > 0)
      .map((fill, index) =>
      {
        const fee = Number(fill.fee) || 0;
        const fillSolUsd = Number(fill.solUsd) || solUsd;
        const totalSol = Number.isFinite(fill.cash)
          ? fill.cash + (fill.side === "buy" ? -fee : fee)
          : (fill.qty * fill.usd) / fillSolUsd;
        return {
          type: fill.side,
          tokenAmount: fill.qty,
          totalSol,
          totalUsd: totalSol * fillSolUsd,
          feesSol: fee,
          priceUsd: (totalSol * fillSolUsd) / fill.qty,
          priceSol: totalSol / fill.qty,
          supply: fill.supply || supply,
          makerAddress: "scanpnl",
          slot: fill.at,
          timestamp: fill.at,
          txHash: String(fill.at) + ":" + index,
          instructionIndex: index,
        };
      });
    const calculate = window.ScanPNLNativeAverages?.calculate;
    if (typeof calculate === "function")
    {
      const result = calculate(
        fills,
        chartMode?.currency === "USD" ? "USD" : "SOL",
        showFees,
        chartMode?.marketCap === true,
      );
      if (Number.isFinite(result?.averageBuyPrice) && Number.isFinite(result?.averageSellPrice))
      {
        return {
          holding:
            fills.reduce(
              (sum, fill) => sum + (fill.type === "buy" ? fill.tokenAmount : -fill.tokenAmount),
              0,
            ) > 1e-8,
          buy: result.averageBuyPrice,
          sell: result.averageSellPrice,
          native: true,
          settings,
        };
      }
    }

    // fallback: the same averages computed here; a buy after a full exit starts a new round
    let held = 0;
    let cost = 0;
    let averageBuy = 0;
    let sold = 0;
    let soldValue = 0;
    for (const fill of fills)
    {
      const fillSolUsd = fill.totalSol > 0 ? fill.totalUsd / fill.totalSol : solUsd;
      let value =
        chartMode?.currency === "USD"
          ? fill.tokenAmount * fill.priceUsd
          : fill.tokenAmount * fill.priceSol;
      if (showFees)
      {
        value =
          (chartMode?.currency === "USD" ? fill.totalUsd : fill.totalSol) +
          (fill.type === "buy" ? 1 : -1) *
            fill.feesSol *
            (chartMode?.currency === "USD" ? fillSolUsd : 1);
      }
      if (chartMode?.marketCap) value *= fill.supply;
      if (fill.type === "buy")
      {
        if (held <= 1e-8)
        {
          cost = held = sold = soldValue = 0;
        }
        held += fill.tokenAmount;
        cost += value;
        averageBuy = cost / held;
      }
      else if (held > 0)
      {
        const qty = Math.min(held, fill.tokenAmount);
        cost -= (cost / held) * qty;
        held -= qty;
        sold += qty;
        soldValue += (value * qty) / fill.tokenAmount;
        if (held <= 1e-8) held = cost = 0;
      }
    }
    return {
      holding: held > 0,
      buy: averageBuy,
      sell: sold ? soldValue / sold : 0,
      native: true,
      settings,
    };
  }

  // multiplier from a sol price per token to the chart's unit (usd or sol, price or market cap)
  function currentScale(chart)
  {
    if (!chartMode || !["USD", "SOL", "NATIVE"].includes(chartMode.currency))
    {
      status("waiting for native chart mode");
      return 0;
    }
    const currency = chartMode.currency === "USD" ? 1 : solUsd > 0 ? 1 / solUsd : 0;
    const size = chartMode.marketCap ? supply : 1;
    return Number.isFinite(size) && size > 0 ? currency * size : 0;
  }

  // the tradingview chart api of the open chart
  function findChart()
  {
    for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]'))
    {
      let api;
      try
      {
        api = frame.contentWindow.tradingViewApi;
      }
      catch
      {
        api = null;
      }
      if (!api)
      {
        status("chart frame found, but no tradingViewApi yet");
        continue;
      }
      try
      {
        const chart = typeof api.activeChart === "function" ? api.activeChart() : api;
        if (
          chart &&
          (typeof chart.createPositionLine === "function" ||
            typeof chart.createShape === "function")
        )
        {
          return chart;
        }
      }
      catch {}
      status(
        "tradingViewApi found but no line tools (keys: " +
          Object.keys(api).slice(0, 20).join(",") +
          ")",
      );
    }
    return null;
  }

  // removes the buy or sell line
  function remove(side)
  {
    try
    {
      ++lineVersions[side];
      const line = lines[side];
      lines[side] = null;
      if (!line) return;
      try
      {
        line.line ? line.line.remove() : line.chart.removeEntity(line.id);
      }
      catch {}
    }
    catch (error)
    {
      status("remove failed: " + error.message);
    }
  }

  // draws or moves one line, styled like axiom's own (2 px, large dashes, 12 px label); the label sits
  // above ("top") or below ("bottom") the line so buy and sell labels never overlap
  function draw(chart, side, price, label, color, align = "bottom")
  {
    try
    {
      if (!(Number.isFinite(price) && price > 0)) return false;
      const current = lines[side];
      if (
        current &&
        current.chart === chart &&
        current.color === color &&
        current.align === align &&
        Math.abs(current.price / price - 1) < 1e-9
      )
      {
        return true;
      }
      remove(side);
      if (typeof chart.createShape === "function")
      {
        try
        {
          const version = lineVersions[side];
          const created = chart.createShape(
            { time: Math.floor(Date.now() / 1000), price },
            {
              shape: "horizontal_line",
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              text: label,
              overrides: {
                linecolor: color,
                textcolor: color,
                linestyle: 3,
                linewidth: 2,
                showLabel: true,
                showPrice: true,
                horzLabelsAlign: "right",
                vertLabelsAlign: align,
                fontsize: 12,
                bold: false,
                italic: false,
              },
            },
          );
          Promise.resolve(created)
            .then((id) =>
            {
              try
              {
                // a newer draw or another chart replaced this one while it was created
                if (version !== lineVersions[side] || chart !== activeChart)
                {
                  chart.removeEntity(id);
                  return;
                }
                lines[side] = { id, chart, price, color, align, shape: true };
              }
              catch (error)
              {
                status("horizontal line resolve failed: " + error.message);
              }
            })
            .catch((error) =>
            {
              drawnKey = "";
              status("horizontal line failed: " + error.message);
            });
          return true;
        }
        catch (error)
        {
          status("horizontal line failed: " + error.message);
        }
      }
      if (typeof chart.createPositionLine === "function")
      {
        try
        {
          const line = chart.createPositionLine({ disableUndo: true });
          lines[side] = { line, chart, price, color, align };
          line
            .setText(label)
            .setPrice(price)
            .setQuantity("")
            .setLineColor(color)
            .setLineStyle(3)
            .setLineWidth(2)
            .setLineLength(100)
            .setBodyBorderColor(color)
            .setBodyTextColor(color)
            .setBodyBackgroundColor("#00000000")
            .setQuantityBorderColor(color)
            .setQuantityBackgroundColor("#00000000")
            .setQuantityTextColor(color);
          return true;
        }
        catch (error)
        {
          remove(side);
          status("position line failed: " + error.message);
        }
      }
    }
    catch (error)
    {
      status("draw failed: " + error.message);
    }
    return false;
  }

  // runs the line update, reporting any failure
  function sync()
  {
    try
    {
      run();
    }
    catch (error)
    {
      status("error: " + error.message);
    }
  }

  // brings the lines in line with the paper position
  function run()
  {
    if (!enabled) return;
    // left the token page: clear everything
    if (pathname && location.pathname !== pathname)
    {
      remove("buy");
      remove("sell");
      mint = "";
      pathname = "";
      supply = 0;
      drawnKey = "";
      pendingOrders.clear();
      settleUntil = 0;
      status("left token, lines cleared");
      return;
    }

    // wait while an order is filling (at most 10 s)
    if (pendingOrders.size && Date.now() - pendingSince < 10000) return;
    if (Date.now() < settleUntil) return;
    if (!mint) return;
    const chart = findChart();
    if (!chart) return;
    if (activeChart !== chart)
    {
      remove("buy");
      remove("sell");
      activeChart = chart;
      drawnKey = "";
    }
    if (!chartMode) return;
    const average = averages();
    const scale = average.native ? 1 : currentScale(chart);
    if (!average.buy)
    {
      remove("buy");
      remove("sell");
      drawnKey = "";
      status("no round yet");
      return;
    }
    if (!(scale > 0))
    {
      remove("buy");
      remove("sell");
      drawnKey = "";
      status("waiting for native chart mode, currency or supply");
      return;
    }
    const buyColor = average.settings?.averageBuyLineColor || DEFAULT_COLORS.buy;
    const sellColor = average.settings?.averageSellLineColor || DEFAULT_COLORS.sell;
    const key = [mint, average.buy, average.sell, scale, buyColor, sellColor].join("|");
    if (key === drawnKey) return;
    // the higher line's label sits above it, the lower one's below
    const buyHigh = !(average.sell > 0) || average.buy >= average.sell;
    const buyDrawn = draw(
      chart,
      "buy",
      average.buy * scale,
      "Current Average Cost Basis",
      buyColor,
      average.sell > 0 && buyHigh ? "top" : "bottom",
    );
    const sellDrawn =
      average.sell > 0
        ? draw(
          chart,
          "sell",
          average.sell * scale,
          "Current Average Exit Price",
          sellColor,
          buyHigh ? "bottom" : "top",
        )
        : (remove("sell"), true);
    if (!buyDrawn || !sellDrawn) return;
    drawnKey = key;
    status(
      (average.holding ? "open" : "closed, averages retained") +
        ": buy=" +
        average.buy * scale +
        " sell=" +
        average.sell * scale +
        " supply=" +
        scale,
    );
  }

  // paper mode, chart mode, order progress, paper trades and quotes from the other scripts
  window.addEventListener("message", (event) =>
  {
    try
    {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.type === "scanpnl-mode-v2")
      {
        enabled = data.enabled !== false;
        if (!enabled)
        {
          remove("buy");
          remove("sell");
          drawnKey = "";
        }
        return;
      }
      if (data?.type === "scanpnl-chart-mode-v1")
      {
        const mode = { currency: data.currency, marketCap: data.marketCap === true };
        chartModes.set(data.mint, mode);
        if (data.mint === mint)
        {
          chartMode = mode;
          scheduleSync();
        }
        return;
      }
      if (data?.type === "scanpnl-transaction-v1" && typeof data.id === "string")
      {
        if (data.phase === "loading")
        {
          pendingOrders.add(data.id);
          pendingSince = Date.now();
        }
        else if (data.phase === "confirmed" || data.phase === "error")
        {
          pendingOrders.delete(data.id);
          settleUntil = Date.now() + 200;
          scheduleSync();
        }
        return;
      }
      if (
        data &&
        data.type === "scanpnl-chart-trades-v1" &&
        Array.isArray(data.trades) &&
        typeof data.mint === "string"
      )
      {
        if (data.route && data.route !== location.pathname.split("/")[2]) return;
        if (mint !== data.mint)
        {
          remove("buy");
          remove("sell");
          supply = supplies.get(data.mint) || 0;
          chartMode = chartModes.get(data.mint);
        }
        if (Number.isFinite(data.solUsd) && data.solUsd > 0) solUsd = data.solUsd;
        trades = data.trades;
        mint = data.mint;
        pathname = location.pathname;
        if (Number.isFinite(data.supply) && data.supply > 0)
        {
          supply = data.supply;
          supplies.set(mint, supply);
        }
        scheduleSync();
      }
      if (
        data &&
        data.type === "scanpnl-quote-v1" &&
        data.quote &&
        typeof data.quote.mint === "string"
      )
      {
        if (
          data.quote.mint === mint &&
          Number.isFinite(data.quote.solUsd) &&
          data.quote.solUsd > 0 &&
          solUsd !== data.quote.solUsd
        )
        {
          solUsd = data.quote.solUsd;
          scheduleSync();
        }
        const quoteSupply = Number(data.quote.supply) || 0;
        if (quoteSupply > 0) supplies.set(data.quote.mint, quoteSupply);
        if (data.quote.mint === mint && quoteSupply > 0 && supply !== quoteSupply)
        {
          supply = quoteSupply;
          scheduleSync();
        }
      }
    }
    catch (error)
    {
      status("message failed: " + error.message);
    }
  });

  // re-checks the lines every second
  try
  {
    setInterval(sync, 1000);
  }
  catch (error)
  {
    status("timer failed: " + error.message);
  }
})();
