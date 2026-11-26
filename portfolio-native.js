// shows the paper account on axiom's portfolio page by placing it in axiom's own portfolio store (runs in the page)
(() =>
{
  "use strict";

  // paper portfolio state from the content script
  let enabled = false;
  let bundle;
  let connecting;
  let binding;
  let nativeState;
  let nativeOriginal;
  let writing = false;
  let unsubscribePortfolio;
  let revision;
  let lastApplied;
  const modules = new Map();
  const unifiedAtoms = [];
  let rewards;
  let unsubscribeRewards;
  let shareRank;
  const replayedClicks = new WeakSet();

  // shows the chosen share-card rank (or the cached one) through axiom's rewards atom
  function syncRewards()
  {
    if (!enabled || !binding || !rewards) return;
    const { atom } = rewards;
    if (Number.isInteger(shareRank) && shareRank >= 1 && shareRank <= 8)
    {
      const current = binding.store.get(atom);
      if (current === rewards.seeded && current?.rewardsLevel === shareRank) return;
      if (!rewards.seeded) rewards.original = current;
      const seeded = { ...current, rewardsLevel: shareRank, isVip: shareRank === 8 };
      rewards.seeded = seeded;
      binding.store.set(atom, seeded);
      return;
    }
    if (rewards.seeded && binding.store.get(atom) === rewards.seeded)
    {
      binding.store.set(atom, rewards.original);
      rewards.seeded = undefined;
    }
    if (binding.store.get(atom) != null) return;
    try
    {
      const level = JSON.parse(localStorage.getItem("cached-rewards-level-sol"));
      if (!Number.isInteger(level) || level < 0 || level > 8) return;
      const seeded = { rewardsLevel: level };
      rewards.original = null;
      rewards.seeded = seeded;
      binding.store.set(atom, seeded);
    }
    catch {}
  }

  // binds to axiom's portfolio module: its store, its portfolio atoms and the rewards atom
  async function connect()
  {
    const moduleUrl = [...performance.getEntriesByType("resource")]
      .map((entry) => entry.name)
      .find(
        (url) => url.startsWith(location.origin + "/assets/portfolio-") && /\.js(?:\?|$)/.test(url),
      );
    if (!moduleUrl) throw Error("Portfolio module not loaded");
    const code = await (await fetch(moduleUrl, { cache: "force-cache" })).text();
    const imports = window.ScanPNLNativeRuntime.imports(code, moduleUrl);
    await window.ScanPNLNativeRuntime.fromSource(code, moduleUrl);
    const portfolioMatch = code.match(
      /\{fetchPortfolioData:[\w$]+\}=[\w$]+\((?:!1|false),([\w$]+)\)/,
    );
    const portfolioImport = portfolioMatch && imports.get(portfolioMatch[1]);
    if (!portfolioImport) throw Error("Native portfolio atom changed");

    // an imported binding, each module loaded once
    async function bind(found)
    {
      if (!modules.has(found.url)) modules.set(found.url, import(found.url));
      return (await modules.get(found.url))[found.key];
    }

    // the store: an imported factory whose result has get, set and sub
    let store;
    for (const match of code.matchAll(/(?:var|let|const)\s+([\w$]+)=([\w$]+)\(\),/g))
    {
      if (!imports.has(match[2]) || !code.includes(match[1] + ".get(")) continue;
      const factory = await bind(imports.get(match[2]));
      if (typeof factory !== "function") continue;
      const candidate = factory();
      if (candidate?.get && candidate?.set && candidate?.sub)
      {
        store = candidate;
        break;
      }
    }
    if (!store) throw Error("Native portfolio store changed");

    // the sol rewards-level atom in the boot module (for the share card rank)
    for (const found of imports.values())
    {
      if (!found.url.includes("/boot-app-")) continue;
      const bootCode = await window.ScanPNLNativeRuntime.source(found.url);
      const at = bootCode.indexOf("cached-rewards-level-sol");
      if (at < 0) continue;
      const before = bootCode.slice(Math.max(0, at - 2500), at);
      const local = [...before.matchAll(/case`sol`:return\s+[\w$]+\(([\w$]+)\)/g)].at(-1)?.[1];
      if (!local) continue;
      const key = window.ScanPNLNativeRuntime.exportName(bootCode, local);
      if (key)
      {
        const atom = await bind({ url: found.url, key });
        if (atom?.write) rewards = { atom };
      }
      break;
    }

    // the portfolio atom and the unified (all chains) sol portfolio atom
    const portfolioAtom = await bind(portfolioImport);
    nativeOriginal = store.get(portfolioAtom);
    nativeState = nativeOriginal || {};
    const unifiedMatch = code.match(
      /\{fetchPortfolioData:[\w$]+\}=[\w$]+\((?:!1|false),([\w$]+)\(`sol`\)\)/,
    );
    const unifiedImport = unifiedMatch && imports.get(unifiedMatch[1]);
    if (!unifiedImport) throw Error("Native unified Solana portfolio binding changed");
    const unifiedFactory = await bind(unifiedImport);
    const unifiedAtom = unifiedFactory("sol");
    if (!unifiedAtom || unifiedAtom === portfolioAtom)
    {
      throw Error("Native unified Solana portfolio atom unavailable");
    }
    const unified = { atom: unifiedAtom, real: store.get(unifiedAtom), last: undefined };
    unifiedAtoms.push(unified);
    unified.unsubscribe = store.sub(unifiedAtom, () =>
    {
      if (writing) return;
      const value = store.get(unifiedAtom);
      if (value !== unified.last) unified.real = value;
      if (enabled) apply();
    });
    binding = { store, atom: portfolioAtom };
    syncRewards();
    if (rewards)
    {
      unsubscribeRewards = store.sub(rewards.atom, () =>
      {
        if (enabled && store.get(rewards.atom) == null) syncRewards();
      });
    }

    // axiom reloading its own data replaces the remembered real state, then paper is applied again
    unsubscribePortfolio = store.sub(portfolioAtom, () =>
    {
      if (writing) return;
      const value = store.get(portfolioAtom);
      if (
        !enabled ||
        !lastApplied ||
        ["balance", "performance", "calendar", "activePositions"].every(
          (key) => value?.[key] !== lastApplied[key],
        )
      )
      {
        nativeOriginal = value;
        nativeState = value || {};
      }
      if (enabled) apply();
    });
    document.documentElement.dataset.scanpnlPortfolio = "connected";
    return binding;
  }

  // puts axiom's real portfolio back
  function restore()
  {
    if (binding && rewards?.seeded && binding.store.get(rewards.atom) === rewards.seeded)
    {
      binding.store.set(rewards.atom, rewards.original);
      rewards.seeded = undefined;
    }
    if (binding && nativeState)
    {
      writing = true;
      try
      {
        binding.store.set(binding.atom, nativeOriginal);
        for (const unified of unifiedAtoms) binding.store.set(unified.atom, unified.real);
        document.documentElement.dataset.scanpnlPortfolio = "native";
      }
      finally
      {
        writing = false;
      }
    }
  }

  // writes the paper portfolio into axiom's store
  function apply()
  {
    if (!enabled || !binding || !bundle || !nativeState) return;
    syncRewards();
    const { calendarCapital, paperInsights, edgePerformance, ...parts } = bundle;
    const next = { ...nativeState, ...parts };

    // a copy of axiom's data with every number zeroed
    const empty = (value) =>
      value instanceof Date
        ? value
        : Array.isArray(value)
          ? value.map(empty)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, empty(item)]))
            : typeof value === "number"
              ? 0
              : value;

    // insights: axiom's shape, filled with paper stats and an hourly win map
    if (!bundle.insights?.data)
    {
      const insights = empty(nativeState.insights?.data) || {
        insights: {
          pnlPctHistogram: Array(12).fill(0),
          revengeCount: 0,
          revengeWins: 0,
          tiltSizeAfterLossSumNative: 0,
          tiltSizeAfterLossCount: 0,
          martingaleCorr: null,
          hourly: {},
        },
        performanceMetrics: {},
      };
      if (insights)
      {
        insights.performanceMetrics = edgePerformance || bundle.performance.data;
        if (insights.insights)
        {
          Object.assign(insights.insights, paperInsights);
          insights.insights.sharpe = { sevenDay: null, thirtyDay: null, allTime: null };
          if (insights.insights.hourly && calendarCapital)
          {
            const hourly = {
              counts: Array(168).fill(0),
              wins: Array(168).fill(0),
              pnlNative: Array(168).fill(0),
            };
            for (const record of calendarCapital.records)
            {
              const date = new Date(record.at);
              const hour = ((date.getUTCDay() + 6) % 7) * 24 + date.getUTCHours();
              hourly.counts[hour]++;
              if (record.pnl > 0) hourly.wins[hour]++;
              hourly.pnlNative[hour] += record.pnl;
            }
            insights.insights.hourly = hourly;
          }
        }
      }
      next.insights = { data: insights, loading: false };
    }

    // a copy with lists emptied and numbers zeroed
    const emptyRows = (value) =>
      Array.isArray(value)
        ? []
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, emptyRows(item)]))
          : typeof value === "number"
            ? 0
            : value;
    next.devTokens = {
      ...nativeState.devTokens,
      data: emptyRows(nativeState.devTokens?.data),
      loading: false,
    };
    next.pagination = {
      ...nativeState.pagination,
      wallets: [],
      isSearch: false,
      actives: { cursor: null, loadingMore: false },
      history: { cursor: null, loadingMore: false },
    };
    writing = true;
    try
    {
      lastApplied = next;
      binding.store.set(binding.atom, next);
      for (const unified of unifiedAtoms)
      {
        unified.last = { ...(unified.real || {}), ...next };
        binding.store.set(unified.atom, unified.last);
      }
    }
    finally
    {
      writing = false;
    }
    document.documentElement.dataset.scanpnlPortfolio = "paper";
    syncMonthlyCapital();
  }

  // gives the pnl calendar's share card the paper capital of the shown month
  function syncMonthlyCapital()
  {
    if (!enabled || !bundle?.calendarCapital) return;
    const title = [...document.querySelectorAll("span")].find(
      (span) => span.textContent.trim() === "PNL Calendar",
    );
    if (!title) return;
    const card = title.parentElement?.parentElement;
    const shareButton = card?.querySelector("i.ri-share-2-line")?.closest("button");
    if (!shareButton) return;
    let fiber = shareButton[Object.keys(shareButton).find((key) => key.startsWith("__reactFiber"))];
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return)
    {
      const monthly = fiber.memoizedProps?.monthlyData;
      if (!monthly?.monthName) continue;
      const month = new Date("1 " + monthly.monthName);
      if (isNaN(month)) return;
      const start = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
      const end = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
      const capital = bundle.calendarCapital;
      const before = capital.records.filter((record) => record.at < start);
      const during = capital.records.filter((record) => record.at >= start && record.at < end);
      const rate = during[0]?.solUsd || before.at(-1)?.solUsd || capital.rate;
      const native = capital.initial + before.reduce((sum, record) => sum + record.pnl, 0);
      const usd = capital.initial * rate + before.reduce((sum, record) => sum + record.pnlUsd, 0);
      const showsUsd = [...card.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "USD",
      );
      const invested = showsUsd ? usd : native;
      for (const node of [fiber, fiber.alternate])
      {
        const data = node?.memoizedProps?.monthlyData;
        if (data)
        {
          data.totalBought = invested;
          data.totalSold = invested + data.monthlyPnl;
        }
      }
      return;
    }
  }

  // keeps the rank and calendar capital current
  setInterval(() =>
  {
    syncRewards();
    syncMonthlyCapital();
  }, 500);

  // the rank must be in place before axiom reads it on press
  document.addEventListener(
    "pointerdown",
    (event) =>
    {
      if (enabled && location.pathname.startsWith("/portfolio")) syncRewards();
    },
    true,
  );

  // portfolio share buttons wait until the paper data and rank are applied, then click again
  document.addEventListener(
    "click",
    (event) =>
    {
      if (!enabled || !location.pathname.startsWith("/portfolio")) return;
      const button = event.target.closest?.("button");
      if (!button) return;
      if (replayedClicks.has(button))
      {
        replayedClicks.delete(button);
        return;
      }
      if (
        !button.querySelector("i.ri-share-2-line") &&
        !/share.*pnl|share.*profit/i.test(button.getAttribute("aria-label") || button.title || "")
      )
      {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const ready = binding ? Promise.resolve() : connecting || connect().then(() => apply());
      ready
        .then(() =>
        {
          syncRewards();
          return new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        })
        .then(() =>
        {
          if (!enabled || !button.isConnected || !location.pathname.startsWith("/portfolio"))
          {
            return;
          }
          replayedClicks.add(button);
          button.click();
        })
        .catch(() =>
        {
          if (enabled && button.isConnected)
          {
            replayedClicks.add(button);
            button.click();
          }
        });
    },
    true,
  );

  // applies or restores, connecting first when needed
  function sync()
  {
    if (!enabled) return restore();
    if (binding) return apply();
    if (!connecting)
    {
      connecting = window.ScanPNLNativeRuntime.attempt("portfolio", connect)
        .then(apply)
        .catch((error) =>
        {
          document.documentElement.dataset.scanpnlPortfolio = error.message;
        })
        .finally(() =>
        {
          connecting = null;
        });
    }
  }

  // paper portfolio updates and the paper mode switch from the content script
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "scanpnl-portfolio-v1")
    {
      enabled = event.data.enabled === true;
      bundle = event.data.bundle;
      const rankChanged = shareRank !== event.data.shareRank;
      shareRank = event.data.shareRank;
      if (rankChanged) syncRewards();
      if (event.data.revision === revision && binding) return;
      revision = event.data.revision;
      sync();
    }
    if (event.data?.type === "scanpnl-mode-v2" && event.data.enabled === false)
    {
      enabled = false;
      restore();
    }
  });

  // retries until the portfolio module loads
  setInterval(() =>
  {
    if (enabled && !binding) sync();
  }, 1000);

  // stops listening when the page goes away
  window.addEventListener("pagehide", () =>
  {
    unsubscribePortfolio?.();
    unsubscribeRewards?.();
    for (const unified of unifiedAtoms) unified.unsubscribe?.();
  });
})();
