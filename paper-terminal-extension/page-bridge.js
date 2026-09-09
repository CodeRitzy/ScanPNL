// Trade Terminal — page bridge (runs in the MAIN world, document_start)
//
// content.js runs in the isolated world and can't touch the host page's own
// React fiber tree or its TradingView chart instance. This script does that
// part: it finds "quick buy"-looking pills on trenches/list pages, resolves
// each one to a token address, and draws paper-fill markers + order lines on
// whatever TradingView chart instance it can find. It talks to content.js
// purely over CustomEvents on `window`.
//
// Fixes in this revision:
//   - Row-boundary detection no longer special-cases Axiom's `.group`
//     class. That heuristic could match a wrapper shared by several rows
//     (Tailwind's `group` utility is applied all over these UIs for
//     hover-state styling, not just row containers), which silently
//     collapsed multiple distinct tokens onto whichever token that shared
//     wrapper resolved to. Row containers are now required to be exclusive
//     to the pill they were found for.
//   - React-fiber address extraction now prefers prop names that match how
//     these sites route to a token page (`pairAddress`/`poolAddress`/
//     `tokenAddress`) over a generic `mint` field, since a row that only
//     exposes a mint (and not the pool/pair id the URL uses) previously
//     produced an address content.js's URL-based resolver would never see
//     again once you opened that token's own page.
//   - Chart-API discovery no longer assumes every site embeds TradingView
//     via `<iframe id="tradingview_...">`. It also looks for self-hosted
//     Advanced Charting Library instances (which usually render straight
//     into a div, no iframe) via common global names and DOM id patterns.

(() => {
  const FLAG = "__paperTerminalPageBridge";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const ADDRESS_RE = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  const ADDRESS_SCAN_RE = /(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/g;
  const METRIC_TEXT_RE =
    /\b(MC|MCap|Market Cap|Vol|Volume|Liquidity|Holders|Bonded|Migrated|Age|Supply|ATH|B\.Curve)\b/i;

  let chartModel = null;
  let drawnObjects = [];
  let nativeDrawKey = '';
  let activeChart = null;
  let lastTickPrice = 0;
  let candleCache = { chart: null, resolution: "", mode: "", bars: [] };
  // Per-fill anchors are keyed by resolution and chart unit, never pixels.
  const fillAnchors = new Map();
  let lastCandleExportAt = 0;
  let masterEnabled = false;
  let quickConfig = { enabled: false, label: "0.5 SOL" };
  const QUICK_LAYER_ID = "paper-terminal-main-quick-layer";
  const CHART_RAIL_ID = "trade-terminal-chart-rail";
  let placedPills = [];
  const rowPositions = new Map();
  const rowFeedQuotes = new Map();
  const warmedMints = new Map();
  let quickFeedRoots = [];
  let layoutRafPending = 0;
  let activeFeedIds = new Set();
  let lastFeedSignature = "";
  let chartModelSignature = "";
  let chartDrawGeneration = 0;
  const chartFrameMap = new WeakMap();
  const BUBBLE_LAYER_ID = "trade-terminal-chart-bubbles";
  const bubbleNodes = new Map();
  const chartLayers = new Map();
  const chartScopes = new Map();
  let chartOccluders = [];
  let chartOccludersScannedAt = 0;
  let bubbleChart = null;
  let bubbleFrameQueued = false;
  const feedLastEmitById = new Map();
  let lastBarTimeSec = 0;
  let lastLiveBarAt = 0;
  let exportStartedAt = 0;
  let exportSeq = 0;
  let axisMode = "";
  const patchedFeeds = new WeakSet();
  let detailTitleRoute = location.href;
  let detailTitleSnapshot = document.title;
  let detailTitleReady = false;

  const numberValue = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string" && value.length < 64) {
      const parsed = Number(value.replace(/[$,\s]/g, ""));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  function rememberRowFeed(value, identities, now = Date.now()) {
    if (!masterEnabled) return;
    const ids = [...new Set(identities.filter(id => typeof id === "string" && ADDRESS_RE.test(id)))];
    if (!ids.length) return;
    const first = (...values) => values.map(numberValue).find(value => value > 0) || 0;
    const price = first(value.priceUsd, value.tokenPriceUsd, value.usdPrice, value.priceInUsd, value.price_in_usd, value.price_usd, value.pu);
    const priceNative = first(value.priceNative, value.priceSol, value.priceInSol, value.price_in_sol);
    const marketCap = first(value.marketCapUsd, value.marketCapInUsd, value.usd_market_cap, value.mcapUsd, value.mcapInUsd);
    const marketCapNative = first(value.marketCapSol, value.marketCapInSol);
    const supply = first(value.supply, value.totalSupply, value.tokenSupply, value.circulatingSupply, value.total_supply);
    if (!(price || priceNative || marketCap || marketCapNative || supply)) return;
    const quote = {price, priceNative, marketCap, marketCapNative, supply,
      mint: [value.tokenMint, value.baseMint, value.mint, value.baseToken?.address, value.tokenAddress].find(id => typeof id === "string" && ADDRESS_RE.test(id)),
      symbol: String(value.symbol || value.tokenTicker || value.baseToken?.symbol || "TOKEN").slice(0,20),
      name: String(value.name || value.tokenName || value.baseToken?.name || value.symbol || "TOKEN").slice(0,64),
      quoteSource: "row-feed", priceObservedAt: now};
    for (const id of ids) {
      const prior = rowFeedQuotes.get(id);
      // Supply-only metadata must not refresh the timestamp of an old price.
      const metadataOnly = !(price || priceNative || marketCap || marketCapNative);
      rowFeedQuotes.set(id, metadataOnly && prior ? {...prior,supply:supply || prior.supply,mint:quote.mint || prior.mint} : {...quote,supply:supply || prior?.supply || 0});
    }
    while (rowFeedQuotes.size > 800) rowFeedQuotes.delete(rowFeedQuotes.keys().next().value);
  }

  function emitFeedPrice(detail) {
    const address = detail.address;
    if (!masterEnabled || !address || !activeFeedIds.has(address)) return;
    const signature = `${address}:${detail.priceUsd || 0}:${detail.priceNative || 0}:${detail.marketCap || 0}:${detail.candidates?.map((item) => `${item.unit}:${item.value}`).join(",") || ""}`;
    const now = Date.now();
    if (signature === lastFeedSignature && now - (feedLastEmitById.get(address) || 0) < 2000) return;
    if (now - (feedLastEmitById.get(address) || 0) < 75) return;
    feedLastEmitById.set(address, now);
    lastFeedSignature = signature;
    window.dispatchEvent(new CustomEvent("paper-terminal:feed-price", { detail: JSON.stringify({...detail,observedAt:now}) }));
  }

  function forwardGmgnActivity(parsed) {
    if (!parsed || parsed.channel !== "token_activity" || !Array.isArray(parsed.data)) return false;
    const latest = new Map();
    for (const item of parsed.data) {
      if (!item || typeof item.a !== "string") continue;
      rememberRowFeed(item, [item.a]);
      if (!activeFeedIds.has(item.a)) continue;
      const priceUsd = numberValue(item.pu);
      if (priceUsd > 0) latest.set(item.a, priceUsd);
    }
    for (const [address, priceUsd] of latest) {
      emitFeedPrice({ address, priceUsd, candidates: [{ value: priceUsd, unit: "usd", key: "pu" }], source: "gmgn-ws" });
    }
    return true;
  }

  // PaperTrench-style live-source path: observe the terminal's own fetch,
  // XHR and websocket traffic at document_start. The content script still
  // validates identity and magnitude before adopting a tick; this bridge
  // only forwards mint-tagged evidence and never guesses a token.
  function inspectLivePayload(raw, requestUrl = "") {
    if (!masterEnabled || (!activeFeedIds.size && !quickConfig.enabled) || raw == null) return;
    if (raw instanceof Blob) {
      if (raw.size <= 8_000_000) raw.text().then((text) => inspectLivePayload(text, requestUrl)).catch(() => {});
      return;
    }
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      if (bytes.byteLength <= 2_000_000) {
        try { inspectLivePayload(new TextDecoder().decode(bytes), requestUrl); } catch {}
      }
      return;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return;
      // GMGN's busy token_activity frames regularly exceed generic parse
      // guards. Parse that exact audited channel first, as PaperTrench does.
      if (trimmed.slice(0, 160).includes('"token_activity"')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (forwardGmgnActivity(parsed)) return;
        } catch { return; }
      }
      if (raw.length > 2_000_000) return;
      try { raw = JSON.parse(trimmed); } catch { return; }
    }
    if (!raw || typeof raw !== "object") return;
    if (forwardGmgnActivity(raw)) return;

    const requestMatches = [...activeFeedIds].some((id) => requestUrl.includes(id));
    const requestId = requestMatches ? [...activeFeedIds].find((id) => requestUrl.includes(id)) : "";
    const stack = [{ value: raw, inheritedId: requestId || "", depth: 0, tainted: false }];
    let budget = 20_000;
    while (stack.length && budget-- > 0) {
      const { value, inheritedId, depth, tainted } = stack.pop();
      if (!value || typeof value !== "object" || depth > 7) continue;
      if (Array.isArray(value)) {
        // Newest entries tend to be last; walk backwards so the node budget
        // cannot make a hot feed progressively older.
        for (let index = 0; index < value.length; index++) {
          stack.push({ value: value[index], inheritedId, depth: depth + 1, tainted });
        }
        continue;
      }
      const strongIds = [value.mint, value.tokenMint, value.baseMint, value.baseToken?.address, value.tokenAddress]
        .filter((id) => typeof id === "string" && ADDRESS_RE.test(id));
      const weakIds = [value.address, value.contractAddress, value.pairAddress, value.poolAddress, value.contract, value.ca, value.a, value.id]
        .filter((id) => typeof id === "string" && ADDRESS_RE.test(id));
      const candidateIds = [...new Set([...strongIds,...weakIds,inheritedId].filter(Boolean))];
      const matchingId = candidateIds.find(id=>activeFeedIds.has(id));
      const ownId = matchingId || strongIds[0] || weakIds[0] || inheritedId;
      const idMatches = !!matchingId;
      const isPositionRecord = value.costBasis !== undefined || value.averageEntryPrice !== undefined || value.avgEntryPrice !== undefined || value.unrealizedPnl !== undefined || value.realizedPnl !== undefined || value.realizedPnlUSD !== undefined || value.avgBuyPriceUSD !== undefined || (value.pnl !== undefined && value.value !== undefined && value.price !== undefined);
      const hasEventId = value.tradeId || value.txId || value.txHash || value.signature || value.transactionHash;
      const attributed = value.user || value.userId || value.maker || value.userHandle || value.displayName;
      const isAttributedTrade = (hasEventId && attributed) || (/^(swap|trade|buy|sell)/i.test(value.type || value.eventType || value.txType || "") && (hasEventId || attributed));
      const nextTainted = tainted || isPositionRecord || isAttributedTrade || !!hasEventId;
      if (!nextTainted) rememberRowFeed(value, [...candidateIds, value.pairAddress, value.poolAddress, value.pool_address, value.marketAddress]);
      if (idMatches && !nextTainted) {
        const priceNative = numberValue(value.priceNative ?? value.priceSol ?? value.priceInSol);
        const priceUsd = numberValue(value.priceUsd ?? value.tokenPriceUsd ?? value.usdPrice ?? value.price_in_usd ?? value.price_usd ?? value.pu);
        const marketCap = numberValue(value.marketCapUsd ?? value.marketCapInUsd ?? value.mcapInUsd);
        const candidates = [];
        for (const [key, candidateValue] of Object.entries(value)) {
          if (!/^(price|tokenPrice|currentPrice|lastPrice|last|close|c|markPrice|quote)$/i.test(key)) continue;
          const candidate = numberValue(candidateValue);
          if (candidate > 0) candidates.push({ value: candidate, unit: "unknown", key });
          if (candidates.length >= 8) break;
        }
        if (priceUsd > 0 || priceNative > 0 || marketCap > 0 || candidates.length) {
          emitFeedPrice({
            address: ownId,
            priceUsd: priceUsd > 0 ? priceUsd : undefined,
            priceNative: priceNative > 0 ? priceNative : undefined,
            marketCap: marketCap > 0 ? marketCap : undefined,
            candidates,
            source: "site-feed",
          });
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (!child || typeof child !== "object") continue;
        const childTainted = nextTainted || /^(positions?|holdings?|portfolio|userPositions?|myPositions?|openOrders?|balances?|hodlers?|holders?|topHolders?|toptraders?|trades?|transactions?|history|walletTracker|trackedWallets|quoteToken|quoteAsset|liquidity|volume|ath|allTimeHigh)$/i.test(key);
        stack.push({ value: child, inheritedId: ADDRESS_RE.test(key) ? key : ownId, depth: depth + 1, tainted: childTainted });
      }
    }
  }

  function installLiveFeedHooks() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (...args) {
        const result = originalFetch.apply(this, args);
        const url = String(args[0]?.url || args[0] || "");
        result.then((response) => {
          if (!masterEnabled || (!activeFeedIds.size && !quickConfig.enabled)) return;
          const size = Number(response.headers?.get?.("content-length")) || 0;
          if (!size || size <= 2_000_000) response.clone().text().then((text) => inspectLivePayload(text, url)).catch(() => {});
        }).catch(() => {});
        return result;
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR?.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url, ...rest) {
        this.__tradeTerminalUrl = String(url || "");
        return originalOpen.call(this, method, url, ...rest);
      };
      XHR.prototype.send = function (...args) {
        this.addEventListener("load", () => {
          try { inspectLivePayload(this.responseType === "json" ? this.response : this.responseText, this.__tradeTerminalUrl || ""); } catch {}
        }, { once: true });
        return originalSend.apply(this, args);
      };
    }

    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      const WrappedWebSocket = function (url, protocols) {
        const socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
        socket.addEventListener("message", (event) => inspectLivePayload(event.data, String(url || "")));
        return socket;
      };
      WrappedWebSocket.prototype = OriginalWebSocket.prototype;
      for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) WrappedWebSocket[key] = OriginalWebSocket[key];
      try { window.WebSocket = WrappedWebSocket; } catch {}
    }
  }

  installLiveFeedHooks();

  // -----------------------------------------------------------------------
  // Quick-buy pill layout (keeps each pill pinned next to the row's own
  // buy control as the list scrolls/virtualizes)
  // -----------------------------------------------------------------------

  function releaseRowPosition(row) {
    if (placedPills.some(item => item.row === row)) return;
    const original = rowPositions.get(row);
    if (original !== undefined) {
      if (row.style.position === "relative") row.style.position = original;
      rowPositions.delete(row);
    }
    delete row.dataset.paperTerminalTokenAddress;
  }

  function clearQuickPills() {
    const previous = placedPills;
    placedPills = [];
    quickFeedRoots = [];
    rowFeedQuotes.clear();
    for (const item of previous) { item.button.remove(); releaseRowPosition(item.row); }
    document.getElementById(QUICK_LAYER_ID)?.remove();
  }

  function repositionPills() {
    layoutRafPending = 0;
    for (const placed of placedPills) {
      if (!placed.row.isConnected || !placed.anchor.isConnected) {
        placed.button.style.display = "none";
        continue;
      }
      const rowRect = placed.row.getBoundingClientRect();
      const anchorRect = placed.anchor.getBoundingClientRect();
      if (rowRect.bottom <= 0 || rowRect.top >= innerHeight || anchorRect.width <= 0 || rowRect.width <= 0) {
        placed.button.style.display = "none";
        continue;
      }
      placed.button.style.display = "";
      const scaleX = rowRect.width / (placed.row.offsetWidth || rowRect.width);
      const scaleY = rowRect.height / (placed.row.offsetHeight || rowRect.height);
      const width = (placed.button.offsetWidth || 70) * scaleX;
      const height = (placed.button.offsetHeight || 24) * scaleY;
      const after = placed.anchor.tagName !== "A" && anchorRect.right + width + 9 <= rowRect.right;
      const before = anchorRect.left - width - 5 >= rowRect.left + 8;
      const desiredLeft = after ? anchorRect.right + 5 : before ? anchorRect.left - width - 5 : rowRect.right - width - 8;
      const left = Math.max(rowRect.left + 4, Math.min(rowRect.right - width - 4, desiredLeft));
      const top = Math.max(rowRect.top + 2, Math.min(rowRect.bottom - height - 2, anchorRect.top + (anchorRect.height - height) / 2));
      // The pill is a real child of the token row. Native pointer/mouse hover
      // travels through that row, preserving the terminal's pause-on-hover.
      placed.button.style.left = `${(left - rowRect.left) / scaleX - (placed.row.clientLeft || 0) + (placed.row.scrollLeft || 0)}px`;
      placed.button.style.top = `${(top - rowRect.top) / scaleY - (placed.row.clientTop || 0) + (placed.row.scrollTop || 0)}px`;
    }
  }
  function scheduleReposition() {
    if (!layoutRafPending) layoutRafPending = requestAnimationFrame(repositionPills);
  }

  // -----------------------------------------------------------------------
  // Row boundary + address resolution
  // -----------------------------------------------------------------------

  // Smallest ancestor of `el` that looks like one row (has metrics text,
  // sane on-screen size) AND does not also enclose any other candidate
  // anchor element passed in `otherAnchors`. The exclusivity check is what
  // prevents a shared wrapper from being mistaken for a single row's
  // container — see the file header for why that mattered.
  function findExclusiveRow(el, otherAnchors) {
    let node = el;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 28 || rect.height > 240) continue;
      if (!METRIC_TEXT_RE.test(node.innerText || "")) continue;
      const encloses = (other) => other !== el && node.contains(other);
      if (!otherAnchors.some(encloses)) return node;
    }
    return null;
  }

  function addressFromLinks(row) {
    for (const anchor of row.querySelectorAll("a[href]")) {
      const address = tokenLinkAddress(anchor);
      if (address) return address;
    }
    return "";
  }

  // Prop-name → priority. Exact identity-style names outrank a bare "mint"
  // field: these sites route by pool/pair address far more often than by
  // raw mint, so preferring pair/pool/token-address keeps the value in sync
  // with what the URL-based resolver in content.js will find once you open
  // that token's own page.
  function propPriority(propName) {
    if (/^(address|tokenAddress|pairAddress|poolAddress|pool_address)$/i.test(propName)) return 4;
    if (/^(mint|tokenMint|baseMint)$/i.test(propName)) return 3;
    if (/token|mint|contract|address|pair|ca/i.test(propName)) return 2;
    return 1;
  }

  function addressFromReactFiber(row) {
    // Stay within the card's React ownership. An ancestor list can contain
    // dozens of other identities; it must never choose the tapped token.
    const elements = [row,...[...(row.querySelectorAll?.("*") || [])].slice(0,40)];
    const identityKeys = /^(?:tokenAddress|tokenMint|mint|baseMint|pairAddress|poolAddress|pool_address|contractAddress|address)$/i;
    for (const element of elements) {
      for (const key of ["data-token-address","data-mint","data-pair-address","data-contract-address"]) {
        const value=element.getAttribute?.(key); if (value && ADDRESS_RE.test(value)) return value;
      }
      const fiberKey=Object.getOwnPropertyNames(element).find(key=>key.startsWith("__reactFiber$"));
      let fiber=fiberKey ? element[fiberKey] : null;
      const seen=new Set();
      for(let hops=0;fiber && hops<8;hops++,fiber=fiber.return) {
        if (fiber.stateNode?.nodeType===1 && fiber.stateNode!==row && !row.contains(fiber.stateNode)) break;
        const records=[];
        const walk=(value,depth)=>{
          if(!value || typeof value!=="object" || Array.isArray(value) || depth>3 || seen.has(value))return;
          seen.add(value);
          const ids=Object.entries(value).filter(([k,v])=>identityKeys.test(k)&&typeof v==="string"&&ADDRESS_RE.test(v));
          if(ids.length)records.push(ids.sort((a,b)=>propPriority(b[0])-propPriority(a[0]))[0][1]);
          for(const [k,v] of Object.entries(value).slice(0,60))if(!/children|wallet|user|creator|deployer|ref|^_/.test(k))walk(v,depth+1);
        };
        walk(fiber.memoizedProps,0);
        // Multiple records mean a shared container, not one token card.
        const ids=[...new Set(records)]; if(ids.length===1)return ids[0]; if(ids.length>1)break;
      }
    }
    return "";
  }

  function quoteFromReactFiber(el, address) {
    try {
      const fiberKey = Object.getOwnPropertyNames(el).find((k) => k.startsWith("__reactFiber$"));
      let root = fiberKey ? el[fiberKey] : null;
      // Some terminal cards add a plain wrapper outside React's host node.
      if (!root) for (const child of [...(el.querySelectorAll?.("*") || [])].slice(0, 80)) {
        const key = Object.getOwnPropertyNames(child).find(k => k.startsWith("__reactFiber$"));
        if (key) { root = child[key]; break; }
      }
      if (!root) return null;

      // DOM nodes can keep the previous half of React's double-buffered tree.
      // Switch only when the alternate is provably part of the committed root.
      const topOf = (node) => { let hops = 0; while (node?.return && hops++ < 100) node = node.return; return node; };
      const top = topOf(root), committed = top?.stateNode?.current;
      if (committed && top !== committed && root.alternate && topOf(root.alternate) === committed) root = root.alternate;

      const addressKeys = /^(tokenAddress|tokenMint|baseMint|mint|address|pairAddress|poolAddress|pool_address)$/;
      const fieldKeys =
        /^(priceUsd|priceInUsd|usdPrice|price_usd|price_in_usd|tokenPriceUsd|priceSol|priceInSol|price_in_sol|priceNative|marketCapUsd|marketCapInUsd|mcapInUsd|mcapUsd|usd_market_cap|marketCapSol|marketCapInSol|supply|tokenSupply|circulatingSupply|totalSupply|total_supply|symbol|ticker|tokenTicker|name|tokenName)$/;

      const candidates = [];
      const visitedObjects = new Set();
      let recordBudget = 1800;
      const collectFrom = (node, depth, keyedAddress = "") => {
        if (!node || typeof node !== "object" || depth > 6 || visitedObjects.has(node) || recordBudget-- <= 0) return;
        visitedObjects.add(node);
        if (Array.isArray(node)) { for (const item of node.slice(0,120)) collectFrom(item,depth+1); return; }
        if (node.costBasis !== undefined || node.averageEntryPrice !== undefined || node.txHash || node.signature) return;
        if (keyedAddress === address || Object.entries(node).some(([k, v]) => addressKeys.test(k) && v === address)) {
          const picked = {};
          const aliases = new Set([address, ...Object.entries(node).filter(([k,v]) => addressKeys.test(k) && typeof v === "string").map(([,v])=>v)]);
          for (const child of [node.baseToken,node.token,node.tokenInfo]) {
            if (!child || typeof child!=="object")continue;
            for(const [key,value] of Object.entries(child))if(addressKeys.test(key) && typeof value==='string' && ADDRESS_RE.test(value))aliases.add(value);
          }
          const gather = (inner, innerDepth) => {
            if (!inner || typeof inner !== "object" || innerDepth > 3 || Array.isArray(inner)) return;
            if (inner.costBasis !== undefined || inner.averageEntryPrice !== undefined || inner.txHash || inner.signature) return;
            const identities = Object.entries(inner).filter(([key, value]) => addressKeys.test(key) && typeof value === "string").map(([, value]) => value);
            if (identities.length && !identities.some(id => aliases.has(id))) return;
            for (const [k, v] of Object.entries(inner)) {
              if ((fieldKeys.test(k) || addressKeys.test(k)) && picked[k] == null) picked[k] = v;
              if (v && typeof v === "object" && /^(baseToken|token|tokenInfo|data|pair|market|quote)$/i.test(k)) gather(v, innerDepth + 1);
            }
          };
          gather(node, 0);
          for (const child of [node.baseToken,node.token,node.tokenInfo]) {
            const mint=child?.tokenAddress || child?.mint || child?.address;
            if (typeof mint==='string' && ADDRESS_RE.test(mint)) {picked.tokenAddress ||= mint;break;}
          }
          candidates.push(picked);
        }
        for (const [key,value] of Object.entries(node).slice(0, 120)) {
          if (/^(positions?|holdings?|wallets?|transactions?|trades?|history|balances?)$/i.test(key)) continue;
          if (value && typeof value === "object") collectFrom(value, depth + 1, key);
        }
      };

      const seen = new Set();
      const stack = [root];
      for (let steps = 0; stack.length && steps < 450; steps += 1) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        collectFrom(fiber.memoizedProps, 0);
        collectFrom(fiber.memoizedState, 0);
        if (fiber.child && typeof fiber.child === "object") stack.push(fiber.child);
        if (fiber.sibling && typeof fiber.sibling === "object") stack.push(fiber.sibling);
      }
      let up = root;
      for (let hops = 0; up && hops < 16; hops += 1) {
        collectFrom(up.memoizedProps, 0);
        collectFrom(up.memoizedState, 0);
        up = up.return && typeof up.return === "object" ? up.return : null;
      }

      // Prefer the closest row record; a larger ancestor snapshot is not
      // necessarily newer just because it contains more fields.
      const direct = candidate => [candidate.priceUsd,candidate.priceInUsd,candidate.usdPrice,candidate.price_usd,candidate.tokenPriceUsd,candidate.price_in_usd,candidate.price_in_sol,candidate.priceNative,candidate.priceSol,candidate.priceInSol].some(value => Number(value) > 0);
      const priced = candidates.find(direct);
      const best = {...(priced || candidates.find(candidate => [candidate.marketCapSol,candidate.marketCapInSol,candidate.marketCapUsd,candidate.marketCapInUsd,candidate.mcapInUsd,candidate.mcapUsd,candidate.usd_market_cap].some(value=>Number(value)>0)) || candidates[0])};
      // Fill missing supply/identity from other matching records, without
      // replacing a closer price with a larger ancestor's stale snapshot.
      for (const candidate of candidates) for (const key of ["supply","tokenSupply","circulatingSupply","totalSupply","total_supply","tokenAddress","tokenMint","baseMint","mint","symbol","name"]) {
        if (best[key] == null && candidate[key] != null) best[key] = candidate[key];
      }
      if (!Object.keys(best).length) return null;

      const numeric = (...keys) => {
        for (const key of keys) {
          const value = Number(best[key]);
          if (value > 0 && Number.isFinite(value)) return value;
        }
        return 0;
      };
      const priceNative = numeric("priceNative", "priceSol", "priceInSol", "price_in_sol");
      const supply = numeric("supply", "tokenSupply", "circulatingSupply", "totalSupply", "total_supply");
      const reportedMcap = numeric("marketCapUsd", "marketCapInUsd", "mcapInUsd", "mcapUsd", "usd_market_cap");
      const price = numeric("tokenPriceUsd", "priceUsd", "priceInUsd", "usdPrice", "price_usd", "price_in_usd") || (supply > 0 && reportedMcap > 0 ? reportedMcap / supply : 0);
      return {
        address,
        mint: best.tokenMint || best.baseMint || best.mint || best.tokenAddress || best.address || undefined,
        price,
        priceNative,
        marketCapNative: numeric("marketCapSol", "marketCapInSol"),
        marketCap: reportedMcap,
        supply,
        symbol: String(best.symbol || best.ticker || best.tokenTicker || "TOKEN").slice(0, 20),
        name: String(best.name || best.tokenName || best.symbol || "TOKEN").slice(0, 64),
      };
    } catch {
      return null;
    }
  }

  function detailDisplayedCap(props) {
    if (!props || !/(axiom\.trade|padre\.gg|terminal\.trade)$/.test(location.hostname)) return 0;
    if (detailTitleRoute !== location.href) {
      detailTitleRoute = location.href;
      detailTitleSnapshot = document.title;
      detailTitleReady = false;
    } else if (document.title !== detailTitleSnapshot) {
      detailTitleSnapshot = document.title;
      detailTitleReady = true;
    }
    // On SPA navigation the old token title can linger briefly. Accept an
    // unnamed title only after it changes for this route; an exact token name
    // is safe immediately. Unlike Dryflip, supply remains token-specific.
    const title = document.title.toLowerCase();
    const names = [props.symbol,props.name].filter(n=>n && !/^(token|unknown)$/i.test(n));
    const words = title.split(/[^a-z0-9]+/).filter(Boolean);
    const named=names.some(name=>name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).every(word=>words.includes(word)));
    if (names.length ? !named : !detailTitleReady) return 0;
    const match = document.title.match(/\$\s*([\d,]+(?:\.\d+)?)\s*([KMB])\b/i);
    if (!match) return 0;
    return Number(match[1].replaceAll(',','')) * ({k:1e3,m:1e6,b:1e9}[match[2].toLowerCase()] || 0);
  }

  function readRowMarketCap(row) {
    const explicit = row.querySelector('[data-market-cap-usd],[data-testid="market-cap"],[data-testid="token-market-cap"]');
    const usdAttribute = explicit?.getAttribute('data-market-cap-usd');
    const marked = usdAttribute || explicit?.textContent || '';
    const text = String(row.innerText || row.textContent || '').replace(/\s+/g, ' ');
    // Only MC-labelled values count; never the first dollar amount (volume,
    // liquidity, fees and market cap all occur in the same card).
    const value = marked || text.match(/\b(?:MC|MCap|Market\s*Cap)\s*:?\s*(\$?\s*[\d,.]+\s*[KMBT]?)/i)?.[1] || text.match(/(\$\s*[\d,.]+\s*[KMBT]?)\s*(?:MC|MCap|Market\s*Cap)\b/i)?.[1] || '';
    // A SOL-denominated market cap must not be treated as dollars.
    if (!usdAttribute && !value.includes('$')) return 0;
    const match = value.trim().match(/^\$?\s*([\d,.]+)\s*([KMBT])?(?:\s|$)/i);
    if (!match) return 0;
    const number = Number(match[1].replaceAll(',', ''));
    const factor = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase()] || 1;
    return number > 0 && Number.isFinite(number) ? number * factor : 0;
  }

  function excludedQuickContext(element) {
    for (let node=element, depth=0; node && node !== document.body && depth<18; node=node.parentElement,depth++) {
      const hint = [node.id,typeof node.className === "string" ? node.className : "",node.getAttribute?.("data-testid"),node.getAttribute?.("data-panel"),node.getAttribute?.("aria-label")].filter(Boolean).join(" ");
      if (/wallet[\s_-]*(?:track|activity|history)|tracked[\s_-]*wallet|portfolio|watchlist/i.test(hint)) return true;
      if (node.getAttribute?.("role") === "dialog" || node.tagName === "DIALOG") return true;
      const labelId=node.getAttribute?.("aria-labelledby");
      const labelled=labelId?.split(/\s+/).map(id=>document.getElementById(id)?.textContent || "").join(" ") || "";
      if (/wallet\s*tracker|tracked\s*wallet/i.test(labelled)) return true;
      // A tracker title belongs to its nearby panel, not every shared app
      // ancestor. Navigation controls and wider layout wrappers aren't panels.
      const panelWidth = node.getBoundingClientRect().width;
      const rowWidth = element.getBoundingClientRect().width;
      if (depth > 4 || panelWidth > Math.max(520, rowWidth * 1.5)) continue;
      const heading = [...(node.children || [])].flatMap(child=>[child,...(child.children || [])]).find(child=>{
        const text=String(child.textContent || "").trim();
        return !child.closest?.("button,a,nav") && text.length<70 && /^(?:wallet\s*tracker|tracked\s*wallets|wallet\s*activity)(?:\s|$)/i.test(text);
      });
      if (heading) return true;
    }
    return false;
  }

  function tokenLinkAddress(link) {
    try {
      const url = new URL(link.href,location.href);
      // Wallet/explorer links often contain valid base58 strings too.
      if (/\/(?:wallet|account|profile|track(?:er)?|tx|transaction)(?:\/|$)/i.test(url.pathname)) return "";
      if (/(^|\.)axiom\.trade$/.test(location.hostname)) {
        const localToken = /(^|\.)axiom\.trade$/.test(url.hostname) && /^\/(?:t|meme|token)\//i.test(url.pathname);
        const explorerToken = /(^|\.)solscan\.io$/.test(url.hostname) && /^\/token\//i.test(url.pathname);
        const launchToken = /(^|\.)pump\.fun$/.test(url.hostname) && /^\/coin\//i.test(url.pathname);
        if (!localToken && !explorerToken && !launchToken) return "";
      }
      return addressFromHref(link.href);
    } catch { return ""; }
  }

  function findQuickFeedRoots(addressLinks) {
    const roots=[];
    const labels=[...document.querySelectorAll('h1,h2,h3,h4,span,div,button')].filter(node=>{
      if ((node.childElementCount || 0)>2) return false;
      const text=String(node.textContent || "").trim().replace(/\s+/g," ");
      return /^(?:New Pairs|Final Stretch|Migrated|New Creations|Almost Bonded|Recently Bonded|Completing|Completed)(?:\s*\(?\d+\)?)?$/i.test(text) && !excludedQuickContext(node);
    });
    for (const label of labels) {
      for (let node=label.parentElement,depth=0;node && node!==document.body && node!==document.documentElement && depth<8;node=node.parentElement,depth++) {
        if (!addressLinks.some(item=>node.contains(item.link))) continue;
        // Choose the nearest headed column that actually contains token rows.
        if (!roots.includes(node)) roots.push(node);
        break;
      }
    }
    return roots;
  }

  function quickRouteAllowed() {
    const path=location.pathname.toLowerCase(), selection=`${location.search||''}${location.hash||''}`;
    if (/(?:^|[/?#&=])(?:discover|discovery|wallet|tracker|profile)(?:[/?#&=]|$)/i.test(path+selection)) return false;
    if (/^\/(?:en\/)?(?:pulse|trenches|new-pairs|new_pairs)(?:\/|$)/.test(path)) return true;
    // GMGN and Padre serve their trenches at the home route as well.
    // This is a host-specific route, never a guess from page text.
    return /^\/$/.test(path) && /(^|\.)(?:gmgn\.ai|padre\.gg|terminal\.trade)$/.test(location.hostname);
  }

  function allowedQuickRow(row) {
    if (!row || excludedQuickContext(row)) return false;
    // scanRows already verifies an exclusive token row. Headings can be
    // translated, decorated or virtualized; they are only diagnostic hints.
    return quickRouteAllowed();
  }

  function readQuickRowQuote(row, address) {
    if (!row?.isConnected || !allowedQuickRow(row) || row.dataset.paperTerminalTokenAddress !== address) return null;
    const links = [...row.querySelectorAll('a[href]')].map(tokenLinkAddress).filter(Boolean);
    if (links.length && !links.includes(address)) return null; // recycled virtual row
    if (!links.length) {
      const currentIdentity=addressFromReactFiber(row);
      if (!currentIdentity || currentIdentity!==address) return null;
    }
    const props = quoteFromReactFiber(row, address) || { address };
    const live = rowFeedQuotes.get(address) || rowFeedQuotes.get(props.mint);
    const fresh = live && Date.now() - live.priceObservedAt <= 3000;
    const quote = fresh ? {...props,...live,supply:live.supply || props.supply,mint:live.mint || props.mint} : {...props,quoteSource:"row-props",priceObservedAt:Date.now()};
    const displayedMarketCap = readRowMarketCap(row);
    const chartUrl=[...row.querySelectorAll('a[href]')].find(link=>tokenLinkAddress(link)===address)?.href;
    return { ...quote, address, rowAddress: address, route:location.href, chartUrl, displayedMarketCap, observedAt: Date.now() };
  }

  // -----------------------------------------------------------------------
  // Trenches / list-page row scanning
  // -----------------------------------------------------------------------

  function addressFromHref(href) {
    try {
      const url = new URL(href, location.href);
      const values = [
        ...url.searchParams.values(),
        ...url.pathname.split(/[/_:]/),
        ...url.hash.split(/[/?#=&_:]/),
      ];
      return values.reverse().find((value) => ADDRESS_RE.test(value)) || "";
    } catch {
      return "";
    }
  }

  function findTokenRow(link, addressLinks) {
    let node = link;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 28 || rect.height > 240) continue;
      const distinctAddresses = new Set(
        addressLinks.filter((item) => node.contains(item.link)).map((item) => item.address)
      );
      if (distinctAddresses.size > 2) continue;
      const hint = `${node.getAttribute("role") || ""} ${node.className || ""} ${node.getAttribute("data-testid") || ""}`;
      if (METRIC_TEXT_RE.test(node.innerText || "") || /row|card|token|pair|meme|table/i.test(hint)) return node;
    }
    return null;
  }

  function isBuyControl(el) {
    if (el.closest?.("[data-paper-terminal-quick-address]")) return false;
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.textContent || ""}`.trim();
    return /quick\s*buy|instant\s*buy|buy|lightning|⚡|↯|^\d*\.?\d+\s*(SOL|ETH|BNB)$/i.test(label);
  }

  function rightmostControl(row, preferred) {
    const controls = [...row.querySelectorAll('button,[role="button"]')].filter((el) => {
      const rect = el.getBoundingClientRect();
      return !el.closest?.("[data-paper-terminal-quick-address]") && rect.width > 0 && rect.height > 0 && rect.height <= 80;
    });
    const buys = controls.filter(isBuyControl);
    return (buys.length ? buys : controls).sort(
      (a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right
    )[0] || preferred;
  }

  function reactRowCandidates(knownRows) {
    const candidates=new Set(document.querySelectorAll('div.group,[role="row"],article,[data-token-address],[data-mint],[data-pair-address],[class*="token-card" i],[class*="pair-card" i],[class*="_row_" i]'));
    for (const row of knownRows) for (const sibling of row.parentElement?.children || []) candidates.add(sibling);
    const found=[];
    for(const row of [...candidates].slice(0,900)) {
      const rect=row.getBoundingClientRect();
      if(rect.width<220 || rect.height<28 || rect.height>240 || rect.bottom<=0 || rect.top>=innerHeight || excludedQuickContext(row)) continue;
      if(!METRIC_TEXT_RE.test(row.innerText || row.textContent || "")) continue;
      // A group class alone isn't identity: resolve the row's own data.
      const address=addressFromLinks(row) || addressFromReactFiber(row);
      if(address) found.push({row,address,anchor:rightmostControl(row,row)});
    }
    return found;
  }

  function scanRows() {
    if (!masterEnabled || !quickConfig.enabled || !quickRouteAllowed()) {
      clearQuickPills(); return;
    }

    const addressLinks = [...document.querySelectorAll("a[href]")]
      .map((link) => ({ link, address: tokenLinkAddress(link) }))
      .filter((item) => item.address && !excludedQuickContext(item.link));
    const buyCandidates = [...document.querySelectorAll('button,[role="button"]')].filter(el=>isBuyControl(el) && !excludedQuickContext(el));
    const rowCandidates = [];

    // Primary path: a token-address link is reliable even when the site's buy
    // control is an unlabeled SVG icon. The row owns the extension button;
    // capture-phase press handlers prevent accidental token navigation.
    for (const item of addressLinks.slice(0, 800)) {
      const row = findTokenRow(item.link, addressLinks);
      if (row) rowCandidates.push({ row, anchor: rightmostControl(row, item.link), address: item.address });
    }

    // Fallback for sites that keep the address only in React props.
    for (const anchor of buyCandidates.slice(0, 500)) {
      const row = findExclusiveRow(anchor, buyCandidates);
      if (!row) continue;
      const address = addressFromLinks(row) || addressFromReactFiber(row);
      if (address) rowCandidates.push({ row, anchor, address });
    }

    rowCandidates.push(...reactRowCandidates(rowCandidates.map(candidate=>candidate.row)));
    // Drop nested duplicates for the same token while keeping sibling rows.
    const duplicates = new Set(rowCandidates.filter(candidate=>rowCandidates.some(other=>other.row!==candidate.row && other.address===candidate.address && other.row.contains(candidate.row))).map(candidate=>candidate.row));
    quickFeedRoots = findQuickFeedRoots(rowCandidates.map(candidate=>({link:candidate.row,address:candidate.address})));

    // Reconcile by row + identity. Recreating every button between pointerdown
    // and click used to lose presses and retrigger our own MutationObserver.
    const previous = placedPills;
    placedPills = [];
    const usedRows = new Set();
    let found = 0;

    for (const candidate of rowCandidates) {
      const { row, anchor, address } = candidate;
      if (!allowedQuickRow(row) || usedRows.has(row) || duplicates.has(row)) continue;
      usedRows.add(row);

      row.dataset.paperTerminalTokenAddress = address;
      found += 1;
      if (!quickConfig.enabled) continue;

      const rowRect = row.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      if (rowRect.bottom <= 0 || rowRect.top >= innerHeight) continue;

      const reused = previous.find((item) => item.row === row && item.button.dataset.paperTerminalQuickAddress === address);
      const button = reused?.button || document.createElement("button");
      button.type = "button";
      if (!reused) button.textContent = quickConfig.label;
      button.dataset.paperTerminalQuickAddress = address;

      if (!rowPositions.has(row) && getComputedStyle(row).position === "static") {
        rowPositions.set(row, row.style.position);
        row.style.position = "relative";
      }
      if (!reused) button.style.cssText = "all:initial;box-sizing:border-box;position:absolute;z-index:5;width:max-content;max-width:calc(100% - 8px);padding:3px 8px;border:1px solid rgba(143,119,255,.55);border-radius:6px;background:rgba(13,16,22,.96);color:#b9aaff;font:600 12px/1.5 system-ui;letter-spacing:.2px;box-shadow:0 1px 4px #0008;cursor:pointer;pointer-events:auto;white-space:nowrap";
      if (!button.isConnected) row.appendChild(button);
      if (!button.dataset.paperTerminalBusy && !button.dataset.paperTerminalFeedback) button.textContent = quickConfig.label;
      placedPills.push({ row, anchor, button });
    }

    for (const old of previous) if (!placedPills.some(item => item.button === old.button)) {
      old.button.remove(); releaseRowPosition(old.row);
    }
    scheduleReposition();
    document.documentElement.dataset.paperTerminalRows = String(found);
    document.documentElement.dataset.paperTerminalRowDebug = JSON.stringify({
      trenchRoute:true,
      addressLinks: addressLinks.length,
      buyControls: buyCandidates.length,
      rowCandidates: rowCandidates.length,
      found,
      feedColumns:quickFeedRoots.length,
      enabled: !!quickConfig.enabled,
    });
    window.dispatchEvent(new CustomEvent("paper-terminal:rows-ready", { detail: { found } }));
  }

  // -----------------------------------------------------------------------
  // Chart discovery + marker drawing
  // -----------------------------------------------------------------------

  function asChartApi(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    return typeof candidate.createOrderLine === "function" ||
      typeof candidate.createExecutionShape === "function" ||
      typeof candidate.createShape === "function" ||
      typeof candidate.exportData === "function" ||
      !!bubbleInternals(candidate)
      ? candidate
      : null;
  }

  function resolveWidgetChart(widget) {
    if (!widget || (typeof widget !== "object" && typeof widget !== "function")) return null;
    try {
      patchChartFeed(widget._options?.datafeed || widget.options?.datafeed);
      if (typeof widget.activeChart === "function") return asChartApi(widget.activeChart());
      if (typeof widget.getActiveChart === "function") return asChartApi(widget.getActiveChart());
    } catch {
      // widget not ready yet
    }
    return asChartApi(widget);
  }

  function symbolMatches(raw) {
    if (!chartModel) return false;
    const text = String(raw || "").toLowerCase();
    if (!text) return false;
    return [chartModel.address, chartModel.altAddress, chartModel.quoteAddress, ...(chartModel.aliases||[]), chartModel.symbol]
      .filter((value) => value && value !== "TOKEN").some((value) => text.includes(String(value).toLowerCase()));
  }

  function patchChartFeed(feed) {
    if (!feed || patchedFeeds.has(feed) || typeof feed.subscribeBars !== "function") return;
    patchedFeeds.add(feed);
    const subscribe = feed.subscribeBars;
    feed.subscribeBars = function (info, resolution, callback, ...rest) {
      return subscribe.call(this, info, resolution, (bar) => {
        // Never let an extension error interrupt the terminal's chart feed.
        try {
          if (masterEnabled && symbolMatches(info?.ticker || info?.name || info?.symbol) && Number(bar?.close) > 0) {
            if(activeChart && String(activeChart.resolution?.() || '1S')!==String(resolution))return callback(bar);
            lastTickPrice = Number(bar.close);
            lastLiveBarAt = Date.now();
            const time = Number(bar.time);
            if (time > 0) lastBarTimeSec = Math.floor(time > 1e12 ? time / 1000 : time);
            if(activeChart)calibratedChartQuote(activeChart,null,lastTickPrice,true);
            window.dispatchEvent(new CustomEvent("paper-terminal:chart-price", { detail: String(lastTickPrice) }));
            const mode = chartAxis()?.mode;
            if (activeChart && Number(bar.high) > 0 && mode) {
              if (candleCache.chart !== activeChart || candleCache.resolution !== String(resolution) || candleCache.mode !== mode) candleCache = { chart: activeChart, resolution: String(resolution), mode, bars: [] };
              const existing = candleCache.bars.find((item) => item.time === lastBarTimeSec);
              if (existing) existing.high = Math.max(existing.high, Number(bar.high));
              else candleCache.bars.push({ time: lastBarTimeSec, high: Number(bar.high) });
            }
          }
        } catch {}
        return callback(bar);
      }, ...rest);
    };
  }

  // Walks up from a DOM node to the root fiber, then does a bounded
  // breadth-first walk of the whole tree looking for something that looks
  // like a chart widget/API in props or hook state. Used both for iframe
  // wrapper elements and, as of this revision, for self-hosted (non-iframe)
  // chart containers.
  function findWidgetInReactTree(el) {
    try {
      const fiberKey = Object.getOwnPropertyNames(el).find((k) => k.startsWith("__reactFiber$"));
      let fiber = fiberKey ? el[fiberKey] : null;
      while (fiber?.return && typeof fiber.return === "object") fiber = fiber.return;

      const queue = fiber ? [fiber] : [];
      const seen = new Set();
      for (let steps = 0; queue.length && steps < 7000; steps += 1) {
        const node = queue.pop();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        for (const container of [node.memoizedProps, node.memoizedState]) {
          const direct = resolveWidgetChart(container);
          if (direct) return direct;
          let hookState = container;
          for (let hops = 0; hookState && hops < 80; hops += 1) {
            const value = hookState.memoizedState;
            const found = resolveWidgetChart(value?.current) || resolveWidgetChart(value);
            if (found) return found;
            hookState = hookState.next && typeof hookState.next === "object" ? hookState.next : null;
          }
        }
        if (node.child && typeof node.child === "object") queue.push(node.child);
        if (node.sibling && typeof node.sibling === "object") queue.push(node.sibling);
      }
    } catch {
      // best-effort only
    }
    return null;
  }

  // Self-hosted TradingView Advanced Charting Library instances (used by
  // most of these terminals instead of the tradingview.com iframe widget)
  // commonly expose their widget as a global and/or render into a container
  // whose id/class carries a "tradingview"/"tv-chart" hint, with no iframe
  // at all. This list is deliberately broad and best-effort: any one of
  // these resolving to a real chart API is enough.
  function findSelfHostedChartApis() {
    const found = [];
    const push = (candidate) => {
      const api = asChartApi(candidate);
      if (api && !found.includes(api)) found.push(api);
    };

    for (const globalName of ["tvWidget", "widget", "tradingViewWidget", "chartWidget", "__tvWidget"]) {
      try {
        push(resolveWidgetChart(window[globalName]));
      } catch {
        // ignore inaccessible globals
      }
    }

    const containers = document.querySelectorAll(
      '#global-tv-overlay,[id*="tradingview" i]:not(iframe),[class*="tradingview" i]:not(iframe),[class*="tv-chart" i],[data-testid*="chart" i]'
    );
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 120) continue;
      const api = findWidgetInReactTree(container);
      if (api && !found.includes(api)) found.push(api);
    }
    return found;
  }

  function findChartApis() {
    const results = [];
    const record = (chart, score, frame = null) => {
      if (!chart) return;
      try {
        const widget = chart._chartWidget || chart.chartWidget?.();
        const pane = widget?.paneWidgets?.()?.[0]?._div;
        if (pane && !pane.isConnected) return; // stale SPA chart instance
      } catch { return; }
      if (chartModel && typeof chart?.symbol === "function") {
        try { if (!symbolMatches(chart.symbol())) return; } catch { return; }
      }
      if (chart && frame) chartFrameMap.set(chart, frame);
      if (chart && !results.some((r) => r.chart === chart)) results.push({ chart, score });
    };

    for (const iframe of document.querySelectorAll('iframe[id^="tradingview_"]')) {
      try { patchChartFeed(window[iframe.id]?.datafeed); } catch {}
      const rect = iframe.getBoundingClientRect();
      const cx = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const cy = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        document.elementsFromPoint(cx, cy).some((el) => el === iframe || iframe.contains(el));
      const visibilityScore = visible ? 100 : 0;
      try {
        const win = iframe.contentWindow;
        for (const candidate of [win.tradingViewApi, win.tvWidget, win.widget]) {
          record(resolveWidgetChart(candidate), visibilityScore, iframe);
        }
      } catch {
        // cross-origin iframe — can't reach in
      }
      record(iframe.parentElement && findWidgetInReactTree(iframe.parentElement), visibilityScore - 1, iframe);
    }

    for (const chart of findSelfHostedChartApis()) record(chart, 50);

    return results.sort((a, b) => b.score - a.score).map((r) => r.chart);
  }

  function callSafe(target, method, arg) {
    try {
      const fn = target?.[method];
      if (typeof fn === "function") fn.call(target, arg);
    } catch {
      // charting library API surfaces vary; best-effort only
    }
  }

  function clearDrawnObjects() {
    nativeDrawKey = '';
    for (const obj of drawnObjects) {
      try {
        obj.remove?.();
      } catch {
        // already gone
      }
    }
    drawnObjects = [];
  }

  function findVisibleChartElement() {
    return [...document.querySelectorAll(
      'iframe[id*="tradingview" i],iframe[src*="tradingview" i],canvas,[data-testid*="chart" i],[data-chart],[class*="tradingview" i],[class*="chart-container" i],[class*="chart" i]'
    )]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 360 && rect.height >= 180 && rect.bottom > 0 && rect.top < innerHeight;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0] || null;
  }

  function clearBubbleLayer() {
    bubbleNodes.clear();
    bubbleChart = null;
    clearChartLayer(BUBBLE_LAYER_ID);
  }

  function bubbleInternals(chart) {
    try {
      const widget = chart?._chartWidget || (typeof chart?.chartWidget === "function" ? chart.chartWidget() : null);
      if (!widget || typeof widget.paneWidgets !== "function" || typeof widget.model !== "function") return null;
      const pane = widget.paneWidgets()?.[0];
      const model = widget.model();
      const series = model?.mainSeries?.();
      const timeScale = model?.timeScale?.();
      const priceScale = series?.priceScale?.();
      const first = series?.firstValue?.();
      const firstValue = typeof first==='object' && first!==null ? first.value : first;
      if (!pane?._div?.isConnected || !timeScale?.timeToCoordinate || !priceScale?.priceToCoordinate || !Number.isFinite(firstValue)) return null;
      return { paneDiv: pane._div, timeScale, priceScale, firstValue };
    } catch {
      return null;
    }
  }

  function bubbleForGroup(group) {
    const fill = group.point.fill;
    let bubble = bubbleNodes.get(fill.id);
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.dataset.tradeTerminalBubble = fill.id;
      bubble.setAttribute("role", "img");
      bubble.style.cssText = "all:initial;position:absolute;left:0;top:0;width:20px;height:20px;display:block;pointer-events:none;visibility:hidden;filter:drop-shadow(0 1px 2px #0009);will-change:transform";
      bubbleNodes.set(fill.id, bubble);
    }
    const buys = group.fills.filter((item) => item.side === "buy").length;
    const sells = group.fills.length - buys;
    const count = group.fills.length;
    const signature = `${buys}:${sells}`;
    if (bubble.dataset.counts !== signature) {
      const color = buys ? "#35e6b2" : "#ff5575";
      const background = buys ? "#16ac91" : "#f54858";
      const label = buys ? "B" : "S";
      // An explicit SVG center keeps letters stable under host line-height rules.
      // Keep the same clear letter at every zoom. Counts belong in the title.
      bubble.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" style="all:initial;display:block;width:20px;height:20px"><circle cx="10" cy="10" r="9" fill="${background}" stroke="${color}" stroke-width="1.5"/><text x="10" y="10" text-anchor="middle" dominant-baseline="central" style="all:initial;fill:white;font:700 11px Arial,sans-serif;text-anchor:middle;dominant-baseline:central">${label}</text></svg>`;
      bubble.dataset.counts = signature;
    }
    bubble.dataset.fillCount = String(count);
    const description = count === 1
      ? `${buys ? "Buy" : "Sell"} · ${formatRailPrice(fill.marketCap || fill.price)}`
      : `${count} fills: ${buys} buys, ${sells} sells · anchored to latest fill candle · zoom in to separate`;
    if (bubble.title !== description) {
      bubble.title = description;
      bubble.setAttribute("aria-label", description);
    }
    return bubble;
  }

  function groupChartPoints(points, diameter = 20) {
    const groups = [];
    // Bound BOTH dimensions of a group. Transitive overlaps must not combine
    // an entire price plateau into one badge when zoomed far out.
    for (const point of points.slice().sort((a, b) => a.x - b.x || a.fill.timestamp - b.fill.timestamp)) {
      let group = null;
      for (let i = groups.length - 1; i >= 0; i--) {
        const candidate = groups[i];
        if (point.x - candidate.minX > diameter + 2) break;
        if (candidate.point.fill.side === point.fill.side && Math.max(candidate.maxX, point.x) - candidate.minX < diameter + 2 &&
            Math.max(candidate.maxY, point.y) - Math.min(candidate.minY, point.y) < diameter + 2) {
          group = candidate; break;
        }
      }
      if (!group) {
        groups.push({ point, fills: [point.fill], minX: point.x, maxX: point.x, minY: point.y, maxY: point.y });
        continue;
      }
      group.fills.push(point.fill);
      group.maxX = Math.max(group.maxX, point.x);
      group.minY = Math.min(group.minY, point.y);
      group.maxY = Math.max(group.maxY, point.y);
      // Keep an actual candle coordinate, never an average or an upward stack.
      if (point.fill.timestamp >= group.point.fill.timestamp) group.point = point;
    }
    // Opposite sides stay separate, with a small horizontal split when they
    // share a candle. Never stack markers farther above the candle's wick.
    for (let i=0;i<groups.length;i++) {
      const a=groups[i];
      if(a.offsetX !== undefined)continue;
      for(let j=i+1;j<groups.length;j++) {
        const b=groups[j],dx=b.point.x-a.point.x;
        if(b.minX-a.point.x>=diameter+2)break;
        if(b.offsetX !== undefined || a.point.fill.side===b.point.fill.side || Math.abs(dx)>=diameter+2 || Math.abs(a.point.y-b.point.y)>=diameter+2)continue;
        const direction=dx ? Math.sign(dx) : a.point.fill.side==='buy' ? 1 : -1;
        const offset=(diameter+2-Math.abs(dx))/2;
        a.offsetX=-direction*offset;b.offsetX=direction*offset;
        break;
      }
    }
    return groups;
  }

  function chartClipPath(pane, panels, viewport = {width: innerWidth, height: innerHeight}) {
    const left = Math.max(0, pane.left), top = Math.max(0, pane.top);
    const right = Math.min(viewport.width, pane.left + pane.width), bottom = Math.min(viewport.height, pane.top + pane.height);
    if (right <= left || bottom <= top) return 'inset(100%)';
    let visible = [{left,top,right,bottom}];
    // Subtract each occluder into disjoint rectangles. Even/odd holes would
    // accidentally paint again where two floating panels overlap each other.
    for (const panel of (Array.isArray(panels) ? panels : [panels]).filter(Boolean)) {
      const next = [];
      for (const area of visible) {
        const l = Math.max(area.left, panel.left - 1), t = Math.max(area.top, panel.top - 1);
        const r = Math.min(area.right, panel.left + panel.width + 1), b = Math.min(area.bottom, panel.top + panel.height + 1);
        if (r <= l || b <= t) { next.push(area); continue; }
        if (t > area.top) next.push({...area,bottom:t});
        if (b < area.bottom) next.push({...area,top:b});
        if (l > area.left) next.push({left:area.left,top:t,right:l,bottom:b});
        if (r < area.right) next.push({left:r,top:t,right:area.right,bottom:b});
      }
      visible = next;
    }
    return visible.length ? `path("${visible.map(r=>`M ${r.left} ${r.top} H ${r.right} V ${r.bottom} H ${r.left} Z`).join(' ')}")` : 'inset(100%)';
  }

  function chartContextActive(model = chartModel) {
    return masterEnabled && !!model?.address && model.route === location.href &&
      !/\/(?:profile|user|wallet|account|portfolio|track(?:er)?)(?:\/|$)/i.test(location.pathname);
  }

  function clearChartLayer(id) {
    const layer = chartLayers.get(id);
    (layer?.host || document.getElementById(id))?.remove();
    chartLayers.delete(id);
    if (!layer || [...chartLayers.values()].some(other=>other.scope === layer.scope)) return;
    const saved = chartScopes.get(layer.scope);
    if (saved) {
      if (saved.position !== null && layer.scope.style.position === "relative") layer.scope.style.position = saved.position;
      if (layer.scope.style.isolation === "isolate") layer.scope.style.isolation = saved.isolation;
      chartScopes.delete(layer.scope);
    }
  }

  function chartLayer(id, scope) {
    if (!scope?.isConnected || scope === document.body || scope === document.documentElement) return null;
    let layer = chartLayers.get(id);
    if (layer && (layer.scope !== scope || !layer.host.isConnected)) { clearChartLayer(id); layer = null; }
    if (!layer) {
      if (!chartScopes.has(scope)) {
        const position = getComputedStyle(scope).position === "static" ? scope.style.position : null;
        chartScopes.set(scope, {position,isolation:scope.style.isolation});
        if (position !== null) scope.style.position = "relative";
        // Keep even high-z chart annotations below the site's sibling panels.
        scope.style.isolation = "isolate";
      }
      const host = document.createElement("div");
      host.id = id;
      host.style.cssText = "all:initial;position:absolute;z-index:2;pointer-events:none;overflow:hidden;transform-origin:0 0;visibility:hidden";
      scope.appendChild(host);
      layer = {host,scope};
      chartLayers.set(id, layer);
    }
    return layer.host;
  }

  function chartOcclusionRects(scope) {
    const now = Date.now();
    if (!chartOccludersScannedAt || now - chartOccludersScannedAt > 300) {
      chartOccludersScannedAt = now;
      chartOccluders = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],[data-radix-popper-content-wrapper],[data-testid*="profile" i],[data-panel*="profile" i],[data-testid*="instant-trade" i],[data-panel*="instant" i],[aria-label*="instant trade" i]')];
      // Native Instant Trade is sometimes an unlabeled draggable div.
      for (const label of document.querySelectorAll('h1,h2,h3,h4,span,div')) {
        if ((label.childElementCount || 0) > 2 || !/^(?:instant\s*trade|profile)$/i.test(String(label.textContent || "").trim())) continue;
        if (label.closest('#paper-terminal-root')) continue;
        for (let node=label.parentElement,depth=0;node && node!==document.body && depth<8;node=node.parentElement,depth++) {
          const rect = node.getBoundingClientRect();
          if (rect.width >= 180 && rect.height >= 90 && /^(?:fixed|absolute)$/.test(getComputedStyle(node).position)) {
            chartOccluders.push(node); break;
          }
        }
      }
    }
    const own = instantTradeRect();
    const rects = own ? [own] : [];
    for (const node of new Set(chartOccluders)) {
      if (!node.isConnected || node === scope || node.contains(scope)) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    return rects;
  }

  function positionChartLayer(host, scope, rect) {
    if (!host || !chartContextActive() || !scope.isConnected || rect.width <= 0 || rect.height <= 0) {
      if (host) host.style.visibility = "hidden";
      return false;
    }
    const bounds = scope.getBoundingClientRect();
    const style = getComputedStyle(scope);
    if (bounds.width <= 0 || bounds.height <= 0 || style.visibility === "hidden" || style.display === "none") { host.style.visibility = "hidden"; return false; }
    const sx = scope.offsetWidth ? bounds.width / scope.offsetWidth : 1;
    const sy = scope.offsetHeight ? bounds.height / scope.offsetHeight : 1;
    host.style.left = `${(rect.left - bounds.left) / sx - (scope.clientLeft || 0) + (scope.scrollLeft || 0)}px`;
    host.style.top = `${(rect.top - bounds.top) / sy - (scope.clientTop || 0) + (scope.scrollTop || 0)}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
    // Children use screen pixels; cancel parent scale without scaling type.
    host.style.transform = `scale(${1 / sx},${1 / sy})`;
    const panels = chartOcclusionRects(scope).map(r=>({left:r.left-rect.left,top:r.top-rect.top,width:r.width,height:r.height}));
    const pane = {left:Math.max(0,-rect.left),top:Math.max(0,-rect.top),width:Math.min(rect.width,innerWidth-rect.left)-Math.max(0,-rect.left),height:Math.min(rect.height,innerHeight-rect.top)-Math.max(0,-rect.top)};
    host.style.clipPath = chartClipPath(pane, panels, {width:rect.width,height:rect.height});
    host.style.visibility = "visible";
    return true;
  }

  function instantTradeRect() {
    return document.getElementById("paper-terminal-root")?.shadowRoot?.querySelector(".wrap")?.getBoundingClientRect() || null;
  }

  function hideChartOverlay() {
    const host = chartLayers.get(BUBBLE_LAYER_ID)?.host;
    if (host) host.style.visibility = "hidden";
    for (const node of bubbleNodes.values()) node.style.visibility = "hidden";
  }

  function candleAtOrBefore(bars, seconds) {
    let lo = 0, hi = bars.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (bars[mid].time <= seconds) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }

  function fillCandleAnchor(fill, resolution, bars, mode) {
    const key = `${fill.id}:${resolution}:${mode}`;
    let anchor = fillAnchors.get(key);
    if (!anchor) {
      const index = candleAtOrBefore(bars, Math.floor(fill.timestamp / 1000));
      if (index < 0) return null;
      const bar = bars[index];
      const value=Number(String(resolution).replace(/[SDW]$/i,'')) || 1;
      const seconds=/S$/i.test(resolution)?value:/D$/i.test(resolution)?value*86400:/W$/i.test(resolution)?value*604800:value*60;
      if (fill.timestamp/1000 >= bar.time+seconds) return null;
      anchor = { time: bar.time, high: bar.high };
      fillAnchors.set(key, anchor);
      if (fillAnchors.size > 6000) fillAnchors.delete(fillAnchors.keys().next().value);
    }
    const index = candleAtOrBefore(bars, anchor.time);
    if (bars[index]?.time === anchor.time) anchor.high = bars[index].high;
    return anchor;
  }

  function fillMarkerAnchor(fill, resolution, bars, mode, factor) {
    const candle = fillCandleAnchor(fill, resolution, bars, mode);
    if (candle) return candle;
    const level = Number(fill.levels?.[mode]) || (mode==='mcap' ? Number(fill.marketCap) : 0) || Number(fill.price)*factor;
    const value = Number(String(resolution).replace(/[SDWM]$/i,'')) || 1;
    const seconds = /S$/i.test(resolution)?value:/D$/i.test(resolution)?value*86400:/W$/i.test(resolution)?value*604800:/M$/i.test(resolution)?0:value*60;
    if (!(level>0) || !(seconds>0) || !(fill.timestamp>0)) return null;
    // Missing OHLC must not hide a committed fill. Use its execution level,
    // never a neighbouring candle's high, until the actual candle loads.
    return {time:Math.floor(fill.timestamp/1000/seconds)*seconds,high:level};
  }

  function layoutChartBubbles(chart) {
    try { return layoutChartBubblesUnsafe(chart); }
    catch (error) {
      // A scale may be rebuilt mid-pan. Never strand the overlay at its last
      // screen position or let one transient exception stop future frames.
      hideChartOverlay();
      document.documentElement.dataset.paperTerminalChartError = `Chart rebuilding: ${String(error.message || error).slice(0, 120)}`;
      return false;
    }
  }

  function layoutChartBubblesUnsafe(chart) {
    if (!chartContextActive() || (!chartModel.fills?.length && !(chartModel.avgBuy > 0) && !(chartModel.avgSell > 0))) { hideChartOverlay(); return false; }
    const internals = bubbleInternals(chart);
    if (!internals) { hideChartOverlay(); return false; }
    bubbleChart = chart;
    const paneRect = internals.paneDiv.getBoundingClientRect();
    const frame = chartFrameMap.get(chart);
    // A parent React wrapper can expose a top-document chart API as well as
    // the iframe API. Add frame offsets ONLY for a pane inside that frame.
    const paneFrame = internals.paneDiv.ownerDocument !== document ? internals.paneDiv.ownerDocument?.defaultView?.frameElement : null;
    const ownerFrame = paneFrame || (frame && internals.paneDiv.ownerDocument !== document ? frame : null);
    const frameRect = ownerFrame?.getBoundingClientRect?.() || { left: 0, top: 0 };
    if (paneRect.width <= 0 || paneRect.height <= 0 || (ownerFrame && !ownerFrame.isConnected)) { hideChartOverlay(); return false; }
    const axis = chartAxis();
    if (!axis) { hideChartOverlay(); return false; }
    const frameScaleX = ownerFrame?.offsetWidth ? frameRect.width / ownerFrame.offsetWidth : 1;
    const frameScaleY = ownerFrame?.offsetHeight ? frameRect.height / ownerFrame.offsetHeight : 1;
    const scaleX = (internals.paneDiv.offsetWidth ? paneRect.width / internals.paneDiv.offsetWidth : 1) * frameScaleX;
    const scaleY = (internals.paneDiv.offsetHeight ? paneRect.height / internals.paneDiv.offsetHeight : 1) * frameScaleY;
    const paneLeft = frameRect.left + (paneRect.left + (ownerFrame?.clientLeft || 0)) * frameScaleX;
    const paneTop = frameRect.top + (paneRect.top + (ownerFrame?.clientTop || 0)) * frameScaleY;
    const paneWidth = paneRect.width * frameScaleX;
    const paneHeight = paneRect.height * frameScaleY;
    const scope = ownerFrame ? ownerFrame.parentElement : internals.paneDiv;
    const host = chartLayer(BUBBLE_LAYER_ID, scope);
    if (!positionChartLayer(host, scope, {left:paneLeft,top:paneTop,width:paneWidth,height:paneHeight})) { hideChartOverlay(); return false; }
    // Own scale-aligned lines provide full-width dotted levels and explicit
    // in-pane badges even on builds without broker/order-line primitives.
    for (const [side, average, color] of [["buy", chartModel.avgBuy, "#42cbb9"], ["sell", chartModel.avgSell, "#ff5965"]]) {
      let line = host.querySelector(`[data-average="${side}"]`);
      if (!(average > 0)) { line?.remove(); continue; }
      if (!line) {
        line = document.createElement("div");
        line.dataset.average = side;
        line.style.cssText = `position:absolute;border-top:1px dashed ${color};height:0;pointer-events:none`;
        const label = document.createElement("span");
        label.style.cssText = `position:absolute;right:5px;bottom:13px;color:${color};font:600 11px Inter,system-ui;white-space:nowrap`;
        label.textContent = side === "buy" ? "Avg Buy" : "Avg Sell";
        const badge = document.createElement("b");
        badge.style.cssText = `position:absolute;right:0;top:-10px;padding:3px 5px;background:${color};color:#081b1c;font:600 11px Inter,system-ui;white-space:nowrap`;
        line.append(label, badge); host.appendChild(line);
      }
      const savedLevel = chartModel.averageLevels?.[side]?.[axis.mode];
      const level = savedLevel > 0 ? savedLevel : average * axis.factor;
      let coordinate;
      try { coordinate = internals.priceScale.priceToCoordinate(level, internals.firstValue); } catch { coordinate = null; }
      const y = Number.isFinite(coordinate) ? coordinate * scaleY : NaN;
      line.style.display = Number.isFinite(y) && y >= 0 && y <= paneHeight ? "block" : "none";
      line.style.left = "0px"; line.style.top = `${y}px`; line.style.width = `${paneWidth}px`;
      line.querySelector("b").textContent = formatRailPrice(level).replace(/^\$/, "");
    }
    const liveIds = new Set();
    const resolution = String(chart.resolution?.() || "1S");
    const bars = candleCache.chart === chart && candleCache.resolution === resolution && candleCache.mode === axis.mode ? candleCache.bars : [];
    const points = [];
    for (const fill of (chartModel.fills || [])) {
      const anchor = fillMarkerAnchor(fill, resolution, bars, axis.mode, axis.factor);
      if (!anchor) continue;
      let x, y;
      try { x = internals.timeScale.timeToCoordinate(anchor.time); } catch { x = null; }
      try { y = internals.priceScale.priceToCoordinate(anchor.high, internals.firstValue); } catch { y = null; }
      // Never let a missing coordinate coerce to zero during scale conversion.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x *= scaleX; y *= scaleY;
      if (x < 0 || x > paneWidth || y < 0 || y > paneHeight) continue;
      points.push({ fill, time: anchor.time, x, y });
    }
    for (const group of groupChartPoints(points)) {
      const { fill, time, x, y } = group.point;
      liveIds.add(fill.id);
      const bubble = bubbleForGroup(group);
      if (bubble.parentNode !== host) host.appendChild(bubble);
      // Fixed SCREEN-pixel clearance above this candle's wick. Neighbouring
      // highs and the number of trades never push the marker farther upward.
      const left = x + (group.offsetX || 0) - 10;
      const top = y - 20 - 4;
      const transform = `translate3d(${left.toFixed(1)}px,${top.toFixed(1)}px,0)`;
      bubble.dataset.candleTime = String(time);
      if (bubble.style.transform !== transform) bubble.style.transform = transform;
      if (bubble.style.visibility !== "visible") bubble.style.visibility = "visible";
    }
    for (const [id, bubble] of bubbleNodes) {
      if (liveIds.has(id)) continue;
      bubble.remove();
      bubbleNodes.delete(id);
    }
    return true;
  }

  function scheduleBubbleLayout() {
    if (bubbleFrameQueued) return;
    bubbleFrameQueued = true;
    requestAnimationFrame(function step() {
      bubbleFrameQueued = false;
      if (!chartContextActive()) { resetChartState(); return; }
      if (!bubbleChart || !document.getElementById(BUBBLE_LAYER_ID)) return;
      try { layoutChartBubbles(bubbleChart); }
      finally {
        if (chartContextActive() && bubbleChart) {
          bubbleFrameQueued = true;
          requestAnimationFrame(step);
        }
      }
    });
  }

  function formatRailPrice(value) {
    const price = Number(value);
    if (!(price > 0)) return "—";
    if (price >= 1000) return `$${Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(price)}`;
    if (price >= 1) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
    return `$${price.toPrecision(4)}`;
  }

  let chartUnits=new WeakMap();
  function calibratedChartQuote(chart, rows, raw, changed) {
    const data=loadedSeriesRows(chart) || rows;
    const schema=data?.schema?.map(x=>String(x?.name || x?.title || x).toLowerCase()) || [];
    const ti=schema.findIndex(x=>x==='time'),oi=schema.findIndex(x=>x==='open');
    if(ti<0 || oi<0 || !Array.isArray(data?.data) || !data.data.length)return;
    const bars=data.data.map(row=>({time:Number(row[ti])>1e12?Number(row[ti])/1000:Number(row[ti]),open:Number(row[oi])})).filter(b=>b.time>0&&b.open>0);
    if(!bars.length)return;
    let held=chartUnits.get(chart);
    const reference=held && bars.find(b=>b.time===held.time);
    if(held && (held.address!==chartModel.address || held.resolution!==String(chart.resolution?.()) || !reference || Math.abs(reference.open/held.open-1)>1e-6)) {
      chartUnits.delete(chart);held=null;
    }
    const supply=Number(chartModel.supply),sol=Number(chartModel.solPrice);
    const choices=[{mode:'usd',factor:1},...(supply>0?[{mode:'mcap',factor:supply}]:[]),...(sol>0?[{mode:'native',factor:1/sol},...(supply>0?[{mode:'native-mcap',factor:supply/sol}]:[])]:[])];
    if(!held) {
      // Establish units against a fresh independently typed quote, not merely
      // the closest candidate. Historical candle opens detect unit switches.
      if(Date.now()-Number(chartModel.priceUpdatedAt)>3000 || !Number(chartModel.priceUpdatedAt))return;
      const matching=choices.filter(c=>Math.abs(raw/(chartModel.currentPrice*c.factor)-1)<.025);
      if(matching.length!==1)return;
      held={...matching[0],address:chartModel.address,resolution:String(chart.resolution?.()),...bars[0]};chartUnits.set(chart,held);
    }
    const factor=choices.find(c=>c.mode===held.mode)?.factor;
    if(!(factor>0) || !changed)return;
    const price=raw/factor;
    if(!(price>0) || !Number.isFinite(price))return;
    // A current token-identified terminal cap is independent evidence. A
    // disagreeing chart scale must not turn a modest gain into a huge one.
    const independent=chartModel.independentQuote;
    if(independent?.source==='detail-cap' && Date.now()-independent.at<3000 && Math.abs(price/independent.price-1)>.05)return;
    window.dispatchEvent(new CustomEvent('paper-terminal:chart-quote',{detail:JSON.stringify({address:chartModel.address,route:chartModel.route,price,supply,observedAt:Date.now()})}));
  }

  function chartAxis() {
    if (!(chartModel?.currentPrice > 0) || !(lastTickPrice > 0)) return null;
    const price = chartModel.currentPrice;
    const supply = chartModel.supply || chartModel.currentMarketCap / price;
    const sol = chartModel.solPrice;
    const choices = [{ mode: "usd", factor: 1 }];
    if (supply > 0) choices.push({ mode: "mcap", factor: supply });
    if (sol > 0) {
      choices.push({ mode: "native", factor: 1 / sol });
      if (supply > 0) choices.push({ mode: "native-mcap", factor: supply / sol });
    }
    const calibrated=chartUnits.get(activeChart);
    if(calibrated?.address===chartModel.address)return choices.find(c=>c.mode===calibrated.mode) || null;
    const matches = choices.filter(choice=>Math.abs(lastTickPrice/(price*choice.factor)-1)<.05);
    return matches.length===1 ? matches[0] : null;
  }

  // The old corner summary is intentionally removed. Wait for an actual
  // chart scale instead of rendering fill/market-cap information elsewhere.
  function renderChartRail() {
    clearChartLayer(CHART_RAIL_ID);
  }

  async function drawNativeChartModel(chart, axis, model, generation) {
    if (typeof chart.createShape !== 'function' || typeof chart.removeEntity !== 'function') return false;
    const resolution = String(chart.resolution?.() || '1S');
    const bars = candleCache.chart===chart && candleCache.mode===axis.mode && candleCache.resolution===resolution ? candleCache.bars : [];
    const drawings = [];
    const time = Math.floor(Date.now()/1000);
    for (const side of ['buy','sell']) {
      const average = side==='buy' ? model.avgBuy : model.avgSell;
      const price = model.averageLevels?.[side]?.[axis.mode] || average*axis.factor;
      if (average>0 && price>0) drawings.push({point:{time,price},shape:'horizontal_line',text:side==='buy'?'Avg Buy':'Avg Sell',color:side==='buy'?'#42cbb9':'#ff5965'});
    }
    for (const fill of model.fills || []) {
      const candle = fillCandleAnchor(fill,resolution,bars,axis.mode);
      const price = Number(fill.levels?.[axis.mode]) || fill.price*axis.factor;
      // Public drawings snap missing times to nearby bars. Wait for the real
      // candle so a trade cannot silently move to an unrelated timestamp.
      if (candle && price>0) drawings.push({point:{time:candle.time,price},shape:fill.side==='buy'?'arrow_up':'arrow_down',text:fill.side==='buy'?'B':'S',color:fill.side==='buy'?'#42cbb9':'#ff5965'});
    }
    for (const drawing of drawings) {
      if (generation!==chartDrawGeneration || !chartContextActive(model)) return false;
      try {
        const id = await chart.createShape(drawing.point,{shape:drawing.shape,text:drawing.text,lock:true,disableSelection:true,disableSave:true,disableUndo:true,showInObjectsTree:false,overrides:{linecolor:drawing.color,textcolor:drawing.color,arrowColor:drawing.color,linewidth:1,linestyle:2,fontsize:11,showLabel:true}});
        if (id==null) continue;
        const object = {createdAt:Date.now(),verifiable:typeof chart.getShapeById==='function',remove:()=>chart.removeEntity(id),exists:()=>{
          if(typeof chart.getShapeById!=='function')return true;
          try{return !!chart.getShapeById(id);}catch{return false;}
        }};
        if (generation!==chartDrawGeneration || !chartContextActive(model)) object.remove();
        else drawnObjects.push(object);
      } catch {}
    }
    return drawings.length>0 && drawnObjects.length===drawings.length;
  }

  let nativeDrawPending = null;
  async function drawChartModel() {
    if (!chartContextActive()) { resetChartState(); return; }
    const model = chartModel;
    const charts = findChartApis();
    if (!charts.length) {
      hideChartOverlay();
      document.documentElement.dataset.paperTerminalChart = "api-not-found";
      renderChartRail();
      return;
    }
    const chart = charts[0];
    const key = JSON.stringify([model.address,chartAxis()?.mode,model.avgBuy,model.avgSell,model.averageLevels,model.fills,candleCache.bars.length]);
    // Slow public drawing APIs must finish before an identical retry starts.
    // Otherwise each poll invalidates the previous drawing before it appears.
    if(nativeDrawPending?.chart===chart && nativeDrawPending.key===key && nativeDrawPending.generation===chartDrawGeneration && Date.now()-nativeDrawPending.at<10000 && !bubbleInternals(chart))return;
    if (activeChart===chart && nativeDrawKey===key && drawnObjects.length && drawnObjects.every(object=>object.exists?.()!==false) && !bubbleInternals(chart)) return;
    const generation = ++chartDrawGeneration;
    if (activeChart === chart) clearDrawnObjects();
    else {
      clearDrawnObjects();
      activeChart = chart;
    }

    const axis = chartAxis();
    if (!axis) { hideChartOverlay(); renderChartRail(); return; }
    axisMode = axis.mode;
    if (layoutChartBubbles(chart)) {
      scheduleBubbleLayout();
      clearChartLayer(CHART_RAIL_ID);
      document.documentElement.dataset.paperTerminalChart = `scale-overlay:${axis.mode}`;
      return;
    }
    // Retry when a private/rebuilding scale becomes available. Keep all
    // drawings in the chart pane, with no corner-summary fallback.
    clearBubbleLayer();
    renderChartRail();
    const pending={chart,key,generation,at:Date.now()};nativeDrawPending=pending;
    let drawn=false;
    try { drawn=await drawNativeChartModel(chart,axis,model,generation); }
    finally { if(nativeDrawPending===pending)nativeDrawPending=null; }
    if(generation!==chartDrawGeneration)return;
    if (drawn) {
      if (generation===chartDrawGeneration) nativeDrawKey=key;
      return;
    }
    document.documentElement.dataset.paperTerminalChart = "waiting-for-chart-scale";
    window.dispatchEvent(new CustomEvent("paper-terminal:chart-ready"));
  }

  // Best-effort extraction of "the latest close price" out of whatever
  // shape a chart's exportData() call returns — this varies a lot between
  // charting-library versions.
  function extractLatestPrice(exported) {
    if (exported && typeof exported === "object") {
      const data = exported;
      if (data.data && data.data.length) {
        let closeIndex = -1;
        if (Array.isArray(data.schema)) {
          const idx = data.schema.findIndex(
            (s) => [typeof s === "string" ? s : s?.plotTitle,s?.sourceTitle,s?.name].some(value=>/^close$/i.test(String(value||"")))
          );
          if (idx >= 0) closeIndex = idx;
        }
        if (closeIndex < 0) return 0;
        const timeIndex=data.schema.findIndex(s=>[typeof s==='string'?s:s?.plotTitle,s?.name].some(v=>/^time$/i.test(String(v||''))));
        if(timeIndex<0)return 0;
        const lastRow = data.data.reduce((latest,row)=>Number(row[timeIndex])>Number(latest?.[timeIndex] ?? -Infinity)?row:latest,null);
        const value = Number(lastRow?.[closeIndex]);
        if (value > 0 && Number.isFinite(value)) return value;
      }
    }
    if (typeof exported === "string") {
      const lines = exported.trim().split(/\r?\n/);
      const closeIndex = lines[0].split(",").findIndex((cell) => /^(close|closing price)$/i.test(cell.replaceAll('"', "").trim()));
      if (closeIndex < 0) return 0; // Last numeric column is often VOLUME.
      for (const line of lines.slice(1).reverse()) {
        const close = Number(line.split(",")[closeIndex]?.replaceAll('"', ""));
        if (close > 0 && Number.isFinite(close)) return close;
      }
    }
    const visited = new Set();
    const points = [];
    const walk = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value.slice(-500)) walk(item, depth + 1);
        return;
      }
      const close = Number(value.close ?? value.Close);
      const time = Number(value.time ?? value.timestamp ?? value.Time ?? 0);
      if (close > 0 && Number.isFinite(close)) points.push({ time, price: close });
      for (const child of Object.values(value).slice(0, 100)) walk(child, depth + 1);
    };
    walk(exported, 0);
    points.sort((a, b) => a.time - b.time);
    return points.at(-1)?.price || 0;
  }

  function extractCandleBars(exported) {
    let schema = exported?.schema;
    let rows = exported?.data;
    if (typeof exported === "string") {
      const lines = exported.trim().split(/\r?\n/).map((line) => line.split(",").map((cell) => cell.replaceAll('"', "").trim()));
      schema = lines.shift(); rows = lines;
    }
    if (!Array.isArray(rows)) return [];
    const column = (name, fallback) => {
      if (!Array.isArray(schema)) return fallback;
      const index = schema.findIndex((field) => String(typeof field === "string" ? field : field.plotTitle || field.sourceTitle || field.name).toLowerCase() === name);
      return index;
    };
    const timeIndex = column("time", 0), highIndex = column("high", 2);
    if (timeIndex < 0 || highIndex < 0) return [];
    return rows.slice(-20000).map((row) => {
      const time = Number(row[timeIndex]), high = Number(row[highIndex]);
      return { time: Math.floor(time > 1e12 ? time / 1000 : time), high };
    }).filter((bar) => bar.time > 0 && bar.high > 0 && Number.isFinite(bar.high)).sort((a, b) => a.time - b.time);
  }

  function mergeCandleBars(previous, incoming) {
    const merged = new Map(previous.map((bar) => [bar.time, bar]));
    for (const bar of incoming) {
      const older = merged.get(bar.time);
      merged.set(bar.time, { time: bar.time, high: Math.max(older?.high || 0, bar.high) });
    }
    return [...merged.values()].sort((a, b) => a.time - b.time).slice(-20000);
  }

  // Some host builds omit exportData or disable it before chart readiness.
  // The main series' loaded OHLC rows are already in chart units; use only
  // its explicit bar store (never an indicator or arbitrary numeric field).
  function loadedSeriesRows(chart){
    try{
      const widget=chart?._chartWidget || chart?.chartWidget?.();
      const model=widget?.model?.(),main=(typeof model?.model==='function'?model.model():model)?.mainSeries?.();
      const bars=main?.bars?.() || main?.data?.();
      const items=bars?._items || bars?._rows;
      if(!Array.isArray(items))return null;
      const data=items.slice(-20000).map(item=>item?.value || item).filter(row=>Array.isArray(row)&&row.length>=5&&row.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(row[0])>0&&Number(row[2])>=Math.max(Number(row[1]),Number(row[3]),Number(row[4]))&&Number(row[3])>0);
      return data.length?{schema:['time','open','high','low','close'],data}:null;
    }catch{return null;}
  }
  let lastExportObservation=null;
  async function pollChartPrice() {
    if (!masterEnabled || !chartModel) return;
    if ((Date.now() - lastLiveBarAt < 1000 && Date.now() - lastCandleExportAt < 1000) || (exportStartedAt && Date.now() - exportStartedAt < 5000)) return;
    const modelAddress = chartModel.address;
    let chart = activeChart;
    try {
      const widget = chart?._chartWidget || chart?.chartWidget?.();
      if (widget?.paneWidgets?.()?.[0]?._div?.isConnected === false) chart = null;
    } catch { chart = null; }
    chart ||= findChartApis()[0];
    if (!chart) return;
    if (chartModel && activeChart !== chart) drawChartModel();
    if (typeof chart.exportData !== "function" && !loadedSeriesRows(chart)) return;
    const seq = ++exportSeq;
    const resolution = String(chart.resolution?.() || "1S");
    exportStartedAt = Date.now();
    try {
      const oldestFill = Math.min(Date.now() - 600000, ...chartModel.fills.map((fill) => fill.timestamp));
      let rows=loadedSeriesRows(chart);
      if(!extractCandleBars(rows).length || !extractLatestPrice(rows))try { rows = await chart.exportData?.({ from: Math.floor(oldestFill / 1000) - 60, includeTime: true, includeSeries: true, includedStudies: [] }); } catch {}
      if (!extractCandleBars(rows).length || !extractLatestPrice(rows)) rows=loadedSeriesRows(chart) || rows;
      const exported = extractLatestPrice(rows);
      if (!masterEnabled || seq !== exportSeq || chartModel?.address !== modelAddress || String(chart.resolution?.() || "1S") !== resolution) return;
      const time = extractCandleBars(rows).at(-1)?.time || 0;
      const changed = lastExportObservation?.chart!==chart || lastExportObservation?.resolution!==resolution || lastExportObservation?.time!==time || lastExportObservation?.price!==exported;
      lastExportObservation={chart,resolution,time,price:exported};
      calibratedChartQuote(chart,rows,exported,changed);
      if (time > 0 && Date.now() - lastLiveBarAt >= 1000) lastBarTimeSec = Math.floor(time > 1e12 ? time / 1000 : time);
      if (exported > 0 && Date.now() - lastLiveBarAt >= 1000) {
        const wasFirstTick = !(lastTickPrice > 0);
        lastTickPrice = exported;
        if(changed)window.dispatchEvent(new CustomEvent("paper-terminal:chart-price", { detail: String(exported) }));
        if ((wasFirstTick || chartAxis()?.mode !== axisMode) && chartModel) drawChartModel();
      }
      const mode = chartAxis()?.mode || "";
      const bars = extractCandleBars(rows);
      // Do not roll a live wick back to the older exported snapshot.
      if (candleCache.chart === chart && candleCache.resolution === resolution && candleCache.mode === mode && lastLiveBarAt >= exportStartedAt) {
        const latest = candleCache.bars.find((bar) => bar.time === lastBarTimeSec);
        const exportedBar = bars.find((bar) => bar.time === lastBarTimeSec);
        if (latest && exportedBar) exportedBar.high = Math.max(exportedBar.high, latest.high);
        else if (latest) bars.push(latest);
      }
      const matchingCache = candleCache.chart === chart && candleCache.resolution === resolution && candleCache.mode === mode;
      candleCache = { chart, resolution, mode, bars: mergeCandleBars(matchingCache ? candleCache.bars : [], bars) };
      lastCandleExportAt = Date.now();
      if (!bubbleChart) drawChartModel();
      else if (layoutChartBubbles(chart)) scheduleBubbleLayout();
      else drawChartModel();
    } catch {
      // chart not ready / API surface mismatch
    } finally {
      if (seq === exportSeq) exportStartedAt = 0;
    }
  }

  function resetChartState() {
    chartUnits=new WeakMap();
    chartModel = null;
    lastExportObservation=null;
    activeFeedIds = new Set();
    chartModelSignature = "";
    chartDrawGeneration += 1;
    lastTickPrice = 0;
    lastBarTimeSec = 0;
    lastLiveBarAt = 0;
    lastCandleExportAt = 0;
    candleCache = { chart: null, resolution: "", mode: "", bars: [] };
    axisMode = "";
    fillAnchors.clear();
    exportSeq++;
    exportStartedAt = 0;
    activeChart = null;
    clearDrawnObjects();
    clearBubbleLayer();
    clearChartLayer(CHART_RAIL_ID);
  }

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------

  window.addEventListener("paper-terminal:chart-model", (event) => {
    if (!masterEnabled) return;
    let nextModel;
    try {
      nextModel = JSON.parse(event.detail);
    } catch {
      resetChartState();
      return;
    }
    if (!chartContextActive(nextModel)) { resetChartState(); return; }
    if (chartModel?.address !== nextModel.address) {
      candleCache = { chart: null, resolution: "", mode: "", bars: [] };
      fillAnchors.clear();
      lastTickPrice = 0;
      lastBarTimeSec = 0;
      lastLiveBarAt = 0;
      activeChart = null;
      chartDrawGeneration++;
      exportSeq++;
      exportStartedAt = 0;
      clearDrawnObjects();
      clearBubbleLayer();
      clearChartLayer(CHART_RAIL_ID);
    }
    chartModel = nextModel;
    activeFeedIds = new Set([chartModel.address, chartModel.altAddress, chartModel.quoteAddress, ...(chartModel.aliases||[])].filter(Boolean));
    const signature = JSON.stringify({
      address: chartModel.address,
      avgBuy: chartModel.avgBuy || 0,
      avgSell: chartModel.avgSell || 0,
      fills: (chartModel.fills || []).map((fill) => [fill.id, fill.side, fill.price, fill.marketCap, fill.timestamp]),
    });
    if (signature !== chartModelSignature) {
      chartModelSignature = signature;
      drawChartModel();
    } else if (bubbleChart) {
      if (layoutChartBubbles(bubbleChart)) scheduleBubbleLayout();
      else drawChartModel();
    } else {
      // The same widget can become ready after its first model event.
      drawChartModel();
    }
  });

  window.addEventListener("paper-terminal:chart-clear", resetChartState);

  window.addEventListener("paper-terminal:chart-refresh", event => {
    if (!masterEnabled || !chartModel || event.detail !== location.href || !chartContextActive()) return;
    // Host SPAs replace their chart and datafeed objects without a route
    // change. Rediscover subscriptions and retry annotations immediately.
    const charts=findChartApis();
    if(charts[0] && activeChart!==charts[0])activeChart=null;
    if(!bubbleChart)nativeDrawKey='';
    pollChartPrice();
    drawChartModel();
  });

  window.addEventListener("paper-terminal:quick-config", (event) => {
    try {
      const next = JSON.parse(event.detail);
      if (next.enabled === quickConfig.enabled && next.label === quickConfig.label) return;
      quickConfig = { ...next, enabled: masterEnabled && !!next.enabled };
    } catch {
      // ignore malformed payload
    }
    if (!quickConfig.enabled) {
      clearQuickPills();
    } else scheduleScan();
  });

  window.addEventListener("paper-terminal:master-toggle", (event) => {
    masterEnabled = event.detail === "on";
    if (masterEnabled) return;
    quickConfig.enabled = false;
    clearQuickPills();
    lastFeedSignature = "";
    feedLastEmitById.clear();
    window.dispatchEvent(new CustomEvent("paper-terminal:chart-clear"));
  });

  const onPillInteraction = (event) => {
    const pill = event.target?.closest?.("[data-paper-terminal-quick-address]");
    if (!pill) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    // Execute on pointerdown so a virtualized row cannot navigate/unmount
    // between press and click. A zero-detail click preserves keyboard access.
    const shouldExecute = event.type === "pointerdown" || (event.type === "click" && event.detail === 0);
    if (!masterEnabled || !quickConfig.enabled || !shouldExecute || pill.dataset.paperTerminalBusy === "1") return;
    const origin = placedPills.find(item=>item.button===pill);
    if (!origin || !allowedQuickRow(origin.row)) return;
    pill.dataset.paperTerminalBusy = "1";
    delete pill.dataset.paperTerminalFeedback;
    pill.dataset.paperTerminalOriginalLabel = pill.textContent;
    pill.textContent = quickConfig.label;
    pill.setAttribute("aria-busy", "true");
    pill.style.opacity = ".55";
    const placed = placedPills.find((item) => item.button === pill);
    const quote = placed ? readQuickRowQuote(placed.row, pill.dataset.paperTerminalQuickAddress) : null;
    window.dispatchEvent(
      new CustomEvent("paper-terminal:quick-buy", {
        detail: JSON.stringify(quote || { address: pill.dataset.paperTerminalQuickAddress || "" }),
      })
    );
  };
  window.addEventListener('pointerover',event=>{
    if(!masterEnabled || !quickConfig.enabled)return;
    const placed=placedPills.find(item=>item.row.contains(event.target));
    if(!placed)return;
    const quote=readQuickRowQuote(placed.row,placed.button.dataset.paperTerminalQuickAddress);
    if(!quote?.mint || quote.supply>0 || (quote.price>0 && !quote.displayedMarketCap))return;
    if(Date.now()-(warmedMints.get(quote.mint)||0)<10000)return;
    warmedMints.set(quote.mint,Date.now());
    if(warmedMints.size>300)warmedMints.delete(warmedMints.keys().next().value);
    window.dispatchEvent(new CustomEvent('paper-terminal:prewarm',{detail:quote.mint}));
  },true);
  window.addEventListener("paper-terminal:quote-request", (event) => {
    if (!masterEnabled) return;
    let request; try { request = JSON.parse(event.detail); } catch { return; }
    const placed = placedPills.find((item) => item.button.dataset.paperTerminalQuickAddress === request.address && item.row.isConnected);
    let quote = placed ? readQuickRowQuote(placed.row, request.address) : null;
    // Detail pages have no trench pill. Read only records tied to the active
    // route, not an arbitrary other token from a sidebar or wallet panel.
    if (!quote && request.detail && addressFromHref(location.href)===request.address && !/\/(profile|wallet|tracker)(\/|$)/i.test(location.pathname)) {
      const props=quoteFromReactFiber(document.querySelector('main') || document.body,request.address);
      const live=rowFeedQuotes.get(request.address) || rowFeedQuotes.get(props?.mint);
      const fresh=live && Date.now()-live.priceObservedAt<=3000;
      if(props || fresh) {
        quote={...props,...(fresh?live:{}),address:request.address,rowAddress:request.address,quoteSource:fresh?'row-feed':'row-props',priceObservedAt:fresh?live.priceObservedAt:Date.now(),observedAt:Date.now()};
        const cap=detailDisplayedCap(props);
        if(cap>0)quote={...quote,displayedMarketCap:cap,marketCap:cap,quoteSource:'detail-cap'};
      }
    }
    window.dispatchEvent(new CustomEvent("paper-terminal:row-quote", { detail: JSON.stringify({ requestId: request.requestId, quote }) }));
  });
  for (const type of ["pointerdown", "click"]) {
    window.addEventListener(type, onPillInteraction, true);
  }

  window.addEventListener("paper-terminal:quick-buy-done", (event) => {
    if (!masterEnabled) return;
    let result = { ok: false, message: "Quick buy failed", address: "" };
    try { result = JSON.parse(event.detail); } catch {}
    for (const pill of document.querySelectorAll("[data-paper-terminal-quick-address]")) {
      if (result.address && pill.dataset.paperTerminalQuickAddress !== result.address) continue;
      delete pill.dataset.paperTerminalBusy;
      pill.removeAttribute("aria-busy");
      pill.style.opacity = "1";
      pill.style.borderColor = result.ok ? "#28d5a3" : "#ff6577";
      pill.style.color = result.ok ? "#63f3c9" : "#ff8a9a";
      const reason = /quote|price|contract/i.test(result.message) ? "No quote" : /balance/i.test(result.message) ? "Low balance" : /slippage/i.test(result.message) ? "Slippage" : /off|cancelled/i.test(result.message) ? "Off" : /another tab/i.test(result.message) ? "Retry order" : "Buy failed";
      const feedback = String(Date.now());
      pill.dataset.paperTerminalFeedback = feedback;
      pill.textContent = result.ok ? quickConfig.label : reason;
      scheduleReposition();
      pill.title = result.message || "";
      window.setTimeout(() => {
        if (!pill.isConnected || pill.dataset.paperTerminalBusy || pill.dataset.paperTerminalFeedback !== feedback) return;
        delete pill.dataset.paperTerminalFeedback;
        pill.textContent = quickConfig.label;
        pill.style.borderColor = "rgba(143,119,255,.55)";
        pill.style.color = "#b9aaff";
        scheduleReposition();
      }, result.ok ? 1400 : 3200);
    }
  });

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      clearQuickPills();
      resetChartState();
      window.dispatchEvent(new CustomEvent("paper-terminal:route-change"));
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    clearQuickPills();
    resetChartState();
    window.dispatchEvent(new CustomEvent("paper-terminal:route-change"));
  });

  let scanDebounce = 0;
  const scheduleScan = () => {
    clearTimeout(scanDebounce);
    scanDebounce = window.setTimeout(scanRows, 120);
  };
  window.addEventListener("paper-terminal:scan-rows", scheduleScan);
  window.addEventListener("scroll", scheduleReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleReposition, { passive: true });
  window.addEventListener("scroll", () => masterEnabled && document.getElementById(CHART_RAIL_ID) && renderChartRail(), { capture: true, passive: true });
  new MutationObserver((mutations) => {
    if (!masterEnabled) return;
    const own = (node) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return el?.closest?.(`[data-paper-terminal-quick-address],#${QUICK_LAYER_ID},#${BUBBLE_LAYER_ID},#${CHART_RAIL_ID},#paper-terminal-root`);
    };
    if (mutations.every((m) => own(m.target) || [...m.addedNodes, ...m.removedNodes].every(own))) return;
    chartOccludersScannedAt = 0;
    if (quickConfig.enabled) scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.setInterval(scanRows, 1000);
  window.setInterval(pollChartPrice, 400);
  const trackRailClip = () => {
    const rail = document.getElementById(CHART_RAIL_ID);
    const chart = rail && findVisibleChartElement();
    if (rail) {
      const layer = chartLayers.get(CHART_RAIL_ID);
      if (!chart || !chartContextActive() || !layer?.scope.isConnected) clearChartLayer(CHART_RAIL_ID);
      else positionChartLayer(rail, layer.scope, chart.getBoundingClientRect());
    }
    requestAnimationFrame(trackRailClip);
  };
  requestAnimationFrame(trackRailClip);
  window.setInterval(() => {
    if (masterEnabled && chartModel) {
      const liveChart = findChartApis()[0];
      const nativeUnverifiable = !bubbleChart && drawnObjects.length && drawnObjects.some(object=>!object.verifiable) && drawnObjects.some(object=>Date.now()-object.createdAt>6000);
      if (nativeUnverifiable) nativeDrawKey='';
      if (liveChart && (activeChart !== liveChart || !bubbleChart || nativeUnverifiable)) drawChartModel();
      else if (bubbleChart) { if(layoutChartBubbles(bubbleChart))scheduleBubbleLayout();else drawChartModel(); }
      if (document.getElementById(CHART_RAIL_ID)) renderChartRail();
    }
  }, 3000);

  scheduleScan();
})();
