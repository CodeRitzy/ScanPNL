importScripts("solana-accounts.js","solana-quotes.js","trade-settings.js");
// Trade Terminal — background service worker
//
// Responsibilities:
//   1. Badge / install bookkeeping.
//   2. Proxy price lookups to Dexscreener (content scripts can't hit
//      arbitrary hosts, so this keeps the CSP + host_permissions surface
//      small and centralized).
//   3. Keep `settings.solPrice` fresh via a periodic alarm, so SOL-denominated
//      buy presets, gas, and priority-fee estimates aren't priced off a
//      value that was hardcoded at install time.
//   4. Open the dashboard tab on request.

const STORAGE_KEY = "paperTerminalState";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_PRICE_ALARM = "paper-terminal-sol-price";
const SOL_PRICE_REFRESH_MINUTES = 5;
const quoteCache = new Map();
const QUOTE_CACHE_MS = 750;
let commitQueue = Promise.resolve();
const liveQuotes = new Map();
const supplyCache = new Map();
const supplyRequests = new Map();
const quickOrders = new Map();

async function acquireQuickQuote(token, snapshot, solPrice) {
  const direct = TradeTerminalSettings.normalizeQuote(token,snapshot,solPrice,Date.now(),3000);
  if (direct) return direct;
  const mint=snapshot.mint || token.mint;
  const valid = promise => promise.then(value=>{if(!value)throw new Error('Quote unavailable');return value;});
  const reads = [];
  if(mint)reads.push(valid(fetchTokenSupply(mint).then(supply=>TradeTerminalSettings.normalizeQuote({...token,supply:supply.supply},snapshot,solPrice,Date.now(),3000))));
  const convert = pair => {
    if(!pair || pair.chainId!==token.chain || !TradeTerminalSettings.sameToken({...token,mint},{address:pair.baseToken?.address,altAddress:pair.pairAddress,chain:pair.chainId}))return null;
    const price=Number(pair.priceUsd),at=Number(pair.observedAt) || Date.now();
    if(!(price>0) || !Number.isFinite(price) || Date.now()-at>3000)return null;
    const supply=Number(pair.supply) || Number(pair.fdv || pair.marketCap)/price;
    const rowQuote=TradeTerminalSettings.normalizeQuote({...token,supply}, {...snapshot,mint:pair.baseToken.address},solPrice,Date.now(),3000);
    if(rowQuote)return rowQuote;
    return TradeTerminalSettings.mergeToken(token,{address:pair.baseToken.address,altAddress:token.address,mint:pair.baseToken.address,price,priceUpdatedAt:at,supply,marketCap:supply*price,name:pair.baseToken.name,symbol:pair.baseToken.symbol,source:pair.source || 'dexscreener'});
  };
  reads.push(valid(SolanaQuotes.quote(token.rowAddress || token.address,mint,solPrice).then(convert)));
  reads.push(valid(fetchDexscreenerPair(token.rowAddress || token.address,{fresh:true,chain:token.chain}).then(convert)));
  return Promise.any(reads).catch(()=>{throw new Error('No current token quote. No fill.');});
}

async function quickChartAction(message, sender, fill) {
  if (!['new-tab','chart'].includes(message.action) || !sender.tab?.id || !message.chartUrl) return;
  let target,origin;
  try { target=new URL(message.chartUrl);origin=new URL(message.route); } catch { return; }
  if(target.protocol!=='https:' || target.origin!==origin.origin || !/(axiom\.trade|gmgn\.ai|padre\.gg|terminal\.trade|tinyastro\.io|bullx\.io)$/.test(target.hostname))return;
  if(!TradeTerminalSettings.tokenIds(fill.token).some(id=>target.pathname.split('/').includes(id) || [...target.searchParams.values()].includes(id)))return;
  // Do not yank a tab back after the user has manually navigated elsewhere.
  const tab=await chrome.tabs.get(sender.tab.id).catch(()=>null);
  if(!tab || tab.url!==message.route)return;
  if(message.action==='new-tab')await chrome.tabs.create({url:target.href,active:true});
  else await chrome.tabs.update(sender.tab.id,{url:target.href});
}

async function executeQuickOrder(message,sender) {
  const route=new URL(message.route);
  const path=route.pathname.toLowerCase();
  if(!/^\/(?:en\/)?(?:pulse|trenches|new-pairs|new_pairs)(?:\/|$)/.test(path) && !(path==='/' && /(gmgn\.ai|padre\.gg|terminal\.trade)$/.test(route.hostname)))throw new Error('Quick Buy is only available on trenches.');
  const before=(await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const terminal=message.token?.terminal;
  if(!before?.settings?.enabled || !before.settings.trenchesQuickBuy || before.settings.enabledTerminals?.[terminal]===false)throw new Error('Quick Buy is off.');
  if(!message.requestId || message.token?.chain!=='solana' || message.snapshot?.address!==(message.token.rowAddress || message.token.address))throw new Error('Invalid Quick Buy.');
  const requested=await acquireQuickQuote(message.token,message.snapshot,before.settings.solPrice);
  const terms=TradeTerminalSettings.execution(before.settings,'buy',terminal);
  const delay=terms.customDelayEnabled && terms.quickBuyDelay ? Math.min(10000,Math.max(0,Number(terms.customDelayMs)||0)) : 0;
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  const quote=delay ? await acquireQuickQuote({...requested,price:0}, {...message.snapshot,price:0,priceNative:0,observedAt:0},before.settings.solPrice) : requested;
  const commit=async()=>{
    let current=(await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if(!current?.settings?.enabled || !current.settings.trenchesQuickBuy || current.settings.enabledTerminals?.[terminal]===false)throw new Error('Quick Buy is off.');
    const prior=current.fills.find(fill=>fill.orderId===message.requestId);
    if(prior)return {ok:true,state:current,fill:prior};
    if(Date.now()-quote.priceUpdatedAt>3000)throw new Error('Quote expired before execution. No fill.');
    current=TradeTerminalSettings.reconcilePositions(current,quote);
    const result=TradeTerminalSettings.executeBuy({...current,settings:{...current.settings,...terms,executionPresets:[]}}, {...quote,requestedPrice:requested.price},message.spendUsd);
    if(!result.ok)return result;
    result.fill.orderId=message.requestId;
    result.state.settings=current.settings;
    await chrome.storage.local.set({[STORAGE_KEY]:result.state});
    return result;
  };
  const pending=commitQueue.then(commit,commit);commitQueue=pending.catch(()=>{});
  const result=await pending;
  if(result.ok)await quickChartAction(message,sender,result.fill).catch(()=>{});
  return result;
}

async function fetchTokenSupply(mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || "")) throw new Error("Invalid token mint.");
  const cached = supplyCache.get(mint);
  if (cached && Date.now() - cached.observedAt < 10000) return cached;
  if (supplyRequests.has(mint)) return supplyRequests.get(mint);
  const request = (async () => {
    const result = await SolanaQuotes.supply(mint);
    supplyCache.set(mint,result);
    if (supplyCache.size > 200) supplyCache.delete(supplyCache.keys().next().value);
    return result;
  })();
  supplyRequests.set(mint,request);
  try { return await request; } finally { supplyRequests.delete(mint); }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "T" });
  chrome.action.setBadgeBackgroundColor({ color: "#7c5cff" });
  chrome.alarms.create(SOL_PRICE_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: SOL_PRICE_REFRESH_MINUTES,
  });
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(SOL_PRICE_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: SOL_PRICE_REFRESH_MINUTES,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SOL_PRICE_ALARM) refreshSolPrice();
});

async function fetchDexscreenerPair(address, options = {}) {
  const live = liveQuotes.get(address);
  if (!options.fresh && live && Date.now() - live.priceUpdatedAt < 3500) return {
    baseToken: { address: live.address, name: live.name, symbol: live.symbol },
    priceUsd: String(live.price), marketCap: live.marketCap,
    pairAddress: live.quoteAddress || live.altAddress,
  };
  const cached = quoteCache.get(address);
  if (!options.fresh && cached && Date.now() - cached.at < QUOTE_CACHE_MS) return cached.pair;
  const request = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(3500), ...(options.fresh ? {cache:"no-store"} : {}) });
    if (!res.ok) return null;
    return res.json();
  };
  let json = await request(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
  const matching = pair => pair && (!options.chain || pair.chainId === options.chain) && (pair.baseToken?.address === address || pair.pairAddress === address);
  let pairs = (Array.isArray(json?.pairs) ? json.pairs : []).filter(matching);

  // Trench/detail routes frequently carry a pool/pair id rather than the
  // base-token mint. Resolve those directly, then content.js canonicalizes
  // the position to `baseToken.address` so the list and chart agree.
  if (!pairs.length) {
    for (const chain of options.chain ? [options.chain] : ["solana", "base", "bsc", "ethereum"]) {
      json = await request(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${encodeURIComponent(address)}`);
      pairs = (Array.isArray(json?.pairs) ? json.pairs : json?.pair ? [json.pair] : []).filter(matching);
      if (pairs.length) break;
    }
  }
  if (!json) throw new Error("Price request failed");
  // Dexscreener can return several pools for one mint (different DEXes /
  // quote assets). Prefer the pool with the deepest liquidity so quick-buys
  // on illiquid rows don't anchor off a stale/thin pair.
  if (!pairs.length) return null;
  const pair = pairs.reduce((best, p) => {
    const liq = Number(p?.liquidity?.usd) || 0;
    const bestLiq = Number(best?.liquidity?.usd) || 0;
    return liq > bestLiq ? p : best;
  }, pairs[0]);
  quoteCache.set(address, { pair, at: Date.now() });
  return pair;
}

async function refreshSolPrice() {
  try {
    const before = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (!before?.settings?.enabled) return;
    const pair = await fetchDexscreenerPair(SOL_MINT);
    const price = Number(pair?.priceUsd);
    if (!(price > 0)) return;

    // Serialize account funding with fills, so a quote refresh cannot restore
    // an older balance over a trade committed while the request was in flight.
    const update = async () => {
      const state = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (!state?.settings) return;
      if (state.initialFundingPending === true) {
        if (!state.fills?.length && !Object.values(state.positions || {}).some(p=>Number(p.quantity)>0 || Number(p.investedUsd)>0)) {
          state.balanceUsd = price;
          state.settings.startingBalance = price;
        }
        state.initialFundingPending = false;
      }
      state.settings.solPrice = price;
      state.settings.solPriceUpdatedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    };
    const pending = commitQueue.then(update, update);
    commitQueue = pending.catch(() => {});
    await pending;
  } catch {
    // Offline / rate-limited — keep the last known SOL price rather than
    // clobbering it with something wrong.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if(message?.type==='EXECUTE_QUICK_BUY') {
    let pending=quickOrders.get(message.requestId);
    if(!pending) {
      pending=executeQuickOrder(message,_sender).catch(error=>({ok:false,message:error.message}));
      quickOrders.set(message.requestId,pending);
      pending.finally(()=>{if(quickOrders.size>200)quickOrders.delete(quickOrders.keys().next().value);});
    }
    pending.then(sendResponse);
    return true;
  }
  if (message?.type === 'SAVE_SETTINGS' && message.settings && typeof message.settings==='object') {
    const save = async () => {
      const current = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      const initial = message.initialState;
      if (!current && (!initial || initial.fills?.length || Object.keys(initial.positions || {}).length || !Number.isFinite(initial.balanceUsd))) return {ok:false,message:'Account unavailable.'};
      // Settings updates never write back the caller's cached monetary state.
      const next = {...(current || initial),settings:{...current?.settings,...message.settings}};
      await chrome.storage.local.set({[STORAGE_KEY]:next});
      return {ok:true,state:next};
    };
    const pending = commitQueue.then(save,save);
    commitQueue = pending.catch(()=>{});
    pending.then(sendResponse,error=>sendResponse({ok:false,message:String(error)}));
    return true;
  }
  if (message?.type === "FETCH_TOKEN_SUPPLY") {
    fetchTokenSupply(message.mint).then(sendResponse).catch(error=>sendResponse({ok:false,mint:message.mint,error:String(error)}));
    return true;
  }
  if (message?.type === "PUBLISH_PRICE") {
    const token = message.token;
    if (token && Number.isFinite(token.price) && token.price > 0) {
      for (const id of [token.address, token.altAddress, token.quoteAddress].filter(Boolean)) liveQuotes.set(id, token);
      if (liveQuotes.size > 100) for (const [id, quote] of liveQuotes) if (Date.now() - quote.priceUpdatedAt > 3500) liveQuotes.delete(id);
      chrome.runtime.sendMessage({ type: "LIVE_PRICE", token }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "COMMIT_TRADE") {
    const commit = async () => {
      const current = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (!current?.settings?.enabled || current.settings.enabledTerminals?.[message.terminal] === false) {
        return { ok: false, message: "Trading is off. Order cancelled." };
      }
      if ((current.fills[0]?.id || null) !== message.baseFillId || current.fills.length !== message.baseFillCount || current.balanceUsd !== message.baseBalance) {
        return { ok: false, message: "Account changed in another tab. Please retry." };
      }
      if (!Number.isFinite(message.balanceUsd) || message.balanceUsd < 0 || !Array.isArray(message.fills) || message.fills.length !== current.fills.length + 1) {
        return { ok: false, message: "Invalid fill. No account changes saved." };
      }
      const next = { ...current, initialFundingPending:false, balanceUsd: message.balanceUsd, positions: message.positions, fills: message.fills };
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return { ok: true, state: next };
    };
    const pending = commitQueue.then(commit, commit);
    commitQueue = pending.catch(() => {});
    pending.then(sendResponse, (error) => sendResponse({ ok: false, message: String(error) }));
    return true;
  }
  if (message?.type === "OPEN_PNL_CARD" && typeof message.fillId==='string') {
    chrome.tabs.create({url:chrome.runtime.getURL("dashboard.html")+'#pnl='+encodeURIComponent(message.fillId)});
    sendResponse({ok:true});return;
  }
  if (message?.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
    return;
  }

  if (["FETCH_TRADE_QUOTE","FETCH_PRICE"].includes(message?.type) && typeof message.address === "string") {
    const chain=["solana","base","bsc","ethereum"].includes(message.chain)?message.chain:"solana";
    const fresh=message.type==="FETCH_TRADE_QUOTE" || message.fresh===true;
    const read=async()=>{
      // Start both reads together: a new launch must not wait for an indexer
      // that has never heard of it. Prefer the current processed curve quote.
      const solPrice=Number(message.solPrice);
      const chainRead=chain==="solana" && fresh && solPrice>0 ? SolanaQuotes.quote(message.address,message.mint,solPrice).catch(()=>null) : Promise.resolve(null);
      const marketRead=fetchDexscreenerPair(message.address,{fresh,chain}).catch(()=>null);
      const valid=promise=>promise.then(pair=>{if(!pair)throw new Error("No quote");return pair;});
      const pair=await Promise.any([valid(chainRead),valid(marketRead)]).catch(()=>null);
      return {ok:!!pair,pair:pair || null,observedAt:pair?.observedAt || Date.now(),address:message.address};
    };
    read().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error)}));
    return true;
  }

  if (message?.type === "REFRESH_SOL_PRICE") {
    refreshSolPrice()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
