// Trade Terminal — content script (isolated world)
//
// Renders the floating trade overlay, executes paper buys/sells, and keeps
// the shared `paperTerminalState` object (chrome.storage.local) in sync with
// the page. Talks to page-bridge.js (MAIN world) over CustomEvents on
// `window`, since this script cannot reach into the host page's own React
// tree or its TradingView chart instance directly.
//
// Fixes in this revision (see CHANGES.md for the full write-up):
//   - Every token we resolve is re-keyed to Dexscreener's canonical
//     `baseToken.address` whenever a quote is available, so a token bought
//     from a trenches/list row and the same token opened on its detail page
//     always collapse to the same position + fill history, instead of two
//     different DOM-heuristic addresses silently creating two "tokens".
//   - Live price/PnL no longer depends solely on page-bridge finding a
//     TradingView iframe API. A lightweight on-page price poller (reusing
//     the same CSS-selector scraping used for detection) keeps the overlay's
//     price/PnL fresh even on sites that render charts without an iframe.
//   - `chart-model` events (which drive both PnL and the TradingView marker
//     overlay) are re-published whenever the resolved token address changes,
//     not only when explicitly triggered by a buy/sell, closing the gap
//     where a quick buy from a list page wouldn't show up once you opened
//     that token's chart.

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Site detection / page scraping
  // ---------------------------------------------------------------------

  const SITE_CONFIGS = [
    {
      id: "axiom",
      hosts: /axiom\.trade$/,
      nameSelectors: ['[data-testid="token-name"]', "h1"],
      symbolSelectors: ['[data-testid="token-symbol"]'],
      priceSelectors: ['[data-testid="token-price"]', '[class*="price"]'],
    },
    {
      id: "gmgn",
      hosts: /gmgn\.ai$/,
      nameSelectors: ['[class*="token-name"]', "h1"],
      symbolSelectors: ['[class*="symbol"]'],
      priceSelectors: ['[class*="price"]'],
    },
    {
      id: "terminal",
      hosts: /(padre|terminal)\./,
      nameSelectors: ['[class*="tokenName"]', "h1"],
      symbolSelectors: ['[class*="symbol"]'],
      priceSelectors: ['[class*="price"]'],
    },
    {
      id: "photon",
      hosts: /photon-sol\.tinyastro\.io$/,
      nameSelectors: ['[class*="token-name"]', "h1"],
      symbolSelectors: ['[class*="ticker"]'],
      priceSelectors: ['[class*="price"]'],
    },
    {
      id: "bullx",
      hosts: /(bullx|neo\.bullx)\./,
      nameSelectors: ['[class*="token-name"]', "h1"],
      symbolSelectors: ['[class*="symbol"]'],
      priceSelectors: ['[class*="price"]'],
    },
    {
      id: "dexscreener",
      hosts: /dexscreener\.com$/,
      nameSelectors: ['[class*="pair-header"] h2', "h1"],
      symbolSelectors: ['[class*="pair-header"]'],
      priceSelectors: ['[class*="price"]'],
    },
  ];

  const readFirstMatch = (selectors) =>
    selectors
      .map((sel) => document.querySelector(sel)?.textContent?.trim())
      .find(Boolean);

  const parsePriceText = (text) => {
    if (!text) return 0;
    const cleaned = text
      .replace(/[$,\s]/g, "")
      .replace(/⁰([0-9])/g, "0.$1");
    const match = cleaned.match(/(?:USD)?([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)/i);
    return match ? Number(match[1]) : 0;
  };

  const ADDRESS_RE = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,50})$/;
  const ADDRESS_SCAN_RE = /(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,50})/g;

  function extractAddressFromUrl(href = location.href) {
    try {
      const url = new URL(href, location.href);
      const paramNames = [
        "address",
        "token",
        "contract",
        "contractAddress",
        "ca",
        "mint",
        "pair",
        "pairAddress",
        "outputMint",
      ];
      const fromParams = paramNames
        .map((name) => url.searchParams.get(name))
        .find((value) => value && ADDRESS_RE.test(value));
      if (fromParams) return fromParams;

      const segments = [
        ...url.pathname.split(/[/_:]/),
        ...url.hash.split(/[/?#=&_:]/),
      ];
      return segments.reverse().find((seg) => ADDRESS_RE.test(seg)) || "";
    } catch {
      return "";
    }
  }

  const detectSiteId = () =>
    SITE_CONFIGS.find((site) => site.hosts.test(location.hostname))?.id ??
    "unknown";

  function readPageToken() {
    const site = SITE_CONFIGS.find((s) => s.id === detectSiteId());
    const address = extractAddressFromUrl();
    const name = site ? readFirstMatch(site.nameSelectors) : undefined;
    const symbolText = site ? readFirstMatch(site.symbolSelectors) : undefined;
    // A random .price node can be SOL, a different row, or a trade amount.
    // Only use an explicitly identified token price or the header's Price field.
    let priceNode = document.querySelector('[data-testid="token-price"]');
    if (!priceNode && address) {
      const label = [...document.querySelectorAll("span,div")].find((el) => el.children.length === 0 && el.textContent.trim() === "Price");
      priceNode = label?.nextElementSibling;
    }
    let priceText = priceNode?.getAttribute("data-price-usd") || priceNode?.textContent || "";
    if (priceNode?.querySelector("sub")) {
      const copy = priceNode.cloneNode(true);
      for (const sub of copy.querySelectorAll("sub")) {
        const count = Number(sub.textContent);
        if (count >= 1 && count <= 18) sub.replaceWith("0".repeat(count));
      }
      priceText = copy.textContent;
    }
    const price = parsePriceText(priceText);
    const symbol = (
      symbolText?.match(/[A-Z0-9]{2,12}/)?.[0] ||
      name?.split(/\s+/)[0] ||
      "TOKEN"
    ).slice(0, 12);
    return {
      terminal: site?.id ?? "unknown",
      name: name?.slice(0, 40) || symbol,
      symbol,
      address,
      chain: location.pathname.includes("base") ? "base" : "solana",
      price,
      priceUpdatedAt: Date.now(),
      source: price > 0 ? "page" : "unavailable",
    };
  }

  // ---------------------------------------------------------------------
  // Trade engine — pure functions over the persisted state object
  // ---------------------------------------------------------------------

  const makeId = () => crypto.randomUUID();
  const positionKey = (token) => `${token?.chain}:${token?.address}`;
  const toUsd = (amount, unit, solPrice) =>
    unit === "SOL" ? amount * solPrice : amount;

  function executionSettings(settings, side = "buy", terminal = detectSiteId()) {
    return TradeTerminalSettings.execution(settings, side, terminal);
  }

  function tradeFailure(state, message) {
    return { ok: false, message, state };
  }

  function executeBuy(state, token, spendUsd) {
    return TradeTerminalSettings.executeBuy(state,{...token,terminal:token.terminal || detectSiteId()},spendUsd);
  }

  function executeSell(state, token, sellPercent) {
    const exactKey = positionKey(token);
    const position = state.positions[exactKey] || Object.values(state.positions).find((candidate) => sameToken(candidate.token, token));
    const key = position?.key || exactKey;
    if (!position || position.quantity <= 0) {
      return tradeFailure(state, "No open position to sell.");
    }
    if (!Number.isFinite(sellPercent) || sellPercent <= 0 || sellPercent > 100) {
      return tradeFailure(state, "Sell percentage must be between 0 and 100.");
    }
    if (!Number.isFinite(token.price) || token.price <= 0) {
      return tradeFailure(state, "A current price is required.");
    }

    const settings = executionSettings(state.settings, "sell", token.terminal || detectSiteId());
    const sellQuantity = position.quantity * (sellPercent / 100);
    const impactBps = effectiveImpactBps(settings, token, sellQuantity * token.price);
    const executionBps = Math.min(9999, Math.max(0, impactBps));
    const fillPrice = token.price * (1 - executionBps / 1e4);
    if (fillPrice < (token.requestedPrice || token.price) * (1 - settings.slippageBps / 1e4) * (1 - 1e-12)) {
      return tradeFailure(state, "Price moved beyond your sell slippage tolerance. No fill.");
    }
    const grossUsd = sellQuantity * fillPrice;
    const platformFeeUsd = (grossUsd * settings.feeBps) / 1e4;
    const gasFeeUsd = (settings.networkFeeSol + settings.priorityFeeSol + settings.mevBribeSol) * settings.solPrice;
    const totalFeeUsd = platformFeeUsd + gasFeeUsd;
    if (state.balanceUsd + grossUsd < totalFeeUsd) return tradeFailure(state, "Insufficient balance for sell fees. No fill.");
    const slippageUsd = sellQuantity * token.price - grossUsd;
    const costBasisPortion = position.costBasis * (sellQuantity / position.quantity);
    const realizedPnl = grossUsd - totalFeeUsd - costBasisPortion;
    const remainingQuantity = Math.max(0, position.quantity - sellQuantity);

    const updatedPosition = {
      ...position,
      token: TradeTerminalSettings.mergeToken(position.token, token),
      quantity: remainingQuantity,
      costBasis: Math.max(0, position.costBasis - costBasisPortion),
      soldUsd: position.soldUsd + grossUsd,
      realizedPnl: position.realizedPnl + realizedPnl,
      updatedAt: Date.now(),
      closedAt: remainingQuantity < 1e-12 ? Date.now() : undefined,
    };

    const fill = {
      id: makeId(),
      roundId: position.roundId || `round-${position.openedAt || Date.now()}`,
      token: updatedPosition.token,
      side: "sell",
      quantity: sellQuantity,
      price: fillPrice,
      ...TradeTerminalSettings.fillSnapshot(token, fillPrice, settings.solPrice),
      grossUsd,
      feeUsd: totalFeeUsd,
      platformFeeUsd,
      gasFeeUsd,
      slippageUsd,
      realizedPnl,
      timestamp: Date.now(),
    };

    return {
      ok: true,
      message: `Sold ${sellPercent}% of ${token.symbol}`,
      fill,
      state: {
        ...state,
        initialFundingPending: false,
        balanceUsd: state.balanceUsd + grossUsd - totalFeeUsd,
        fills: [fill, ...state.fills],
        positions: { ...state.positions, [key]: updatedPosition },
      },
    };
  }

  function effectiveImpactBps(settings, token, tradeUsd) {
    // Market cap is not pool liquidity. Only an explicitly configured impact
    // may adjust the observed quote; slippage tolerance is never a fee.
    return Math.min(5000, Math.max(0, Number(settings.priceImpactBps) || 0));
  }

  // ---------------------------------------------------------------------
  // Persisted state
  // ---------------------------------------------------------------------

  const DEFAULT_STATE = {
    ...TradeTerminalSettings.initialAccount(),
    fills: [],
    positions: {},
    settings: {
      enabled: true,
      mainTerminal: "axiom",
      trenchesQuickBuy: true,
      trenchesInstantTrade: true,
      startingBalance: TradeTerminalSettings.DEFAULT_SOL_PRICE,
      solPrice: TradeTerminalSettings.DEFAULT_SOL_PRICE,
      buyPresets: [
        { id: "buy-01", label: "0.1", value: 0.1, unit: "SOL", shortcut: "1", primary: false, confirm: false, color: "neutral" },
        { id: "buy-025", label: "0.25", value: 0.25, unit: "SOL", shortcut: "2", primary: false, confirm: false, color: "neutral" },
        { id: "buy-05", label: "0.5", value: 0.5, unit: "SOL", shortcut: "3", primary: true, confirm: false, color: "violet" },
        { id: "buy-1", label: "1", value: 1, unit: "SOL", shortcut: "4", primary: false, confirm: false, color: "neutral" },
        { id: "buy-2", label: "2", value: 2, unit: "SOL", shortcut: "5", primary: false, confirm: false, color: "neutral" },
      ],
      quickBuyAmountSol: 0.5,
      sellPresets: [10, 25, 50, 75, 100],
      slippageBps: 3000,
      slippageFormatVersion: 2,
      executionDefaultsVersion: 3,
      networkFeeSol: 0.000005,
      priorityFeeSol: 0.001995,
      mevBribeSol: 0.001,
      activeExecutionPreset: "p1",
      activePresetDefaultVersion: 1,
      executionPresets: TradeTerminalSettings.profiles(),
      instantTradePositions: {},
      instantTradeSizes: {},
      instantTradeUnit: "SOL",
      priceImpactBps: 0,
      executionModelVersion: 1,
      quickBuyAction: "none",
      pnlMode: "cumulative",
      customDelayEnabled: false,
      customDelayMs: 0,
      quickBuyDelay: false,
      latencyMs: 120,
      undoSeconds: 5,
      shortcutsEnabled: true,
      sounds: false,
      reducedMotion: false,
      enabledTerminals: {
        axiom: true,
        gmgn: true,
        terminal: true,
        photon: true,
        bullx: true,
        dexscreener: true,
        unknown: false,
      },
    },
    version: 1,
  };

  const STORAGE_KEY = "paperTerminalState";
  const hasChromeStorage = () => typeof chrome < "u" && !!chrome.storage?.local;

  async function loadState() {
    if (hasChromeStorage()) {
      return normalizeState((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : structuredClone(DEFAULT_STATE);
  }

  async function saveState(state) {
    if (hasChromeStorage() && chrome.runtime?.sendMessage) {
      const result = await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:state.settings,initialState:{...TradeTerminalSettings.initialAccount(),version:1}});
      if (!result?.ok) throw new Error(result?.message || 'Settings could not be saved.');
      Object.assign(state,normalizeState(result.state));
    } else if (hasChromeStorage()) {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }

  const wholeSlippageBps = (value) => Math.round(Math.min(100, Math.max(0, Number.isFinite(Number(value)) ? Number(value) / 100 : 30))) * 100;
  
  function normalizeSlippageSettings(settings, stored = {}) {
    const migrating = stored.slippageFormatVersion !== 2;
    settings.slippageBps = wholeSlippageBps(migrating && stored.slippageBps === 50 ? 3000 : settings.slippageBps);
    const prior = { p1: [0, 100, 0.000005, 0.001, 0.001], p2: [50, 100, 0.000005, 0.003, 0.005], p3: [0, 0, 0, 0, 0] };
    const fields = ["slippageBps", "feeBps", "networkFeeSol", "priorityFeeSol", "mevBribeSol"];
    settings.executionPresets = settings.executionPresets.map((profile) => {
      const wasDefault = migrating && prior[profile.id] && fields.every((key, i) => profile[key] === prior[profile.id][i]);
      const next = { ...profile, slippageBps: wholeSlippageBps(wasDefault ? 3000 : profile.slippageBps ?? 3000) };
      for (const side of ["buy", "sell"]) if (profile[side]) next[side] = { ...profile[side],
        slippageBps: wholeSlippageBps(profile[side].slippageBps ?? next.slippageBps) };
      return next;
    });
    settings.slippageFormatVersion = 2;
    return settings;
  }
    function normalizeState(state) {
    if (!state) return structuredClone(DEFAULT_STATE);
    const storedProfiles = state.settings?.executionPresets;
    const oldDefaults = Array.isArray(storedProfiles) &&
      storedProfiles.some((profile) => profile.id === "p1" && profile.slippageBps === 25 && profile.feeBps === 50) &&
      storedProfiles.some((profile) => profile.id === "p2" && profile.slippageBps === 50 && profile.feeBps === 95) &&
      storedProfiles.some((profile) => profile.id === "p3" && profile.slippageBps === 200 && profile.feeBps === 125);
    const executionPresets = !Array.isArray(storedProfiles) || oldDefaults
      ? DEFAULT_STATE.settings.executionPresets.map((profile) => ({ ...profile }))
      : storedProfiles.map((profile) => ({ ...profile }));
    const settings = {
      ...DEFAULT_STATE.settings,
      ...state.settings,
      executionPresets,
      instantTradePositions: { ...DEFAULT_STATE.settings.instantTradePositions, ...state.settings?.instantTradePositions },
      instantTradeSizes: { ...DEFAULT_STATE.settings.instantTradeSizes, ...state.settings?.instantTradeSizes },
      buyPresets: state.settings?.buyPresets ?? DEFAULT_STATE.settings.buyPresets,
      enabledTerminals: {
        ...DEFAULT_STATE.settings.enabledTerminals,
        ...state.settings?.enabledTerminals,
      },
    };
    return TradeTerminalSettings.reconcilePositions({ ...DEFAULT_STATE, ...state, initialFundingPending:state.initialFundingPending===true, settings: TradeTerminalSettings.normalizeDefaults(normalizeSlippageSettings(settings, state.settings), state.settings) });
  }

  // Once we have a Dexscreener quote for a token, its `baseToken.address` is
  // the canonical identity for that market — use it everywhere instead of
  // whatever a DOM heuristic happened to scrape. This is what keeps a token
  // bought from a trenches row and the same token's detail page collapsed to
  // one position/one set of chart markers.
  function withCanonicalAddress(token, dexPair) {
    const canonical = dexPair?.baseToken?.address;
    if (!canonical || !ADDRESS_RE.test(canonical)) return token;
    return TradeTerminalSettings.mergeToken(token, {
      altAddress: token.address && token.address !== canonical ? token.address : token.altAddress,
      quoteAddress: dexPair.pairAddress || token.quoteAddress || token.altAddress,
      address: canonical, mint: canonical,
      aliases:[dexPair.pairAddress, ...(token.aliases||[])].filter(Boolean),
    });
  }

  function fillMatchesToken(fill, token) { return sameToken(fill.token,token); }
  function sameToken(left, right) { return TradeTerminalSettings.sameToken(left,right); }

  // ---------------------------------------------------------------------
  // Overlay UI
  // ---------------------------------------------------------------------

  const ROOT_ID = "paper-terminal-root";
  const TRENCH_BUY_CLASS = "paper-terminal-trench-buy";
  const TRENCH_LAYER_ID = "paper-terminal-trench-layer";
  const CHART_MARKERS_ID = "paper-terminal-chart-markers";

  let state = null;
  let currentToken = null;
  let independentQuote = null;
  let liveQuoteRoute = "";
  let acceptedQuote = null;
  const quoteObservations = new Map();
  let lastWatchdogKick = 0;
  let panelExpanded = true;
  let toastTimer = 0;
  let chartRaf = 0;
  let panelPosition = null;
  let executionEditorOpen = false;
  let executionEditorSide = "buy";
  let amountDraft = null;
  let panelSettingsQueue = Promise.resolve();
  let panelRoute = '';
  function queuePanelSettings(change) {
    const save = async () => {
      const latest = await loadState();
      change(latest.settings);
      await saveState(latest);
      state = latest;
      publishQuickConfig();
    };
    const pending = panelSettingsQueue.then(save, save);
    panelSettingsQueue = pending.catch(() => {});
    return pending;
  }
  let resizeSession = null;
  let dragging = false;
  let surfaceGeneration = 0;
  let tradeQueue = Promise.resolve();
  let tradeEpoch = 0;
  let mainPaneOpen = false;
  let lastQuickResult = null;
  const isEnabled = () => !!(state?.settings.enabled && state.settings.enabledTerminals[detectSiteId()]);

  const LIVE_SOURCE_PRIORITY = {
    "site-feed": 4,
    chart: 4,
    "detail-cap": 4,
    page: 2,
    dexscreener: 1,
    market: 1,
    cached: 0,
  };

  function resetLiveQuoteState() {
    liveQuoteRoute = location.href;
    acceptedQuote = null;
    quoteObservations.clear();
    lastWatchdogKick = 0;
  }

  // All mark prices pass through one ordered gate. A slow HTTP/DOM response
  // must never roll a newer terminal/chart tick backwards, which previously
  // made P&L freeze, invert direction, or briefly jump by a scale factor.
  function adoptLiveQuote(candidate, options = {}) {
    if (!candidate || !currentToken || !isEnabled() || !isDetailPage()) return false;
    if (liveQuoteRoute !== location.href) resetLiveQuoteState();
    const source = options.source || candidate.source || "market";
    const quoteSource = options.quoteSource || candidate.quoteSource || source;
    const observedAt = Number(options.observedAt || candidate.priceObservedAt || candidate.observedAt || Date.now());
    const price = Number(candidate.price);
    const now = Date.now();
    if (!(price > 0) || !Number.isFinite(price) || observedAt > now + 1000 || now - observedAt > 10000) return false;
    if (options.requestedAt && acceptedQuote?.observedAt > options.requestedAt) return false;
    const priorForSource = quoteObservations.get(source);
    if (priorForSource && observedAt < priorForSource.observedAt) return false;
    const priority = LIVE_SOURCE_PRIORITY[source] ?? 1;
    if (acceptedQuote && priority < acceptedQuote.priority && now - Number(currentToken.priceUpdatedAt || 0) < 2500) return false;

    const oldPrice = Number(currentToken.price);
    const oldAge = now - Number(currentToken.priceUpdatedAt || 0);
    const ratio = price / Math.max(oldPrice, Number.MIN_VALUE);
    // Unit mistakes (token price vs SOL price vs market cap) are many orders
    // apart. Bound only fresh transitions, so legitimate long-offline moves
    // can still recover from the network.
    if (oldPrice > 0 && oldAge < 5000 && (ratio > 25 || ratio < 0.04)) return false;

    const supply = Number(candidate.supply) || Number(currentToken.supply) ||
      (Number(candidate.marketCap) > 0 ? Number(candidate.marketCap) / price : 0) ||
      (Number(currentToken.marketCap) > 0 && oldPrice > 0 ? Number(currentToken.marketCap) / oldPrice : 0);
    currentToken = TradeTerminalSettings.mergeToken(currentToken, candidate, {
      quickBuy: false,
      price,
      supply: supply || undefined,
      marketCap: supply > 0 ? price * supply : Number(candidate.marketCap) || currentToken.marketCap,
      priceUpdatedAt: observedAt,
      source,
      quoteSource,
    });
    acceptedQuote = { source, priority, observedAt, price };
    quoteObservations.set(source, acceptedQuote);
    updateLiveMetrics();
    scheduleChartUpdate();
    return true;
  }

  const STYLES = `
.wrap .main-pane{flex:1;min-height:0;overflow:auto;gap:14px;background:#14141680}.wrap .main-pane label{flex-wrap:wrap;justify-content:space-between}.wrap .main-pane label:has(input[type=checkbox]){justify-content:flex-start}.main-pane select,.main-pane input[type=number]{font:inherit;color:var(--text);background:#242426;border:1px solid #ffffff25;border-radius:4px;padding:7px;max-width:100%;min-width:0}.main-pane input[type=number]{width:110px}.main-pane select{max-width:190px}.settings-execution{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.main-pane button{font-size:12px}.main-pane input:disabled{opacity:.45}.wrap.settings-open .resize-grip{display:none}.wrap .pnl-section .value{letter-spacing:0}
:host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:14px;--line:#ffffff16;--muted:#a3a6b0;--text:#e5e6eb;--green:#29dcb1;--red:#ff5080;--button-min-height:36px}
*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:focus-visible{outline:2px solid #c3cad5;outline-offset:2px}
.wrap{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;width:340px;z-index:2147483000;background:transparent;isolation:isolate;pointer-events:auto;color:var(--text);border:1px solid #ffffff22;border-radius:6px;box-shadow:0 14px 45px #0006,inset 0 1px 0 #ffffff05;overflow:hidden;min-width:min(310px,calc(100vw - 8px));max-width:calc(100vw - 8px);min-height:34px;max-height:calc(100vh - 8px);container-type:inline-size;font-variant-numeric:tabular-nums}
.wrap:before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(145deg,rgba(29,29,31,.86),rgba(16,16,18,.80));pointer-events:none}
.head{height:40px;flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:0 10px;border-bottom:1px solid var(--line);background:#20202233;cursor:grab;touch-action:none;user-select:none}.head:active{cursor:grabbing}.grow{flex:1}.head>svg{color:#a0a4ae;flex-shrink:0}.icon,.preset{border:0;background:transparent;color:var(--muted);padding:5px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center}.icon:hover,.preset:hover{background:#ffffff0c;color:#fff}.preset{font-size:14px;font-weight:600}.preset.active{color:#fff;background:#ffffff12}.icon{min-width:28px;min-height:30px}.icon svg{width:18px;height:18px}
.body{flex:1 1 auto;min-height:0;padding:0 8px 7px;overflow:auto;display:grid;grid-template-rows:auto auto minmax(var(--grid-min-height,36px),1fr) auto auto auto minmax(var(--grid-min-height,36px),1fr) auto auto}
.body>*{grid-column:1}.exec-editor{grid-row:1}.exec-editor+.label{grid-row:2}.grid{grid-row:3}.buy-terms{grid-row:4}.pnl-section{grid-row:5}.pnl-section+.label{grid-row:6}.sellgrid{grid-row:7}.sell-terms{grid-row:8}.foot{grid-row:9}
.label{display:flex;align-items:center;justify-content:space-between;gap:4px;margin:7px 0 7px;font-size:14px;min-height:20px}.buy-label,.sell-label{display:inline-flex;align-items:center;gap:5px}.balance,.holding-summary,.value{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}.balance{font-size:14px}.sol-icon{width:18px;height:16px;display:inline-block;flex:0 0 auto;vertical-align:middle}.holding-summary{font-size:12px;gap:4px;min-width:0}.holding-summary .quantity{overflow:hidden;text-overflow:ellipsis;max-width:110px}.muted{color:var(--muted)}
.unit-switch{display:inline-flex;align-items:center;gap:2px;border:0;background:transparent;padding:2px;color:var(--muted);border-radius:4px}.unit-switch svg{width:16px;height:16px}.unit-switch small{font-size:11px}.unit-switch:hover{color:#fff;background:#ffffff0c}
.grid,.sellgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(var(--amount-rows,1),minmax(var(--button-min-height),1fr));gap:6px;min-height:var(--grid-min-height,36px)}.buy,.sell{min-width:0;min-height:var(--button-min-height);height:100%;padding:0 3px;background:#16161830;border:1px solid #26c99e66;border-radius:999px;color:var(--green);font-size:16px;line-height:1.2;font-weight:600;white-space:nowrap}.buy:hover{background:#23cfaa18;border-color:#29dcb1}.buy.primary{border-color:#29dcb19c}.sell{color:var(--red);border-color:#ed447366}.sell:hover{background:#ff508016;border-color:#ff5080}.buy:disabled,.sell:disabled{opacity:.65;cursor:not-allowed}.wrap:not(.expanded-amounts) .extra-amount{display:none}
.terms{display:flex;align-items:center;gap:8px;margin:6px 0 2px;font-size:12px;color:#c0c3cc;min-height:20px}.terms>span{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}.terms svg{width:16px;height:16px;color:#959ba7;flex-shrink:0}.terms b{font-weight:600}.terms .bribe,.terms .bribe svg{color:inherit}.terms-edit{margin-left:auto;border:0;background:transparent;color:#a2a7b2;padding:3px;display:inline-flex}.terms-edit:hover{color:#fff}.sell-terms{margin-bottom:8px}
.pnl-section{display:flex;align-items:center;justify-content:center;min-height:70px;padding:12px 6px;margin:6px 0 2px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:linear-gradient(110deg,#10111418,#30323828,#10111418);text-align:center}.pnl-section.gain{background:linear-gradient(110deg,#0a201918,#16836545 50%,#0a201918)}.pnl-section.loss{background:linear-gradient(110deg,#260e1418,#b52e4845 50%,#260e1418)}.pnl-result{display:flex;align-items:baseline;justify-content:center;gap:7px;flex-wrap:wrap;min-width:0}.pnl-section .value{font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:1.2}.pnl-section .sol-icon{width:23px;height:20px}.pnl-percent{font-size:12px;font-weight:600}.foot{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 -8px;padding:8px 4px 0;border-top:1px solid var(--line);text-align:center}.foot>span+span{border-left:1px solid var(--line)}.foot .value{font-size:12px;line-height:1.35;gap:3px;justify-content:center;white-space:normal;overflow-wrap:anywhere}.foot .number{min-width:0}#foot-bought{color:var(--green)}#foot-sold{color:var(--red)}#foot-mcap{color:var(--text)}.foot .sol-icon{width:16px;height:14px}.pos{color:var(--green)}.neg{color:var(--red)}.quote-status{display:flex;justify-content:space-between;gap:6px;font-size:8px;color:var(--muted);margin-top:7px;min-height:10px}.status{color:#9cc6b8}.status.stale{color:#a6a9b2}.quote-status strong{font-weight:500}
.exec-editor{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:8px;margin-top:8px;border:1px solid #ffffff22;border-radius:5px;background:#080a0ee6;font-size:10px}.exec-editor[hidden]{display:none}.exec-editor label{color:#c9cdd5;font-size:11px}.exec-editor input{display:block;width:100%;height:29px;margin-top:5px;padding:3px 4px;border:1px solid #ffffff29;border-radius:4px;background:#ffffff09;color:#f2f3f6;font-size:13px}.exec-editor input:focus{outline:1px solid #aeb8cf}.exec-editor .save{grid-column:1/-1;justify-content:center;background:#ffffff15;color:#fff;font-size:11px;padding:8px;margin-top:3px}
.toast{position:absolute;left:8px;right:8px;bottom:8px;z-index:8;padding:10px;border:1px solid #ffffff29;border-radius:5px;background:#13151af5;color:var(--text);box-shadow:0 5px 20px #0008;display:none;font-size:11px}.toast.show{display:block}.toast.bad{border-color:#ff508077;color:#ff93ae}.collapsed .body{display:none}.collapsed{height:40px!important;min-height:40px}.collapsed .resize-grip{display:none}
.resize-grip{position:absolute;z-index:9;width:12px;height:12px;touch-action:none}.resize-grip[data-corner="tl"]{left:0;top:0;cursor:nwse-resize}.resize-grip[data-corner="tr"]{right:0;top:0;cursor:nesw-resize}.resize-grip[data-corner="bl"]{left:0;bottom:0;cursor:nesw-resize}.resize-grip[data-corner="br"]{right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 0 55%,#6b6f7a 56% 62%,transparent 63% 72%,#a3a8b2 73% 79%,transparent 80%)}
@container(max-width:299px){.head{gap:3px;padding:0 8px}.holding-summary .quantity{max-width:72px}.foot .value{font-size:11px;gap:2px}.terms{gap:6px}.buy,.sell{font-size:14px}}
.editing-amounts .body{background:#7581b313}.editing-amounts .terms-edit{visibility:hidden}.amount-cell{display:flex;min-width:0;min-height:36px;border:1px solid #aab6de;border-radius:999px;background:#3e4359;overflow:hidden}.amount-cell input{width:100%;min-width:0;border:0;background:transparent;color:#fff;text-align:center;font-size:16px;font-weight:600;outline:0;padding:0 3px}.amount-cell:focus-within{border-color:#e0e6ff;box-shadow:0 0 0 1px #bcc8ee}.edit-active{color:#cfd9ff;background:#7482b435}.preset:disabled{cursor:default;opacity:.55}
`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const solIcon = () => `<svg class="sol-icon" width="18" height="16" role="img" aria-label="SOL" viewBox="0 0 101 88" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M100.48 69.3817L83.8068 86.8015C83.4444 87.1799 83.0058 87.4816 82.5185 87.6878C82.0312 87.894 81.5055 88.0003 80.9743 88H1.93563C1.55849 88 1.18957 87.8926 0.874202 87.6912C0.558829 87.4897 0.31074 87.2029 0.160416 86.8659C0.0100923 86.529 -0.0359181 86.1566 0.0280382 85.7945C0.0919944 85.4324 0.263131 85.0964 0.520422 84.8278L17.2061 67.408C17.5676 67.0306 18.0047 66.7295 18.4904 66.5234C18.9762 66.3172 19.5002 66.2104 20.0301 66.2095H99.0644C99.4415 66.2095 99.8104 66.3169 100.126 66.5183C100.441 66.7198 100.689 67.0067 100.84 67.3436C100.99 67.6806 101.036 68.0529 100.972 68.415C100.908 68.7771 100.737 69.1131 100.48 69.3817ZM83.8068 34.3032C83.4444 33.9248 83.0058 33.6231 82.5185 33.4169C82.0312 33.2108 81.5055 33.1045 80.9743 33.1048H1.93563C1.55849 33.1048 1.18957 33.2121 0.874202 33.4136C0.558829 33.6151 0.31074 33.9019 0.160416 34.2388C0.0100923 34.5758 -0.0359181 34.9482 0.0280382 35.3103C0.0919944 35.6723 0.263131 36.0083 0.520422 36.277L17.2061 53.6968C17.5676 54.0742 18.0047 54.3752 18.4904 54.5814C18.9762 54.7875 19.5002 54.8944 20.0301 54.8952H99.0644C99.4415 54.8952 99.8104 54.7879 100.126 54.5864C100.441 54.3849 100.689 54.0981 100.84 53.7612C100.99 53.4242 101.036 53.0518 100.972 52.6897C100.908 52.3277 100.737 51.9917 100.48 51.723L83.8068 34.3032ZM1.93563 21.7905H80.9743C81.5055 21.7907 82.0312 21.6845 82.5185 21.4783C83.0058 21.2721 83.4444 20.9704 83.8068 20.592L100.48 3.17219C100.737 2.90357 100.908 2.56758 100.972 2.2055C101.036 1.84342 100.99 1.47103 100.84 1.13408C100.689 0.79713 100.441 0.510296 100.126 0.308823C99.8104 0.107349 99.4415 1.24074e-05 99.0644 0L20.0301 0C19.5002 0.000878397 18.9762 0.107699 18.4904 0.313848C18.0047 0.519998 17.5676 0.821087 17.2061 1.19848L0.524723 18.6183C0.267681 18.8866 0.0966198 19.2223 0.0325185 19.5839C-0.0315829 19.9456 0.0140624 20.3177 0.163856 20.6545C0.31365 20.9913 0.561081 21.2781 0.875804 21.4799C1.19053 21.6817 1.55886 21.7896 1.93563 21.7905Z" fill="url(#tt-sol-gradient)"/>
<defs>
<linearGradient id="tt-sol-gradient" x1="8.52558" y1="90.0973" x2="88.9933" y2="-3.01622" gradientUnits="userSpaceOnUse">
<stop offset="0.08" stop-color="#9945FF"/>
<stop offset="0.3" stop-color="#8752F3"/>
<stop offset="0.5" stop-color="#5497D5"/>
<stop offset="0.6" stop-color="#43B4CA"/>
<stop offset="0.72" stop-color="#28E0B9"/>
<stop offset="0.97" stop-color="#19FB9B"/>
</linearGradient>
</defs>
</svg>`;
  const uiIcon = (name) => {
    const paths = {
      check: '<path d="m5 12 4 4L20 5"/>',
      grid: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M7 7h1m3 0h1m3 0h1M7 11h1m3 0h1m3 0h1M7 15h1m3 0h1m3 0h1"/>',
      edit: '<path d="m15 4 5 5M4 16 16 4a2 2 0 0 1 3 3L7 19l-4 1zM3 23h17"/>',
      gear: '<path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3z"/><circle cx="12" cy="11" r="3"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/>',
      swap: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
      slip: '<circle cx="14" cy="4" r="1.5"/><path d="m10 8 4-1 3 4 3 1M13 8l-3 6-5 1m5-1 5 3v4M5 6 3 8l4 2M2 21h8"/>',
      gas: '<path d="M3 21V4h10v17M2 21h13M3 11h10M15 5l4 4v9a2 2 0 0 1-4 0v-5h-2m4-6v4h3"/>',
      bribe: '<ellipse cx="9" cy="6" rx="7" ry="3"/><path d="M2 6v4c0 4 14 4 14 0V6M2 10v4c0 4 14 4 14 0v-4M18 11c5 1 5 5 0 6m-1 4c5-1 5-3 5-7"/>',
    };
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
  };
  const solNumber = (usd) => (usd / state.settings.solPrice).toLocaleString(undefined, { maximumFractionDigits: 4 });
  function quickBuySolAmount(settings) {
    const saved = Number(settings?.quickBuyAmountSol);
    if (Number.isFinite(saved) && saved > 0) return saved;
    const preset = settings?.buyPresets?.find((item) => item.primary) || settings?.buyPresets?.[0];
    const value = Number(preset?.value);
    if (!(value > 0)) return 0;
    return preset.unit === "USD" ? value / (Number(settings?.solPrice) || TradeTerminalSettings.DEFAULT_SOL_PRICE) : value;
  }
  const moneySlot = (id, unit = "SOL") => `<span class="value" id="${id}" title="${unit}">${unit === "SOL" ? solIcon() : ""}<span class="number"></span></span>`;
  const formatTokenPrice = (price) => price > 0 ? price < 0.01 ? `$${price.toPrecision(4)}` : formatUsd(price) : "—";
  const formatUsd = (amount) =>
    `${amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;

  const formatCompactUsd = (amount) =>
    `$${Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(Math.max(0, amount))}`;

  const currentPosition = () =>
    state.positions[positionKey(currentToken)] ||
    Object.values(state.positions).find((position) => sameToken(position.token, currentToken));
  const currentPrice = () => currentToken?.price || 0;

  function positionMetrics(position = currentPosition()) {
    return TradeTerminalSettings.pnlMetrics(position, currentPrice() || position?.token?.price, state.settings.pnlMode);
  }

  function fillsForCurrentRound() {
    const token = TradeTerminalSettings.mergeToken(currentToken,currentPosition()?.token);
    // Follow only this token's alias graph; regrouping the whole portfolio on
    // every price tick would slow P&L updates as history grows.
    const byAlias = new Map(), matches = new Set();
    for (const fill of state.fills) {
      if ((fill.token?.chain || "solana") !== (token.chain || "solana")) continue;
      for (const id of TradeTerminalSettings.tokenIds(fill.token)) {
        if (!byAlias.has(id)) byAlias.set(id,[]);
        byAlias.get(id).push(fill);
      }
    }
    const queue=TradeTerminalSettings.tokenIds(token), seen=new Set(queue);
    for (let index=0;index<queue.length;index++) {
      for (const fill of byAlias.get(queue[index]) || []) {
        if (matches.has(fill)) continue;
        matches.add(fill);
        for (const id of TradeTerminalSettings.tokenIds(fill.token)) if (!seen.has(id)) { seen.add(id);queue.push(id); }
      }
    }
    const fills=state.fills.filter(fill=>matches.has(fill));
    return TradeTerminalSettings.tradeCycles(fills).at(-1)?.fills || [];
  }

  function weightedFillAverage(fills, side) {
    return TradeTerminalSettings.averageFillLevels(fills,side).usd;
  }

  // Optional simulation delay; fees never imply a promised validator latency.
  function executionDelayMs(settings) {
    return settings.customDelayEnabled ? Math.round(Math.min(10000, Math.max(0, Number(settings.customDelayMs) || 0))) : 0;
  }

  function requestRowQuote(token) {
    return new Promise((resolve) => {
      const requestId = makeId();
      const receive = (event) => {
        let detail; try { detail = JSON.parse(event.detail); } catch { return; }
        if (detail.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("paper-terminal:row-quote", receive);
        resolve(detail.quote);
      };
      const timer = setTimeout(() => { window.removeEventListener("paper-terminal:row-quote", receive); resolve(null); }, 100);
      window.addEventListener("paper-terminal:row-quote", receive);
      window.dispatchEvent(new CustomEvent("paper-terminal:quote-request", { detail: JSON.stringify({ requestId, address: token.rowAddress || token.address, detail:!token.quickBuy }) }));
    });
  }

  function normalizeQuickQuote(token, row, solPrice, now = Date.now()) {
    return TradeTerminalSettings.normalizeQuote(token,row,solPrice,now);
  }

  function marketQuickQuote(token, response, now = Date.now()) {
    const pair = response?.pair;
    const address = token.rowAddress || token.address;
    const at = Number(response?.observedAt);
    if (!response?.ok || response.address !== address || !(at > 0) || now-at > 3000 || at > now+100 || pair?.chainId !== token.chain) return null;
    if (!sameToken(token,{chain:pair.chainId,address:pair.baseToken?.address,altAddress:pair.pairAddress})) return null;
    const price = Number(pair.priceUsd);
    if (!(price > 0) || !Number.isFinite(price)) return null;
    return withCanonicalAddress({...token,price,priceUpdatedAt:at,source:pair.source || "dexscreener",
      supply:Number(pair.supply) || Number(pair.fdv || pair.marketCap)/price || token.supply,
      marketCap:Number(pair.fdv || pair.marketCap) || 0,
      liquidity:Number(pair.liquidity?.usd) || token.liquidity,
      symbol:pair.baseToken?.symbol || token.symbol,name:pair.baseToken?.name || token.name,
      quickBuy:true,rowAddress:address},pair);
  }

  async function freshTradeQuote(token) {
    if (token.quickBuy) {
      const route = token.clickedRow?.route || location.href, epoch = tradeEpoch;
      let row = route===location.href ? await requestRowQuote(token) : token.clickedRow;
      if (!row || row.address !== (token.rowAddress || token.address)) throw new Error("Token row unavailable or moved. No order placed.");
      token.quickOrderPinned=true;
      const clickedRow=row;
      const reread=()=>location.href===route?requestRowQuote(token):Promise.resolve(clickedRow);
      let quote = normalizeQuickQuote(token, row, state.settings.solPrice);
      if (quote && token.source !== "onchain") return quote;
      // Brand-new launches may have a live cap before any price aggregator
      // indexes them. Read their actual mint supply; never assume 1B tokens.
      const mint = row.mint || token.mint;
      const hasCap = Number(row.displayedMarketCap) > 0 || Number(row.marketCap) > 0 || Number(row.marketCapNative) > 0;
      const validateRow = async () => {
        if (!isEnabled() || epoch !== tradeEpoch) throw new Error("Trading is off. Order cancelled.");
        const latest = await reread();
        if (!latest || latest.address !== (token.rowAddress || token.address) || (latest.mint && mint && latest.mint !== mint)) throw new Error("Token row changed. Order cancelled.");
        return latest;
      };
      // Independent sources race. A slow supply RPC must not hold a usable
      // launch/market quote hostage; neither path is allowed to invent supply.
      const candidates = [];
      if (mint && token.chain === "solana" && hasCap && !(Number(row.supply) > 0) && !(Number(token.supply) > 0)) {
        candidates.push((async () => {
          const supply = await chrome.runtime.sendMessage({type:"FETCH_TOKEN_SUPPLY",mint});
          if (!supply?.ok || supply.mint!==mint || !(Number(supply.supply)>0) || !(Number(supply.observedAt)>0) || Date.now()-Number(supply.observedAt)>=15000 || Number(supply.observedAt)>Date.now()+100) throw new Error('Supply unavailable');
          return normalizeQuickQuote({...token,supply:Number(supply.supply)},await validateRow(),state.settings.solPrice);
        })());
      }
      let response;
      candidates.push((async () => {
        response = await chrome.runtime.sendMessage({type:"FETCH_TRADE_QUOTE",address:token.rowAddress || token.address,mint,chain:token.chain,solPrice:state.settings.solPrice});
        const latest = await validateRow(), market = marketQuickQuote(token,response);
        return market?.source==='onchain' ? market : normalizeQuickQuote(token,latest,state.settings.solPrice) || market;
      })());
      quote = await Promise.any(candidates.map(p=>p.then(value=>{if(!value)throw new Error('Quote unavailable');return value;}))).catch(()=>null);
      if (!isEnabled() || epoch !== tradeEpoch) throw new Error("Trading is off. Order cancelled.");
      // The original row must still belong to this token after the network
      // round-trip. A tracker, removed row or recycled card cannot receive it.
      if (quote) return quote;
      row = await validateRow();
      // A new listing may receive its first terminal tick before aggregators
      // index it. Give the live list feed a short, bounded acquisition window.
      for (let attempt=0;attempt<3;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,200));
        if (!isEnabled() || epoch !== tradeEpoch) throw new Error("Order cancelled.");
        row = await reread();
        if (!row || row.address !== (token.rowAddress || token.address)) throw new Error("Token row changed. Order cancelled.");
        quote = normalizeQuickQuote(token,row,state.settings.solPrice);
        if (quote) return quote;
      }
      throw new Error(response?.error ? "Live row and market quote unavailable. " + response.error : "No live price from the token row, list feed or market lookup. No order placed.");
    }
    const detailToken={...token,rowAddress:extractAddressFromUrl() || token.address,quickBuy:false};
    let rowQuote = await requestRowQuote(detailToken);
    let detailQuote = normalizeQuickQuote(detailToken,rowQuote,state.settings.solPrice);
    const unchangedDetail = detailQuote && JSON.stringify([location.href,detailQuote.price,detailQuote.supply,detailQuote.marketCap,rowQuote.quoteSource==='row-feed'?rowQuote.priceObservedAt:0]) === lastDetailQuote;
    if (unchangedDetail && rowQuote.quoteSource!=='detail-cap' && sameToken(currentToken,token) && currentToken.source==='chart' && currentToken.price>0 && Date.now()-currentToken.priceUpdatedAt<3500) return {...token,...currentToken,quickBuy:false};
    if (!detailQuote && rowQuote?.mint && token.chain === "solana" && (rowQuote.marketCap>0 || rowQuote.marketCapNative>0 || rowQuote.displayedMarketCap>0)) {
      const supply = await chrome.runtime.sendMessage({type:"FETCH_TOKEN_SUPPLY",mint:rowQuote.mint}).catch(()=>null);
      rowQuote = await requestRowQuote(detailToken);
      if (supply?.ok && supply.mint===rowQuote?.mint && Date.now()-Number(supply.observedAt)<15000) detailQuote=normalizeQuickQuote({...detailToken,supply:supply.supply},rowQuote,state.settings.solPrice);
    }
    if (detailQuote) return {...detailQuote,quickBuy:false};
    if (sameToken(currentToken, token) && currentToken.price > 0 && Date.now() - currentToken.priceUpdatedAt < 600) return { ...token, ...currentToken, quickBuy: false };
    if (token.price > 0 && Date.now() - (token.priceUpdatedAt || 0) < 3500 && token.source !== "unavailable") return token;
    const response = await chrome.runtime.sendMessage({ type: "FETCH_PRICE", address: token.address, mint:token.mint, chain:token.chain, fresh:true, solPrice:state.settings.solPrice });
    if (!(Number(response?.pair?.priceUsd) > 0)) throw new Error("Fresh price unavailable. No fill.");
    const pair = response.pair;
    if (!sameToken(token,{chain:pair.chainId,address:pair.baseToken?.address,altAddress:pair.pairAddress})) throw new Error("Quote belongs to a different token. No fill.");
    return withCanonicalAddress({ ...token, name:pair.baseToken?.name || token.name,symbol:pair.baseToken?.symbol || token.symbol,price: Number(pair.priceUsd), supply: Number(pair.supply) || Number(pair.fdv || pair.marketCap) / Number(pair.priceUsd) || token.supply, marketCap: Number(pair.fdv || pair.marketCap) || token.marketCap, source: pair.source || "dexscreener", priceUpdatedAt: Number(response.observedAt) || Date.now() }, pair);
  }

  function submitTrade(side, token, amount) {
    const epoch = tradeEpoch;
    const route = token.quickBuy ? token.clickedRow?.route || location.href : location.href;
    const run = async () => {
      try {
        state = await loadState();
        if (!isEnabled() || epoch !== tradeEpoch) throw new Error("Trading is off. Order cancelled.");
        const settings = executionSettings(state.settings, side);
        const requested = await freshTradeQuote(token);
        const delay = token.quickBuy && !settings.quickBuyDelay ? 0 : executionDelayMs(settings);
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (!isEnabled() || epoch !== tradeEpoch) throw new Error("Trading is off. Order cancelled.");
        let quote = !delay && Date.now()-requested.priceUpdatedAt<600 ? requested : await freshTradeQuote(requested);
        if (token.quickBuy && route===location.href) {
          const row=await requestRowQuote(token);
          if (!row || row.address!==(token.rowAddress || token.address) || (row.mint && !sameToken(quote,{address:row.mint,chain:quote.chain}))) throw new Error("Token row changed. Order cancelled.");
          const latest=normalizeQuickQuote(quote,row,state.settings.solPrice);
          if (latest && ["row-props","row-feed"].includes(quote.source)) quote=latest;
        }
        state = await loadState();
        if (!isEnabled() || epoch !== tradeEpoch || (route!==location.href && !(token.quickBuy && token.quickOrderPinned))) throw new Error("Trading page changed or is off. Order cancelled.");
        const base = state;
        quote={...quote};delete quote.clickedRow;delete quote.quickOrderPinned;
        // Terms are locked at order submission, even if the user edits a preset.
        const tradingState = { ...base, settings: { ...base.settings, ...settings, executionPresets: [] } };
        const result = side === "buy"
          ? executeBuy(tradingState, { ...quote, requestedPrice: requested.price }, amount)
          : executeSell(tradingState, { ...quote, requestedPrice: requested.price }, amount);
        if (!result.ok) return result;
        result.state.settings = base.settings;
        const commit = await chrome.runtime.sendMessage({
          type: "COMMIT_TRADE", terminal: detectSiteId(),
          baseFillId: base.fills[0]?.id || null, baseFillCount: base.fills.length, baseBalance: base.balanceUsd,
          balanceUsd: result.state.balanceUsd, positions: result.state.positions, fills: result.state.fills,
        });
        if (!commit?.ok) throw new Error(commit?.message || "Order could not be saved. Please retry.");
        state = normalizeState(commit.state);
        if (sameToken(currentToken, quote)) currentToken = TradeTerminalSettings.mergeToken(currentToken,quote,{quickBuy:false});
        if (isEnabled() && !resizeSession && !dragging) renderPanel();
        scheduleChartUpdate();
        return result;
      } catch (error) {
        return { ok: false, message: error.message || "Trade failed. No fill." };
      }
    };
    const pending = tradeQueue.then(run, run);
    tradeQueue = pending.catch(() => {});
    return pending;
  }

  async function handlePresetBuy(preset) {
    if (!isEnabled() || !isDetailPage() || !preset) return;
    if (preset.confirm && !confirm(`Confirm ${solNumber(toUsd(preset.value, preset.unit, state.settings.solPrice))} SOL buy?`)) return;
    const result = await submitTrade("buy", { ...currentToken, quickBuy: false }, toUsd(preset.value, preset.unit, state.settings.solPrice));
    showToast(result.message, !result.ok);
  }

  async function handlePresetSell(percent) {
    if (!isEnabled() || !isDetailPage()) return;
    const result = await submitTrade("sell", { ...currentToken, quickBuy: false }, percent);
    showToast(result.message, !result.ok);
  }

  function renderPanel(force = false) {
    if (!isEnabled() || resizeSession || dragging) return;
    const shadow = document.getElementById(ROOT_ID)?.shadowRoot;
    if (!shadow) return;
    if (!force && (amountDraft || executionEditorOpen || mainPaneOpen) && shadow.querySelector(".wrap")) return;

    const position = currentPosition();
    const amounts = panelAmountPresets(state.settings);
    const presets = amountDraft?.buys || amounts.buys;
    const sellPresets = amountDraft?.sells || amounts.sells;
    const exec = executionSettings(state.settings, executionEditorSide);
    const buyExec = executionSettings(state.settings, "buy");
    const flatExecutionUsd = (buyExec.networkFeeSol + buyExec.priorityFeeSol + buyExec.mevBribeSol) * state.settings.solPrice;
    const displayUnit = state.settings.instantTradeUnit === "USD" ? "USD" : "SOL";

    const termsRow = (side) => {
      const terms = executionSettings(state.settings, side);
      const gas = terms.networkFeeSol + terms.priorityFeeSol;
      return `<div class="terms ${side}-terms"><span title="Slippage tolerance: ${Math.round(terms.slippageBps / 100)}%">${uiIcon("slip")}<b>${Math.round(terms.slippageBps / 100)}%</b></span><span title="Base + priority gas: ${gas} SOL">${uiIcon("gas")}<b>${Number(gas.toFixed(6))}</b></span><span class="bribe" title="Bribe: ${terms.mevBribeSol} SOL">${uiIcon("bribe")}<b>${Number(terms.mevBribeSol.toFixed(6))}</b></span><button class="terms-edit" data-side="${side}" title="Edit ${side} execution settings" aria-label="Edit ${side} execution settings">${uiIcon("edit")}</button></div>`;
    };
    const cycles=TradeTerminalSettings.tradeCycles(TradeTerminalSettings.tokenGroups(state).find(g=>sameToken(g.token,currentToken))?.fills || []);
    const completed=cycles.filter(c=>c.fills.at(-1)?.side==='sell' && c.fills.reduce((sum,f)=>sum+(f.side==='buy'?1:-1)*Number(f.quantity),0)<=Math.max(1e-12,c.fills.filter(f=>f.side==='buy').reduce((sum,f)=>sum+Number(f.quantity),0)*1e-12)).at(-1);
    shadow.innerHTML = `<style>${STYLES}.main-pane{padding:18px 12px;font-size:14px;display:grid;gap:18px}.main-pane[hidden]{display:none}.main-pane label{display:flex;gap:10px;align-items:center}.main-pane button{padding:10px;background:#ffffff12;color:var(--text);border:1px solid #ffffff25;border-radius:8px}.settings-open .body{display:none}.main-pane input{accent-color:#38d5a7}.main-pane button:disabled{opacity:.45}.quick-amount-field{display:flex;align-items:center;gap:7px}.quick-amount-field input{text-align:right}.quick-amount-field span{color:var(--muted);font-size:12px;font-weight:700}</style><section class="wrap ${mainPaneOpen?'settings-open':''} ${panelExpanded ? "" : "collapsed"} ${amountDraft ? "editing-amounts" : ""}" role="region" aria-label="ScanPNL overlay">
      <header class="head">${uiIcon("grid")}${state.settings.executionPresets.map((profile) =>
        `<button class="preset ${profile.id === state.settings.activeExecutionPreset ? "active" : ""}" data-execution-profile="${escapeHtml(profile.id)}" ${amountDraft || executionEditorOpen ? "disabled" : ""} title="${escapeHtml(profile.label)} buy and sell execution settings">${escapeHtml(profile.label)}</button>`).join("")}
        <span class="grow"></span><button class="icon ${amountDraft ? "edit-active" : ""}" id="tune" title="${amountDraft ? "Save buy and sell amounts (Enter)" : "Edit buy and sell amounts"}" aria-label="${amountDraft ? "Save amounts" : "Edit amounts"}">${uiIcon(amountDraft ? "check" : "edit")}</button><button class="icon" id="dash" title="Instant Trade settings" aria-label="Instant Trade settings">${uiIcon("gear")}</button><button class="icon" id="toggle" aria-label="${panelExpanded ? "Collapse" : "Expand"}">${panelExpanded ? "×" : "+"}</button>
      </header>
      <div class="main-pane" ${mainPaneOpen?'':'hidden'}>
        <strong>Instant Trade settings</strong>
        <label><input id="quick-enabled" type="checkbox" ${state.settings.trenchesQuickBuy?'checked':''}>Quick Buy on trenches</label>
        <label>Quick Buy amount<span class="quick-amount-field"><input id="quick-amount" type="number" min="0.000001" step="0.01" inputmode="decimal" aria-label="Quick Buy amount in SOL" value="${escapeHtml(String(quickBuySolAmount(state.settings)))}"><span>SOL</span></span></label>
        <label>PNL<select id="pnl-mode"><option value="cumulative" ${state.settings.pnlMode!=='reset'?'selected':''}>Keep previous PNL</option><option value="reset" ${state.settings.pnlMode==='reset'?'selected':''}>Reset on each buy</option></select></label>
        <label><input id="custom-delay" type="checkbox" ${state.settings.customDelayEnabled?'checked':''}>Custom execution delay</label>
        <label>Delay (ms)<input id="delay-ms" type="number" min="0" max="10000" step="1" value="${state.settings.customDelayMs}" ${state.settings.customDelayEnabled?'':'disabled'}></label>
        <label><input id="quick-delay" type="checkbox" ${state.settings.quickBuyDelay?'checked':''}>Apply delay to Quick Buy</label>
        <label>After Quick Buy<select id="quick-action"><option value="new-tab" ${state.settings.quickBuyAction==='new-tab'?'selected':''}>Open in new tab</option><option value="chart" ${state.settings.quickBuyAction==='chart'?'selected':''}>Jump to chart</option><option value="none" ${state.settings.quickBuyAction==='none'?'selected':''}>Do nothing</option></select></label>
        <div class="settings-execution"><button data-settings-side="buy">Buy slippage and fees</button><button data-settings-side="sell">Sell slippage and fees</button></div>
        <button id="trade-card" ${completed?'':'disabled'}>Create completed trade P&amp;L card</button>
        <button id="settings-done">Done</button>
      </div>
      <div class="body">
        <div class="exec-editor" ${executionEditorOpen ? "" : "hidden"} aria-label="${escapeHtml(exec.label)} ${executionEditorSide} execution settings"><span style="grid-column:1/-1">${escapeHtml(exec.label)} · ${executionEditorSide.toUpperCase()} settings</span>
          <label>Slippage %<input data-exec-field="slippageBps" type="number" min="0" max="100" step="1" inputmode="numeric" value="${Math.round(exec.slippageBps / 100)}"></label>
          <label>Gas (SOL)<input data-exec-field="gasTotalSol" type="number" min="0" max="0.5" step="0.0001" value="${exec.networkFeeSol + exec.priorityFeeSol}"></label>
          <label>Bribe (SOL)<input data-exec-field="mevBribeSol" type="number" min="0" max="0.5" step="0.0001" value="${exec.mevBribeSol}"></label>
          <button id="apply-execution" type="button" class="preset save">Save ${executionEditorSide} settings</button>
        </div>
        <div class="label"><span class="buy-label">Buy</span><span class="balance" title="Available SOL">${solIcon()}<span id="cash-sol">${solNumber(state.balanceUsd)}</span></span></div>
        <div class="grid" title="Resize taller to show more buy amounts">${presets.map((preset, index) => {
          const usd = toUsd(preset.value, preset.unit, state.settings.solPrice);
          if (amountDraft) return `<label class="amount-cell buy-amount ${index >= 4 ? "extra-amount" : ""}"><input data-amount-side="buy" data-amount-index="${index}" aria-label="Buy amount ${index + 1} in SOL" inputmode="decimal" type="text" value="${escapeHtml(amountDraft.buys[index].amount)}"></label>`;
          return `<button class="buy ${preset.primary ? "primary" : ""} ${index >= 4 ? "extra-amount" : ""}" data-buy="${escapeHtml(preset.id)}" ${usd + flatExecutionUsd > state.balanceUsd ? "disabled" : ""} title="Buy ${solNumber(usd)} SOL · ${formatUsd(usd)}">${solNumber(usd)}</button>`;
        }).join("")}</div>
        ${termsRow("buy")}
        <div class="pnl-section" role="group" aria-label="Profit and loss"><div class="pnl-result">${moneySlot("foot-pnl",displayUnit)}<span id="pnl-percent" class="pnl-percent"></span></div></div>
        <div class="label"><span class="sell-label">Sell <span class="muted" style="font-size:12px">%</span><button class="unit-switch" data-display-unit="${displayUnit === "USD" ? "SOL" : "USD"}" title="Switch bought, sold, held and P&L to ${displayUnit === "USD" ? "SOL" : "USD"} — buys and the token balance stay in SOL" aria-label="Show position amounts in ${displayUnit === "USD" ? "SOL" : "USD"}">${uiIcon("swap")}<small>${displayUnit === "USD" ? "$" : "SOL"}</small></button></span><span class="holding-summary" title="Tokens held and their current SOL value"><span class="quantity" id="held-tokens"></span><span class="muted">·</span>${moneySlot("held-sol")}</span></div>
        <div class="sellgrid" title="Resize taller to show more sell amounts">${sellPresets.map((pct, index) => amountDraft ? `<label class="amount-cell sell-amount ${index >= 4 ? "extra-amount" : ""}"><input data-amount-side="sell" data-amount-index="${index}" aria-label="Sell percentage ${index + 1}" inputmode="decimal" type="text" value="${escapeHtml(amountDraft.sells[index])}"></label>` : `<button class="sell ${index >= 4 ? "extra-amount" : ""}" data-sell="${pct}" ${position?.quantity ? "" : "disabled"}>${pct}%</button>`).join("")}</div>
        ${termsRow("sell")}
        <div class="foot"><span title="Bought · ${displayUnit}" aria-label="Bought">${moneySlot("foot-bought", displayUnit)}</span><span title="Sold · ${displayUnit}" aria-label="Sold">${moneySlot("foot-sold", displayUnit)}</span><span title="Holding · ${displayUnit}" aria-label="Holding">${moneySlot("foot-mcap", displayUnit)}</span></div>
      </div>
      <div class="toast" role="status" aria-live="polite"></div>
      <i class="resize-grip" data-corner="tl"></i><i class="resize-grip" data-corner="tr"></i><i class="resize-grip" data-corner="bl"></i><i class="resize-grip" data-corner="br" title="Resize Instant Trade"></i>
    </section>`;

    shadow
      .querySelectorAll("[data-buy]")
      .forEach((btn) => (btn.onclick = () => handlePresetBuy(presets.find((p) => p.id === btn.dataset.buy))));
    shadow
      .querySelectorAll("[data-sell]")
      .forEach((btn) => (btn.onclick = () => handlePresetSell(Number(btn.dataset.sell))));
    shadow.querySelectorAll("[data-execution-profile]").forEach((btn) => {
      btn.onclick = async () => {
        await queuePanelSettings(settings=>{settings.activeExecutionPreset=btn.dataset.executionProfile;});
        renderPanel();
      };
    });
    const slippageInput = shadow.querySelector('[data-exec-field="slippageBps"]');
    slippageInput.onkeydown = (event) => { if ([".", ",", "e", "E", "-", "+"].includes(event.key)) event.preventDefault(); };
    slippageInput.oninput = () => { if (slippageInput.value !== "") slippageInput.value = String(wholeSlippageBps(Number(slippageInput.value) * 100) / 100); };
    slippageInput.onchange = () => { slippageInput.value = String(wholeSlippageBps(Number(slippageInput.value) * 100) / 100); };
    const saveExecution = async (close = true) => {
      const side = executionEditorSide;
      const presetId = state.settings.activeExecutionPreset;
      const route = location.href;
      const inputs = [...shadow.querySelectorAll("[data-exec-field]")];
      const values = Object.fromEntries(inputs.map(input => [input.dataset.execField, Number(input.value)]));
      if (inputs.some(input => !input.value.trim()) || !Object.values(values).every(Number.isFinite) || values.slippageBps < 0 || values.slippageBps > 100 || values.gasTotalSol < 0 || values.gasTotalSol > .5 || values.mevBribeSol < 0 || values.mevBribeSol > .5) { if(close)showToast("Enter valid slippage, gas and bribe amounts.", true);return; }
      try {
        await queuePanelSettings(settings => {
        const preset = settings.executionPresets.find(item => item.id === presetId);
        if (!preset) return;
        const networkFeeSol = Math.min(0.000005, values.gasTotalSol);
        preset[side] = {slippageBps: wholeSlippageBps(values.slippageBps * 100), networkFeeSol,
          priorityFeeSol: values.gasTotalSol - networkFeeSol, mevBribeSol: values.mevBribeSol};
        });
        if(close && route===location.href){executionEditorOpen = false;renderPanel(true);}
      } catch { showToast("Settings could not be saved. Please retry.", true); }
    };
    shadow.querySelector("#apply-execution").onclick = () => saveExecution();
    shadow.querySelector('.exec-editor').addEventListener('input', () => saveExecution(false),true);
    shadow.querySelector('.exec-editor').addEventListener('change', () => saveExecution(false),true);
    shadow.querySelector(".exec-editor").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); saveExecution(); }
      if (event.key === "Escape") { event.preventDefault(); executionEditorOpen = false; renderPanel(true); }
    });
    const saveAmounts = async (close = true) => {
      if (!amountDraft) return;
      const draft = structuredClone(amountDraft), route = location.href;
      try {
        // Partial numeric input stays editable; persist every valid snapshot.
        try { TradeTerminalSettings.editedAmounts(state.settings,draft); }
        catch(error){if(close)throw error;return;}
        await queuePanelSettings(settings=>Object.assign(settings,TradeTerminalSettings.editedAmounts(settings,draft)));
        if(close && route===location.href){amountDraft=null;renderPanel(true);}
      } catch (error) { showToast(error.message || "Amounts could not be saved.", true); }
    };
    shadow.querySelectorAll("[data-amount-side]").forEach(input => {
      input.oninput = () => {
        const index = Number(input.dataset.amountIndex);
        if (input.dataset.amountSide === "buy") amountDraft.buys[index].amount = input.value;
        else amountDraft.sells[index] = input.value;
        saveAmounts(false);
      };
      input.onkeydown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); saveAmounts(); }
        if (event.key === "Escape") { event.preventDefault(); amountDraft = null; renderPanel(true); }
      };
    });
    shadow.querySelectorAll("[data-display-unit]").forEach((btn) => {
      btn.onclick = async () => {
        await queuePanelSettings(settings=>{settings.instantTradeUnit=btn.dataset.displayUnit;});
        renderPanel();
      };
    });
    shadow.querySelector("#tune").onclick = () => {
      if (amountDraft) return saveAmounts();
      mainPaneOpen = false;
      executionEditorOpen = false;
      amountDraft = {
        buys: presets.map(preset => {const value = String(Number((toUsd(preset.value, preset.unit, state.settings.solPrice) / state.settings.solPrice).toPrecision(12))); return {...preset, amount:value, initialAmount:value};}),
        sells: sellPresets.map(String),
      };
      renderPanel(true);
      shadow.querySelector('[data-amount-side="buy"]')?.focus();
    };
    shadow.querySelectorAll(".terms-edit").forEach((button) => (button.onclick = () => {
      if (amountDraft) return;
      executionEditorSide = button.dataset.side;
      executionEditorOpen = true;
      renderPanel(true);
    }));
    shadow.querySelector("#toggle").onclick = () => {
      panelExpanded = !panelExpanded;
      renderPanel(true);
    };
    shadow.querySelector("#dash").onclick = () => {mainPaneOpen=!mainPaneOpen;panelExpanded=true;executionEditorOpen=false;amountDraft=null;renderPanel(true);};
    const saveMainSettings = async (nextSide, close = true) => {
      const route = location.href;
      const delayInput = shadow.querySelector('#delay-ms');
      const delay = Number(delayInput.value);
      if (!delayInput.value.trim() || !Number.isInteger(delay) || delay < 0 || delay > 10000) { if(close)showToast('Delay must be between 0 and 10000 ms.', true);return; }
      const quickAmountInput = shadow.querySelector('#quick-amount');
      const quickBuyAmountSol = Number(quickAmountInput.value);
      if (!quickAmountInput.value.trim() || !Number.isFinite(quickBuyAmountSol) || quickBuyAmountSol <= 0) { if(close)showToast('Quick Buy amount must be greater than 0 SOL.', true);return; }
      const values = {
        trenchesQuickBuy: shadow.querySelector('#quick-enabled').checked,
        quickBuyAmountSol,
        pnlMode: shadow.querySelector('#pnl-mode').value,
        customDelayEnabled: shadow.querySelector('#custom-delay').checked,
        customDelayMs: delay,
        quickBuyDelay: shadow.querySelector('#quick-delay').checked,
        quickBuyAction: shadow.querySelector('#quick-action').value,
      };
      try {
        await queuePanelSettings(settings=>{
          Object.assign(settings, values);
        });
        if(close && route===location.href){
          mainPaneOpen=false;
          if (nextSide) { executionEditorSide=nextSide;executionEditorOpen=true; }
          renderPanel(true);
        }
      } catch { showToast('Settings could not be saved. Please retry.', true); }
    };
    shadow.querySelector('#settings-done').onclick = () => saveMainSettings();
    shadow.querySelector('#custom-delay').onchange = event => { shadow.querySelector('#delay-ms').disabled=!event.target.checked; };
    shadow.querySelectorAll('[data-settings-side]').forEach(button=>{button.onclick=()=>saveMainSettings(button.dataset.settingsSide);});
    shadow.querySelector('.main-pane').addEventListener('keydown',event=>{if(event.key==='Enter' && event.target.tagName!=='BUTTON'){event.preventDefault();event.stopPropagation();saveMainSettings();}});
    shadow.querySelector('.main-pane').addEventListener('input',()=>saveMainSettings(undefined,false),true);
    shadow.querySelector('.main-pane').addEventListener('change',()=>saveMainSettings(undefined,false),true);
    shadow.querySelector("#trade-card").onclick = () => {if(completed)chrome.runtime.sendMessage({type:"OPEN_PNL_CARD",fillId:completed.fills[0].id});};
    const wrap = shadow.querySelector(".wrap");
    const savedSize = state.settings.instantTradeSizes?.[detectSiteId()];
    fitPanelSize(wrap, savedSize?.width || savedSize?.w || 340, savedSize?.height || savedSize?.h);
    const savedPosition = state.settings.instantTradePositions?.[detectSiteId()];
    if (!panelPosition && savedPosition) {
      panelPosition = {
        left: Math.max(0, Math.min(window.innerWidth - wrap.offsetWidth, savedPosition.x * Math.max(1, window.innerWidth - wrap.offsetWidth))),
        top: Math.max(0, Math.min(window.innerHeight - wrap.offsetHeight, savedPosition.y * Math.max(1, window.innerHeight - wrap.offsetHeight))),
      };
    }
    if (!panelPosition) panelPosition = {left: Math.round((window.innerWidth - wrap.offsetWidth) / 2), top: Math.round((window.innerHeight - wrap.offsetHeight) / 2)};
    if (panelPosition) {
      panelPosition.left = Math.max(0, Math.min(window.innerWidth - wrap.offsetWidth, panelPosition.left));
      panelPosition.top = Math.max(0, Math.min(window.innerHeight - wrap.offsetHeight, panelPosition.top));
      wrap.style.left = `${Math.round(panelPosition.left)}px`;
      wrap.style.top = `${Math.round(panelPosition.top)}px`;
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
      wrap.style.transform = "none";
    }
    makeDraggable(shadow.querySelector(".head"), wrap);
    makeResizable(wrap, shadow.querySelectorAll("[data-corner]"));
    updateLiveMetrics();
    publishChartModel();
  }

  function updateLiveMetrics() {
    if (!isEnabled()) return;
    const shadow = document.getElementById(ROOT_ID)?.shadowRoot;
    if (!shadow || !currentToken) return;
    const position = currentPosition();
    const { totalPnl, pnlPercent } = positionMetrics(position);
    const age = Date.now() - (currentToken.priceUpdatedAt || 0);
    const sourceNames = { "site-feed": "SITE FEED", chart: "CHART", dexscreener: "MARKET", page: "PAGE", demo: "NO QUOTE", unavailable: "NO QUOTE" };
    const fresh = currentToken.price > 0 && !["demo", "unavailable"].includes(currentToken.source) && age < 5000;
    const setText = (selector, value) => {
      const element = shadow.querySelector(selector);
      if (element && element.textContent !== value) element.textContent = value;
    };
    setText("#live-price", formatTokenPrice(currentPrice()));
    const source = shadow.querySelector("#live-source");
    if (source) {
      source.textContent = `● ${sourceNames[currentToken.source] || "LIVE"}${fresh ? "" : " · STALE"}`;
      source.classList.toggle("stale", !fresh);
    }
    setText("#sell-market-cap", formatCompactUsd(currentToken.marketCap || 0));
    setText("#stat-remaining", formatUsd((position?.quantity || 0) * currentPrice()));
    setText("#stat-total", formatUsd(totalPnl));
    const statTotal = shadow.querySelector("#stat-total");
    if (statTotal) statTotal.className = `sv ${totalPnl >= 0 ? "pos" : "neg"}`;
    const holdingUsd = (position?.quantity || 0) * currentPrice();
    setText("#cash-sol", solNumber(state.balanceUsd));
    const namedToken=TradeTerminalSettings.mergeToken(position?.token,currentToken);
    const holdingName=[namedToken.name,namedToken.symbol].find(value=>value && !/^(TOKEN|unknown)$/i.test(value)) || `${currentToken.address.slice(0,4)}…${currentToken.address.slice(-4)}`;
    setText("#held-tokens", `${(position?.quantity || 0).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 })} ${holdingName}`);
    setText("#held-sol .number", solNumber(holdingUsd));
    const amount = (usd) => state.settings.instantTradeUnit === "USD" ? formatUsd(usd) : solNumber(usd);
    setText("#foot-bought .number", amount(position?.investedUsd || position?.costBasis || 0));
    setText("#foot-sold .number", amount(position?.soldUsd || 0));
    setText("#foot-mcap .number", amount(holdingUsd));
    const footPnl = shadow.querySelector("#foot-pnl");
    if (footPnl) {
      footPnl.className = `value ${totalPnl >= 0 ? "pos" : "neg"}`;
      const amount = state.settings.instantTradeUnit === "USD" ? formatUsd(totalPnl) : solNumber(totalPnl);
      setText("#foot-pnl .number", `${totalPnl >= 0 ? "+" : ""}${amount}`);
      setText("#pnl-percent", `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%`);
      const percent=shadow.querySelector("#pnl-percent");if(percent)percent.className=`pnl-percent ${totalPnl>=0?"pos":"neg"}`;
      const pnlSection=shadow.querySelector(".pnl-section");
      pnlSection?.classList.toggle("stale",!fresh && !!position?.quantity);
      pnlSection?.classList.toggle("gain",totalPnl>0);
      pnlSection?.classList.toggle("loss",totalPnl<0);
      footPnl.title = `${state.settings.instantTradeUnit === "USD" ? "USD" : "SOL"} P&L${fresh ? "" : " · stale quote"}`;
    }
    const panel = shadow.querySelector(".wrap");
    if (panel && !resizeSession && !dragging) reclampPanel();
    publishLiveQuote();
  }

  let lastPublishedPriceAt = 0;
  function publishLiveQuote() {
    if (!isEnabled() || !currentToken?.price || Date.now() - currentToken.priceUpdatedAt > 3500 || Date.now() - lastPublishedPriceAt < 250) return;
    if (!["site-feed", "chart", "page"].includes(currentToken.source)) return;
    lastPublishedPriceAt = Date.now();
    chrome.runtime.sendMessage({ type: "PUBLISH_PRICE", token: currentToken }).catch(() => {});
  }

  function showToast(message, isError = false) {
    const toast = document
      .getElementById(ROOT_ID)
      ?.shadowRoot?.querySelector(".toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${isError ? "bad" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.className = "toast"), 3200);
  }

  function makeDraggable(handle, panel) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || event.target.closest("button") || resizeSession) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      dragging = true;
      panel.style.transform = "none";
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;

      const move = (moveEvent) => {
        const left = Math.max(
          0,
          Math.min(window.innerWidth - panel.offsetWidth, originLeft + moveEvent.clientX - startX)
        );
        const top = Math.max(
          0,
          Math.min(window.innerHeight - panel.offsetHeight, originTop + moveEvent.clientY - startY)
        );
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panelPosition = { left, top };
      };
      const stop = async () => {
        dragging = false;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", stop, true);
        document.removeEventListener("pointercancel", stop, true);
        if (panelPosition) {
          state = await loadState();
          const maxLeft = Math.max(1, window.innerWidth - panel.offsetWidth);
          const maxTop = Math.max(1, window.innerHeight - panel.offsetHeight);
          state.settings.instantTradePositions = {
            ...state.settings.instantTradePositions,
            [detectSiteId()]: {
              x: Math.max(0, Math.min(1, panelPosition.left / maxLeft)),
              y: Math.max(0, Math.min(1, panelPosition.top / maxTop)),
            },
          };
          saveState(state);
        }
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", stop, true);
      document.addEventListener("pointercancel", stop, true);
    };
  }

  // Additional quick amounts are a view of the saved presets, never a rewrite
  // of them. Custom amounts remain available in the taller layout.
  function panelAmountPresets(settings) {
    const buys = settings.buyPresets.map((preset) => ({ ...preset }));
    for (const value of [0.01, 0.025, 0.03, 0.04, 0.1, 0.25, 0.5, 1]) {
      if (buys.length >= 8) break;
      if (buys.some((p) => Math.abs(toUsd(p.value, p.unit, settings.solPrice) / settings.solPrice - value) < 1e-8)) continue;
      buys.push({ id: `quick-sol-${value}`, value, unit: "SOL", primary: false, confirm: false });
    }
    const savedSells = [...new Set(settings.sellPresets.filter((pct) => Number.isFinite(pct) && pct > 0 && pct <= 100))];
    // Keep a full exit available even in the one-row layout.
    const firstSells = savedSells.filter((pct) => pct !== 100).slice(0, 3);
    const sells = settings.amountLayoutVersion === 1 ? [...settings.sellPresets] : [...firstSells, 100, ...savedSells.filter((pct) => pct !== 100 && !firstSells.includes(pct))];
    for (const pct of [5, 15, 20, 75, 10, 25, 50, 90]) {
      if (sells.length >= 8) break;
      if (!sells.includes(pct)) sells.push(pct);
    }
    return { buys, sells };
  }

  function panelContentHeight(panel, rows = 1) {
    const headerHeight = panel.querySelector(".head").offsetHeight;
    if (panel.classList.contains("collapsed")) return headerHeight;
    const body = panel.querySelector(".body");
    const bodyStyle = getComputedStyle(body);
    let height = headerHeight + parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom) + 2;
    // Measure fixed content and the MINIMUM button rows, never stretched grid
    // heights. A full-window panel must still shrink all the way back down.
    for (const child of body.children) {
      if (child.hidden) continue;
      const style = getComputedStyle(child);
      height += parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      if (child.matches(".grid,.sellgrid")) {
        height += rows * parseFloat(getComputedStyle(panel).getPropertyValue("--button-min-height")) + (rows - 1) * parseFloat(style.rowGap);
      } else height += child.getBoundingClientRect().height;
    }
    return Math.ceil(height);
  }

  function animateAmountSplit(panel, before, expanded) {
    if (!panel.animate || state.settings.reducedMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const selector of [".grid", ".sellgrid"]) {
      const grid=panel.querySelector(selector), cells=[...grid.children];
      for(let index=0;index<cells.length;index++) {
        const cell=cells[index];
        if (!expanded && index>=4) continue;
        const after=cell.getBoundingClientRect();
        const from=before.get(cell) || before.get(cells[index%4]);
        if(!from || !after.width || !after.height)continue;
        cell.getAnimations().forEach(animation=>animation.cancel());
        cell.animate([
          {transformOrigin:"0 0",transform:`translate(${from.left-after.left}px,${from.top-after.top}px) scale(${from.width/after.width},${from.height/after.height})`,opacity:before.has(cell)?1:0},
          {transformOrigin:"0 0",transform:"translate(0,0) scale(1,1)",opacity:1}
        ],{duration:300,delay:expanded && index>=4 ? (index%4)*20 : 0,easing:"cubic-bezier(.2,.8,.2,1)"});
      }
    }
  }

  function fitPanelSize(panel, width, height) {
    const maxWidth = Math.max(1, window.innerWidth - 8);
    const maxHeight = Math.max(1, window.innerHeight - 8);
    const minWidth = Math.min(310, maxWidth);
    const sizedWidth = Math.max(minWidth, Math.min(maxWidth, Math.round(width || 340)));
    panel.style.minWidth = `${minWidth}px`;
    panel.style.width = `${sizedWidth}px`;
    if (panel.classList.contains("collapsed")) {
      panel.style.minHeight = "40px";
      return { width: sizedWidth, height: Math.min(40, maxHeight) };
    }
    if (panel.classList.contains('settings-open')) {
      const settingsHeight = Math.min(maxHeight, Math.max(420, Number(height) || 560));
      panel.style.minHeight = `${Math.min(300,maxHeight)}px`;
      panel.style.height = `${settingsHeight}px`;
      return {width:sizedWidth,height:settingsHeight};
    }
    const compactMinimum = panelContentHeight(panel, 1);
    const expandedRows = Math.max(2, Math.ceil(Math.max(panel.querySelector(".grid").children.length, panel.querySelector(".sellgrid").children.length) / 4));
    const expandedMinimum = panelContentHeight(panel, expandedRows);
    const wantedHeight = Math.min(maxHeight, Math.round(height || compactMinimum));
    const wasExpanded=panel.classList.contains("expanded-amounts");
    const rows = wantedHeight >= expandedMinimum + (wasExpanded ? -8 : 0) ? expandedRows : 1;
    const before=new Map();
    if (wasExpanded !== (rows>1) && panel.dataset.layoutReady) {
      for(const cell of panel.querySelectorAll(".buy,.sell")) if(getComputedStyle(cell).display!=="none")before.set(cell,cell.getBoundingClientRect());
    }
    panel.classList.toggle("expanded-amounts", rows > 1);
    panel.style.setProperty("--amount-rows", rows);
    panel.style.setProperty("--grid-min-height", `${rows * 36 + (rows - 1) * 6}px`);
    const minimum = Math.min(maxHeight, rows > 1 ? expandedMinimum : compactMinimum);
    const sizedHeight = Math.max(minimum, wantedHeight);
    panel.style.minHeight = `${minimum}px`;
    panel.style.height = `${sizedHeight}px`;
    if(before.size)animateAmountSplit(panel,before,rows>1);
    panel.dataset.layoutReady="1";
    return { width: sizedWidth, height: sizedHeight };
  }

  function makeResizable(panel, grips) {
    const clampSize = (width, height) => fitPanelSize(panel, width, height);

    for (const grip of grips) {
      grip.onpointerdown = (event) => {
        if (!panelExpanded || resizeSession) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = panel.getBoundingClientRect();
        const corner = grip.dataset.corner || "br";
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.transform = "none";
        resizeSession = {
          pointerId: event.pointerId,
          grip,
          corner,
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
        try { grip.setPointerCapture(event.pointerId); } catch {}

        const move = (moveEvent) => {
          if (!resizeSession) return;
          moveEvent.preventDefault();
          const dx = moveEvent.clientX - resizeSession.startX;
          const dy = moveEvent.clientY - resizeSession.startY;
          const fromLeft = corner.includes("l");
          const fromTop = corner.includes("t");
          const wantedWidth = resizeSession.width + (fromLeft ? -dx : dx);
          const wantedHeight = resizeSession.height + (fromTop ? -dy : dy);
          const size = clampSize(wantedWidth, wantedHeight);
          let left = fromLeft ? resizeSession.right - size.width : resizeSession.left;
          let top = fromTop ? resizeSession.bottom - size.height : resizeSession.top;
          left = Math.max(0, Math.min(window.innerWidth - size.width, left));
          top = Math.max(0, Math.min(window.innerHeight - size.height, top));
          panel.style.width = `${size.width}px`;
          panel.style.height = `${size.height}px`;
          panel.style.left = `${left}px`;
          panel.style.top = `${top}px`;
          panelPosition = { left, top };
        };

        const stop = async () => {
          const session = resizeSession;
          resizeSession = null;
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", stop, true);
          window.removeEventListener("pointercancel", stop, true);
          try { session?.grip.releasePointerCapture(session.pointerId); } catch {}
          if (!session) return;
          const site = detectSiteId();
          const rectNow = panel.getBoundingClientRect();
          const maxLeft = Math.max(1, window.innerWidth - rectNow.width);
          const maxTop = Math.max(1, window.innerHeight - rectNow.height);
          const latest = await loadState();
          latest.settings.instantTradeSizes = {
            ...latest.settings.instantTradeSizes,
            [site]: { width: Math.round(rectNow.width), height: Math.round(rectNow.height) },
          };
          latest.settings.instantTradePositions = {
            ...latest.settings.instantTradePositions,
            [site]: {
              x: Math.max(0, Math.min(1, rectNow.left / maxLeft)),
              y: Math.max(0, Math.min(1, rectNow.top / maxTop)),
            },
          };
          state = latest;
          await saveState(latest);
        };

        window.addEventListener("pointermove", move, { capture: true, passive: false });
        window.addEventListener("pointerup", stop, true);
        window.addEventListener("pointercancel", stop, true);
      };
    }
  }

  function reclampPanel() {
    const panel = document.getElementById(ROOT_ID)?.shadowRoot?.querySelector(".wrap");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    fitPanelSize(panel, rect.width, rect.height);
    const next = panel.getBoundingClientRect();
    if (panelPosition || next.left < 0 || next.top < 0 || next.right > innerWidth || next.bottom > innerHeight) {
      panelPosition = {
        left: Math.max(0, Math.min(window.innerWidth - next.width, next.left)),
        top: Math.max(0, Math.min(window.innerHeight - next.height, next.top)),
      };
      panel.style.left = `${panelPosition.left}px`;
      panel.style.top = `${panelPosition.top}px`;
      panel.style.transform = "none";
    }
  }

  function handleShortcut(event) {
    const target = event.composedPath?.()[0] || event.target;
    if (
      !isEnabled() || amountDraft || executionEditorOpen || !isDetailPage() || !state?.settings.shortcutsEnabled ||
      target?.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)
    ) {
      return;
    }
    const preset = state.settings.buyPresets.find((p) => p.shortcut === event.key);
    if (preset) {
      event.preventDefault();
      handlePresetBuy(preset);
    }
  }

  // Listing / "trenches" pages (Axiom Pulse, GMGN/Photon/BullX new-pairs
  // feeds, etc.) — used to decide whether to show the trenches quick-buy
  // pills vs. the single-token instant-trade overlay.
  function isListingPage() {
    if (!['axiom','terminal','gmgn','photon','bullx'].includes(detectSiteId())) return false;
    const path=location.pathname.toLowerCase(),selection=`${location.search||''}${location.hash||''}`;
    if (/(?:^|[/?#&=])(?:discover|discovery|wallet|tracker|profile)(?:[/?#&=]|$)/i.test(path+selection)) return false;
    if (/^\/(?:en\/)?(?:pulse|trenches|new-pairs|new_pairs)(?:\/|$)/.test(path)) return true;
    return path==='/' && ['gmgn','terminal'].includes(detectSiteId());

  }

  function findPageChartElement() {
    const candidates = [
      ...document.querySelectorAll(
        'canvas,iframe[src*="tradingview"],[data-testid*="chart" i],[data-chart],[class*="trading-chart" i],[class*="chart-container" i],[class*="chart" i]'
      ),
    ].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 420 && rect.height >= 220;
    });
    return candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }

  function isDetailPage() {
    const token = readPageToken();
    const path = location.pathname;
    const site = detectSiteId();
    if (/\/(?:profile|user|wallet|account|portfolio|track(?:er)?)(?:\/|$)/i.test(path)) return false;
    const matchesRoute =
      (site === "axiom" && /^\/(?:meme|t|token)\//i.test(path)) ||
      (site === "terminal" && /^\/trade\/[^/]+\//i.test(path)) ||
      (site === "gmgn" && /\/token\//i.test(path)) ||
      (site === "photon" && /\/lp\//i.test(path)) ||
      (site === "bullx" && /terminal|token|trade/i.test(path)) ||
      (site === "dexscreener" && path.split("/").filter(Boolean).length >= 2);
    return !!(token.address && (matchesRoute || (site === "unknown" && /^\/(?:token|trade)\//i.test(path) && findPageChartElement())));
  }

  function publishChartModel() {
    if (!isEnabled() || !isDetailPage() || !currentToken?.address) {
      window.dispatchEvent(new CustomEvent("paper-terminal:chart-clear"));
      return;
    }
    if(currentToken.source!=='chart')independentQuote={address:currentToken.address,price:currentToken.price,at:currentToken.priceUpdatedAt,source:currentToken.quoteSource};
    // Average chart levels are quantity-weighted FILL prices, not position
    // cost-basis/quantity (which includes fees). This is the exact distinction
    // PaperTrench makes and fixes DCA/partial-exit lines.
    const relevantFills = fillsForCurrentRound().sort((a, b) => a.timestamp - b.timestamp);
    const avgBuy = weightedFillAverage(relevantFills, "buy");
    const avgSell = weightedFillAverage(relevantFills, "sell");
    const supply =
      currentToken.supply ||
      (currentToken.marketCap && currentToken.price
        ? currentToken.marketCap / currentToken.price
        : undefined);

    window.dispatchEvent(
      new CustomEvent("paper-terminal:chart-model", {
        detail: JSON.stringify({
          address: currentToken.address,
          route: location.href,
          altAddress: currentToken.altAddress,
          quoteAddress: currentToken.quoteAddress,
          aliases: TradeTerminalSettings.tokenIds(TradeTerminalSettings.mergeToken(currentToken,currentPosition()?.token)),
          symbol: currentToken.symbol,
          supply,
          solPrice: state.settings.solPrice,
          avgBuy,
          avgSell,
          averageLevels: {
            buy:TradeTerminalSettings.averageFillLevels(relevantFills,"buy",{supply,solPrice:state.settings.solPrice}),
            sell:TradeTerminalSettings.averageFillLevels(relevantFills,"sell",{supply,solPrice:state.settings.solPrice}),
          },
          currentPrice: currentPrice(),
          priceSource: currentToken.source,
          observationSource: currentToken.quoteSource,
          independentQuote: independentQuote?.address===currentToken.address ? independentQuote : null,
          priceUpdatedAt: currentToken.priceUpdatedAt,
          currentMarketCap: currentToken.marketCap,
          fills: relevantFills.map((f) => ({
            id: f.id,
            side: f.side,
            price: f.price,
            levels: TradeTerminalSettings.fillLevels(f,{supply,solPrice:state.settings.solPrice}),
            marketCap: TradeTerminalSettings.fillLevels(f,{supply,solPrice:state.settings.solPrice}).mcap || undefined,
            timestamp: f.timestamp,
          })),
        }),
      })
    );
  }

  function scheduleChartUpdate() {
    cancelAnimationFrame(chartRaf);
    chartRaf = requestAnimationFrame(publishChartModel);
  }

  // ---------------------------------------------------------------------
  // Row-scoped token resolution for list/"trenches" pages
  // ---------------------------------------------------------------------

  const METRIC_TEXT_RE =
    /\b(MC|MCap|Market Cap|Vol|Volume|Liquidity|Holders|Bonded|Migrated|Age|Supply|ATH|B\.Curve)\b/i;

  // Finds the smallest ancestor of `el` that (a) looks like a single list
  // row (has metrics text, sane size) and (b) does NOT also enclose any of
  // the *other* candidate elements passed in. Requiring exclusivity is the
  // key fix over the old implementation: without it, a shared wrapper
  // (Tailwind's `.group` utility in particular, which pages apply to lots of
  // unrelated containers) could get picked as "the row" for several
  // different tokens at once, silently making every quick buy on the list
  // resolve to whichever token that shared wrapper's address heuristic
  // happened to find first.
  function findRowContainer(el, otherCandidates) {
    let node = el;
    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const text = node.innerText || "";
      const sizeOk = rect.width >= 260 && rect.height >= 45 && rect.height <= 240;
      const looksLikeRow = sizeOk && METRIC_TEXT_RE.test(text);
      const encloses = (other) => other !== el && node.contains(other);
      if (looksLikeRow && !otherCandidates.some(encloses)) {
        return node;
      }
    }
    return el.closest('article,[role="row"],[class*="card" i],[class*="token" i],[class*="row" i]');
  }

  function scanAddressAttributes(el) {
    for (const attrEl of [el, ...el.querySelectorAll("*")].slice(0, 180)) {
      for (const attr of [...attrEl.attributes]) {
        const match = attr.value.match(ADDRESS_SCAN_RE)?.[0];
        if (match) return match;
      }
    }
    return "";
  }

  function extractRowAddress(row) {
    if (row.dataset.paperTerminalTokenAddress) return row.dataset.paperTerminalTokenAddress;
    const dataEl = row.querySelector(
      "[data-token-address],[data-address],[data-contract-address],[data-mint],[data-pair-address]"
    );
    if (dataEl) {
      for (const value of Object.values(dataEl.dataset)) {
        const match = value?.match(ADDRESS_SCAN_RE)?.[0];
        if (match) return match;
      }
    }
    for (const anchor of row.querySelectorAll("a[href]")) {
      const address = extractAddressFromUrl(anchor.href);
      if (address) return address;
    }
    return scanAddressAttributes(row) || row.outerHTML.match(ADDRESS_SCAN_RE)?.[0] || "";
  }

  function buildRowToken(el) {
    const row = findRowContainer(el, []) || el;
    const text = String(row.innerText || row.textContent || el.innerText || el.textContent || "");
    const address = extractRowAddress(row);
    const symbol = (text.match(/\b[A-Z][A-Z0-9]{1,11}\b/)?.[0] || "TOKEN").slice(0, 12);
    return {
      terminal: detectSiteId(),
      name: symbol,
      symbol,
      address,
      chain: "solana",
      price: 0,
      priceUpdatedAt: 0,
      source: "unavailable",
    };
  }

  async function executeQuickBuy(row, statusEl, overrides) {
    const clickedOnTrenches=isListingPage();
    state = await loadState();
    if (!isEnabled() || !state.settings.trenchesQuickBuy || !clickedOnTrenches) return { ok: false, message: "Quick buy is off on this page." };
    const setStatus = (text, isError = false) => {
      showToast(text, isError);
      if (!statusEl) return;
      const original = statusEl.textContent;
      statusEl.textContent = text;
      statusEl.style.background = isError ? "#7a2634" : "#167653";
      window.setTimeout(() => {
        statusEl.textContent = original;
        statusEl.style.background = "#6f51e8";
      }, 1800);
    };

    const token = { ...buildRowToken(row), ...overrides, quickBuy: true, rowAddress: overrides?.rowAddress || overrides?.address || extractRowAddress(row) };
    if(overrides?.route && overrides.address===token.rowAddress && Date.now()-Number(overrides.observedAt)>=0 && Date.now()-Number(overrides.observedAt)<600) token.clickedRow={...overrides};
    if (!(token.price > 0) && Number(token.priceNative) > 0 && state.settings.solPrice > 0) {
      token.price = Number(token.priceNative) * state.settings.solPrice;
    }
    if (!token.address) {
      setStatus("Contract unavailable", true);
      return { ok: false, message: "Contract unavailable" };
    }

    const quickAmountSol = quickBuySolAmount(state.settings);
    if (!(quickAmountSol > 0)) {
      setStatus("Enter a Quick Buy amount", true);
      return { ok: false, message: "Enter a Quick Buy amount" };
    }

    const spendUsd = quickAmountSol * state.settings.solPrice;
    let result;
    if (token.clickedRow) {
      const snapshot=token.clickedRow, action=state.settings.quickBuyAction || 'none';
      const chartUrl=quickChartUrl(token,snapshot);
      result=await chrome.runtime.sendMessage({type:'EXECUTE_QUICK_BUY',requestId:makeId(),token,snapshot,spendUsd,action,chartUrl,route:snapshot.route});
      result ||= {ok:false,message:'Quick Buy could not be confirmed.'};
      if(result.ok) {
        state=normalizeState(result.state);
        if(sameToken(currentToken,result.fill.token))currentToken=TradeTerminalSettings.mergeToken(currentToken,result.fill.token,{quickBuy:false});
        if(isEnabled() && isDetailPage())renderPanel();
        scheduleChartUpdate();
      }
    } else result = await submitTrade("buy", token, spendUsd);
    lastQuickResult = {at:Date.now(),address:token.rowAddress,ok:result.ok,message:result.message,source:result.state?.fills?.[0]?.token?.source};
    if(!result.ok)setStatus(result.message,true);
    return result;
  }

  function publishQuickConfig() {
    document.getElementById(TRENCH_LAYER_ID)?.remove();
    window.dispatchEvent(new CustomEvent("paper-terminal:master-toggle", { detail: isEnabled() ? "on" : "off" }));
    const quickAmountSol = quickBuySolAmount(state.settings);
    window.dispatchEvent(
      new CustomEvent("paper-terminal:quick-config", {
        detail: JSON.stringify({
          enabled: !!(isEnabled() && state.settings.trenchesQuickBuy && isListingPage() && quickAmountSol > 0),
          label: quickAmountSol > 0 ? `${solNumber(quickAmountSol * state.settings.solPrice)} SOL` : "Buy",
        }),
      })
    );
  }

  function quickChartUrl(token, snapshot) {
    if(snapshot.chartUrl)return snapshot.chartUrl;
    const origin=new URL(snapshot.route || location.href).origin,id=encodeURIComponent(token.rowAddress || token.address);
    const paths={axiom:`/meme/${id}`,terminal:`/trade/solana/${id}`,gmgn:`/sol/token/${id}`,photon:`/en/lp/${id}`,bullx:`/terminal?chainId=1399811149&address=${id}`};
    return paths[token.terminal] ? origin+paths[token.terminal] : '';
  }

  // Resolves the "currently active" token for the page: prefers a live
  // Dexscreener quote (and re-keys to its canonical address) over the raw
  // DOM/URL scrape, and falls back to whatever was already loaded so an
  // overlay in view doesn't flicker to the demo token during a slow request.
  async function resolveActiveToken() {
    let scraped = readPageToken();
    const held=Object.values(state.positions).find(p=>sameToken(p.token,scraped));
    if(held)scraped=TradeTerminalSettings.mergeToken(held.token,scraped);
    if (scraped.address && isDetailPage()) {
      const detail=await requestRowQuote({...scraped,quickBuy:false});
      if (detail?.address===scraped.address) {
        const normalized=normalizeQuickQuote(scraped,detail,state.settings.solPrice);
        scraped=TradeTerminalSettings.mergeToken(scraped,detail,normalized,{address:normalized?.address || scraped.address,quickBuy:false});
        if (normalized) {
          lastDetailQuote=JSON.stringify([location.href,normalized.price,normalized.supply,normalized.marketCap,detail.quoteSource==='row-feed'?detail.priceObservedAt:0]);
          return scraped;
        }
      }
      const saved=Object.values(state.positions).find(p=>sameToken(p.token,scraped));
      if (saved) scraped=TradeTerminalSettings.mergeToken(saved.token,scraped);
    }
    if (scraped.address) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "FETCH_PRICE", address: scraped.address, chain:scraped.chain, mint:currentToken?.mint, fresh:true, solPrice:state.settings.solPrice });
        const pair = response?.pair;
        if (Number(pair?.priceUsd)>0 && sameToken(scraped,{chain:pair.chainId,address:pair.baseToken?.address,altAddress:pair.pairAddress})) {
          return withCanonicalAddress(
            {
              ...scraped,
              name: pair.baseToken?.name || scraped.name,
              symbol: pair.baseToken?.symbol || scraped.symbol,
              image: pair.info?.imageUrl,
              price: Number(pair.priceUsd),
              marketCap: Number(pair.marketCap || pair.fdv) || undefined,
              supply:
                Number(pair.marketCap || pair.fdv) > 0
                  ? Number(pair.marketCap || pair.fdv) / Number(pair.priceUsd)
                  : undefined,
              priceUpdatedAt: Date.now(),
              source: pair.source || "dexscreener",
            },
            pair
          );
        }
      } catch {
        // fall through to page-scraped / cached values below
      }
    }
    if (scraped.price) return scraped;
    if (sameToken(currentToken, scraped) && currentToken.price > 0) {
      return { ...currentToken, terminal: scraped.terminal };
    }
    return { ...scraped, price: 0, source: "unavailable", priceUpdatedAt: 0 };
  }

  // ---------------------------------------------------------------------
  // Live price refresh — independent of the TradingView-iframe integration
  // ---------------------------------------------------------------------

  // page-bridge.js can only draw markers / stream ticks when it finds a
  // TradingView chart *instance* (iframe or self-hosted charting-library
  // API). Several supported sites render charts without exposing either, so
  // PnL must not depend on that succeeding. This poller re-reads the page's
  // own displayed price on a short interval and treats it exactly like a
  // page-bridge tick (same sanity bounds), giving every site a working
  // baseline live-price path even before/without a chart API being found.
  let lastOwnScrapeAt = 0;
  let lastDisplayedQuote = null;
  function pollPageDisplayedPrice() {
    if (!isEnabled() || !currentToken?.address || !isDetailPage()) return;
    const scraped = readPageToken();
    if (!sameToken(scraped, currentToken) || !(scraped.price > 0)) return;
    const unchanged = lastDisplayedQuote?.route===location.href && lastDisplayedQuote.price===scraped.price;
    lastDisplayedQuote={route:location.href,price:scraped.price};
    // Re-reading unchanged DOM is not a new market observation. In particular
    // it must not keep suppressing network recovery or overwrite newer ticks.
    if (unchanged || (["site-feed","chart"].includes(currentToken.source) && Date.now()-(currentToken.priceUpdatedAt||0)<1200)) return;
    const supply = currentToken.supply || (currentToken.marketCap && currentToken.price ? currentToken.marketCap / currentToken.price : 0);
    if (!adoptLiveQuote({...scraped,supply,marketCap:supply ? scraped.price*supply : currentToken.marketCap},{source:"page",observedAt:Date.now()})) return;
    lastOwnScrapeAt = Date.now();
  }

  let networkPriceBusy = false;
  let detailQuoteBusy = false, lastDetailQuote = null;
  async function pollDetailQuote() {
    if (!isEnabled() || !isDetailPage() || !currentToken?.address || detailQuoteBusy) return;
    detailQuoteBusy=true;
    const route=location.href,generation=surfaceGeneration,token={...currentToken,rowAddress:extractAddressFromUrl(),quickBuy:false};
    try {
      const row=await requestRowQuote(token);
      if(route!==location.href || generation!==surfaceGeneration || !isEnabled())return;
      const quote=normalizeQuickQuote(token,row,state.settings.solPrice);
      if(!quote)return;
      const fingerprint=JSON.stringify([route,quote.price,quote.supply,quote.marketCap,row.quoteSource==='row-feed'?row.priceObservedAt:0]);
      if(fingerprint===lastDetailQuote && !(row.quoteSource==='detail-cap' && Math.abs(quote.price/currentToken.price-1)>1e-8))return;
      lastDetailQuote=fingerprint;
      if(currentToken.source==='chart' && Date.now()-currentToken.priceUpdatedAt<1200 && !['row-feed','detail-cap'].includes(row.quoteSource))return;
      adoptLiveQuote(quote,{source:'site-feed',quoteSource:row.quoteSource,observedAt:row.priceObservedAt || row.observedAt || Date.now()});
    }finally{detailQuoteBusy=false;}
  }
  async function pollNetworkPrice() {
    if (!isEnabled() || networkPriceBusy || !currentToken?.address || !isDetailPage()) return;
    networkPriceBusy = true;
    const requestedToken = currentToken, generation=surfaceGeneration, requestedAt=Date.now();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "FETCH_PRICE",
        address: requestedToken.address, mint:requestedToken.mint, chain:requestedToken.chain, fresh:true, solPrice:state.settings.solPrice,
      });
      const pair = response?.pair;
      const price = Number(pair?.priceUsd);
      if (!isEnabled() || generation!==surfaceGeneration || !(price > 0) || !sameToken(requestedToken, currentToken) || !sameToken(requestedToken,{chain:pair.chainId,address:pair.baseToken?.address,altAddress:pair.pairAddress})) return;
      if (Number(currentToken.priceUpdatedAt)>requestedAt) return;
      if (["site-feed", "chart"].includes(currentToken.source) && Date.now() - (currentToken.priceUpdatedAt || 0) < 1200) return;
      const candidate = withCanonicalAddress({
        ...currentToken,
        price,
        marketCap: Number(pair.marketCap || pair.fdv) || currentToken.marketCap,
        priceUpdatedAt: Date.now(),
        supply:Number(pair.supply) || Number(pair.fdv || pair.marketCap)/price || currentToken.supply,
        source: pair.source || "dexscreener",
      }, pair);
      adoptLiveQuote(candidate,{source:pair.source || "dexscreener",observedAt:Date.now(),requestedAt});
    } catch {
      // Keep the most recent page/chart price while the quote service is unavailable.
    } finally {
      networkPriceBusy = false;
    }
  }

  function livePriceWatchdog() {
    if (!isEnabled() || !isDetailPage() || !currentToken?.address || !currentPosition()?.quantity) return;
    const age = Date.now() - Number(currentToken.priceUpdatedAt || 0);
    if (age < 2000 || Date.now() - lastWatchdogKick < 900) return;
    lastWatchdogKick = Date.now();
    window.dispatchEvent(new CustomEvent("paper-terminal:chart-refresh", { detail: location.href }));
    pollDetailQuote();
    if (age > 3000) pollNetworkPrice();
  }

  // ---------------------------------------------------------------------
  // Mount / teardown / init
  // ---------------------------------------------------------------------

  async function refreshSurface() {
    const changedRoute = panelRoute !== location.href;
    if(changedRoute){panelRoute=location.href;resetLiveQuoteState();mainPaneOpen=false;executionEditorOpen=false;amountDraft=null;panelExpanded=true;}
    const generation = ++surfaceGeneration;
    lastDetailQuote=null;
    const route = location.href;
    if (!isEnabled()) {
      teardownOverlay();
      return;
    }
    publishQuickConfig();
    if (!isDetailPage()) {
      currentToken = null;
      document.getElementById(ROOT_ID)?.remove();
      window.dispatchEvent(new CustomEvent("paper-terminal:chart-clear"));
      return;
    }
    // Mount immediately; do not wait for a network quote before subscribing
    // to the host feed. A newer route or Off invalidates this resolution.
    const scraped = readPageToken();
    if (!sameToken(currentToken, scraped)) {
      const cached = Object.values(state.positions).find((position) => sameToken(position.token, scraped))?.token;
      currentToken = scraped.price > 0 ? TradeTerminalSettings.mergeToken(cached,scraped) : cached ? TradeTerminalSettings.mergeToken(scraped,cached,{source:"cached"}) : scraped;
      currentToken.quickBuy=false;
      lastDisplayedQuote={route:location.href,price:scraped.price};
    }
    if (isDetailPage() && state.settings.trenchesInstantTrade) {
      if (!document.getElementById(ROOT_ID)) {
        const root = document.createElement("div");
        root.id = ROOT_ID;
        root.attachShadow({ mode: "open" });
        document.documentElement.appendChild(root);
      }
      renderPanel(changedRoute);
    } else {
      document.getElementById(ROOT_ID)?.remove();
      document.getElementById(CHART_MARKERS_ID)?.remove();
    }
    publishQuickConfig();
    publishChartModel();
    const resolved = await resolveActiveToken();
    if (!isEnabled() || generation !== surfaceGeneration || route !== location.href) return;
    const freshHost = ["site-feed", "chart"].includes(currentToken?.source) && Date.now() - currentToken.priceUpdatedAt < 6000;
    currentToken = freshHost ? TradeTerminalSettings.mergeToken(resolved,currentToken,{address:resolved.address,supply:resolved.supply || currentToken.supply}) : TradeTerminalSettings.mergeToken(currentToken,resolved);
    currentToken.quickBuy=false;
    state=TradeTerminalSettings.reconcilePositions(state,currentToken);
    if (!resizeSession && !dragging) renderPanel();
    scheduleChartUpdate();
  }

  function teardownOverlay() {
    surfaceGeneration++;
    tradeEpoch++;
    amountDraft = null; executionEditorOpen = false;
    window.dispatchEvent(new CustomEvent("paper-terminal:master-toggle", { detail: "off" }));
    window.dispatchEvent(new CustomEvent("paper-terminal:quick-config", { detail: JSON.stringify({ enabled: false }) }));
    window.dispatchEvent(new CustomEvent("paper-terminal:chart-clear"));
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(CHART_MARKERS_ID)?.remove();
    document.querySelectorAll(`.${TRENCH_BUY_CLASS}`).forEach((el) => el.remove());
    document.getElementById(TRENCH_LAYER_ID)?.remove();
  }

  async function init() {
    state = await loadState();
    if (hasChromeStorage()) { const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; if (!stored || stored.settings?.executionModelVersion !== 1 || stored.settings?.executionDefaultsVersion !== 3 || stored.settings?.activePresetDefaultVersion !== 1) await saveState(state); }
    if (isEnabled()) chrome.runtime.sendMessage({ type: "REFRESH_SOL_PRICE" }).catch(() => {});
    // Register feed/bridge listeners before a potentially slow quote fetch.
    publishQuickConfig();
    document.addEventListener("keydown", handleShortcut, true);

    let layoutRaf = 0;
    const onLayoutChange = () => {
      cancelAnimationFrame(layoutRaf);
      layoutRaf = requestAnimationFrame(() => {
        reclampPanel();
        scheduleChartUpdate();
        publishQuickConfig();
      });
    };
    window.addEventListener("scroll", onLayoutChange, { passive: true, capture: true });
    window.addEventListener("resize", onLayoutChange, { passive: true });

    // A trenches-page quick-buy pill (rendered by page-bridge.js in the MAIN
    // world) was clicked. It hands us back whatever it already knew about
    // the row (address/price/quote), and we take it from there.
    window.addEventListener("paper-terminal:quick-buy", async (event) => {
      let detail = {};
      let outcome = { ok: false, message: "Quick buy failed" };
      try {
        detail = JSON.parse(event.detail);
      } catch {
        // ignore malformed payloads
      }
      const address = detail.address || "";
      try {
        if (!address || !isEnabled() || !state.settings.trenchesQuickBuy || !isListingPage()) return;
        const placeholderRow = document.createElement("div");
        placeholderRow.dataset.paperTerminalTokenAddress = address;
        outcome = await executeQuickBuy(placeholderRow, undefined, {
          ...detail,
          address,
          terminal: detectSiteId(),
          chain: "solana",
          priceUpdatedAt: Date.now(),
          source: detail.price ? "page" : "demo",
        });
      } catch (error) {
        outcome = {ok:false, message:error.message || "Quick buy failed before submission."};
      } finally {
        // Always unlock trench controls, including malformed rows and quote failures.
        window.dispatchEvent(new CustomEvent("paper-terminal:quick-buy-done", {
          detail: JSON.stringify({
            ok: !!outcome?.ok,
            message: outcome?.message || "Quick buy failed",
            address,
          }),
        }));
      }
    });

    window.addEventListener('paper-terminal:prewarm',event=>{
      if(isEnabled() && state.settings.trenchesQuickBuy && isListingPage() && ADDRESS_RE.test(event.detail || ''))chrome.runtime.sendMessage({type:'FETCH_TOKEN_SUPPLY',mint:event.detail}).catch(()=>{});
    });

    window.addEventListener("paper-terminal:route-change", async () => {
      document.getElementById(TRENCH_LAYER_ID)?.remove();
      document.querySelectorAll(`.${TRENCH_BUY_CLASS}`).forEach((el) => el.remove());
      await refreshSurface();
    });

    // The MAIN-world bridge observes each terminal's own realtime feed.
    // Like PaperTrench, this source outranks a polling quote, but only after
    // token identity and a bounded move are both validated here.
    window.addEventListener("paper-terminal:feed-price", (event) => {
      let detail;
      try { detail = JSON.parse(event.detail); } catch { return; }
      if (!isEnabled() || !currentToken || !sameToken(currentToken, { address: detail.address, chain:currentToken.chain })) return;
      const quote = normalizeQuickQuote({...currentToken,rowAddress:detail.address}, {
        address:detail.address,price:detail.priceUsd,priceNative:detail.priceNative,
        marketCap:detail.marketCap,observedAt:Date.now(),quoteSource:'row-feed'
      },state.settings.solPrice);
      if (!quote) return;
      adoptLiveQuote(quote,{source:'site-feed',quoteSource:'row-feed',observedAt:detail.observedAt || Date.now()});
    });

    // An unlabeled chart close can be USD, SOL or market cap. It is useful
    // for chart geometry, but must not become an execution/P&L quote by
    // guessing whichever conversion looks closest to the previous price.
    window.addEventListener("paper-terminal:chart-price", (event) => {
      if (isEnabled() && Number(event.detail)>0) scheduleChartUpdate();
    });
    window.addEventListener('paper-terminal:chart-quote',event=>{
      let quote;try{quote=JSON.parse(event.detail);}catch{return;}
      if(!isEnabled() || quote.route!==location.href || !sameToken(currentToken,{address:quote.address,chain:currentToken?.chain}) || !(quote.price>0) || !Number.isFinite(quote.price) || Date.now()-quote.observedAt>1000)return;
      adoptLiveQuote(quote,{source:'chart',observedAt:quote.observedAt});
    });

    window.dispatchEvent(new CustomEvent("paper-terminal:scan-rows"));

    chrome.storage.onChanged.addListener(async (changes) => {
      if (!changes[STORAGE_KEY]) return;
      state = await loadState();
      if (!isEnabled()) return teardownOverlay();
      if (resizeSession || dragging) return;
      document.querySelectorAll(`.${TRENCH_BUY_CLASS}`).forEach((el) => el.remove());
      if (!state.settings.enabled) return teardownOverlay();
      if (document.getElementById(ROOT_ID) && isDetailPage()) renderPanel();
      else await refreshSurface();
      publishQuickConfig();
    });

    let lastUrl = location.href;
    let routeDebounce = 0;
    const isOwnNode = (node) =>
      node instanceof Element &&
      (node.id === ROOT_ID ||
        node.id === CHART_MARKERS_ID ||
        node.id === TRENCH_LAYER_ID ||
        node.classList.contains(TRENCH_BUY_CLASS) ||
        !!node.closest(`#${ROOT_ID},#${CHART_MARKERS_ID},#${TRENCH_LAYER_ID},#trade-terminal-chart-bubbles,#trade-terminal-chart-rail,#paper-terminal-main-quick-layer,.${TRENCH_BUY_CLASS}`));

    new MutationObserver((mutations) => {
      const touched = mutations.flatMap((m) => [...m.addedNodes, ...m.removedNodes]);
      if (touched.length && touched.every(isOwnNode)) return;
      clearTimeout(routeDebounce);
      routeDebounce = window.setTimeout(async () => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          document.querySelectorAll(`.${TRENCH_BUY_CLASS}`).forEach((el) => el.remove());
          if (state.settings.enabled) await refreshSurface();
          return;
        }
        // Live terminals mutate their chart DOM constantly. Only mount or
        // unmount when the page TYPE changes; numeric ticks use the fast path.
        const shouldShow = isEnabled() && state.settings.trenchesInstantTrade && isDetailPage();
        const isShown = !!document.getElementById(ROOT_ID);
        if (shouldShow !== isShown) await refreshSurface();
      }, 500);
    }).observe(document.body, { childList: true, subtree: true });

    // Independent live-price fallback — see pollPageDisplayedPrice() above.
    window.setInterval(updateLiveMetrics, 100);
    window.setInterval(pollPageDisplayedPrice, 250);
    window.setInterval(pollDetailQuote, 250);
    window.setInterval(pollNetworkPrice, 1250);
    window.setInterval(livePriceWatchdog, 1000);
    await refreshSurface();
  }

  init();
})();
