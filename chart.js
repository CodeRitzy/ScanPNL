// adds paper buy and sell marks to axiom's tradingview chart (runs in the page)
(() =>
{
  "use strict";

  // chart marks for the trades of a mint inside [from, to], at most 10 per bar
  function makeMarkers(trades, mint, from, to, resolution, style)
  {
    if (!style) return [];
    const text = String(resolution || "1S");
    const seconds = text.endsWith("S")
      ? parseInt(text)
      : text === "D" || text === "1D"
        ? 86400
        : text === "W" || text === "1W"
          ? 604800
          : Number(text) * 60;
    if (!(seconds > 0)) return [];
    const perBar = new Map();
    return trades.flatMap((fill, index) =>
    {
      const time = Math.floor(fill.at / 1000 / seconds) * seconds;
      if (fill.mint !== mint || time < from || time > to || (perBar.get(time) || 0) >= 10)
      {
        return [];
      }
      perBar.set(time, (perBar.get(time) || 0) + 1);
      const buy = fill.side === "buy";
      return [
        {
          id: `scanpnl-mark-${fill.at}-${index}`,
          time,
          color: {
            border: buy ? style.buyBorder : style.sellBorder,
            background: buy ? style.buyColor : style.sellColor,
          },
          label: buy ? "B" : "S",
          labelFontColor: "white",
          minSize: style.size,
          text: `You ${buy ? "bought" : "sold"} ${Number(fill.cash).toFixed(4)} SOL`,
        },
      ];
    });
  }

  if (typeof module !== "undefined") module.exports = { markers: makeMarkers };
  if (typeof window === "undefined") return;

  // latest trades from the content script, and chart state
  let chart = { trades: [], mint: "", route: "" };
  let chartKey = "";
  let markerStyle;
  let enabled = true;
  const originalGetMarks = new WeakMap();

  // listens for paper mode, axiom's marker style and the paper trades of the open token
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.type === "scanpnl-mode-v2")
    {
      const on = data.enabled !== false;
      if (on !== enabled)
      {
        enabled = on;
        connect(true);
      }
      return;
    }
    if (data?.type === "scanpnl-marker-style-v1")
    {
      markerStyle = data.style;
      connect(true);
      return;
    }
    if (data?.type !== "scanpnl-chart-trades-v1") return;
    if (
      !Array.isArray(data.trades) ||
      data.trades.length > 50000 ||
      typeof data.mint !== "string"
    )
    {
      return;
    }
    chart = data;
    const key = JSON.stringify([data.mint, data.route, data.trades.length, data.trades.at(-1)?.at]);
    if (key !== chartKey)
    {
      chartKey = key;
      connect(true);
    }
  });

  // wraps each chart's getMarks once so paper marks are added to axiom's; refreshes on change
  function connect(refresh)
  {
    for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]'))
    {
      try
      {
        const datafeed = window[frame.id]?.datafeed;
        if (!datafeed || typeof datafeed.getMarks !== "function") continue;
        let wrapped = false;
        if (!originalGetMarks.has(datafeed))
        {
          const getMarks = datafeed.getMarks;
          originalGetMarks.set(datafeed, getMarks);
          wrapped = true;
          datafeed.getMarks = function (symbol, from, to, callback, resolution)
          {
            return getMarks.call(
              this,
              symbol,
              from,
              to,
              (marks) =>
              {
                const ticker = String(symbol.ticker || symbol.name || "").toLowerCase();
                const sameToken = [chart.mint, chart.route].some(
                  (id) => id && ticker.includes(id.toLowerCase()),
                );
                const paper =
                  enabled && sameToken
                    ? makeMarkers(chart.trades, chart.mint, from, to, resolution, markerStyle)
                    : [];
                frame.dataset.scanpnlMarkerCount = String(paper.length);
                callback([...paper, ...(marks || [])]);
              },
              resolution,
            );
          };
        }
        if (refresh || wrapped) frame.contentWindow.chartWidget?.refreshMarks();
      }
      catch {}
    }
  }

  // charts load late and reload on navigation, so keep checking
  setInterval(() => connect(false), 750);
})();
