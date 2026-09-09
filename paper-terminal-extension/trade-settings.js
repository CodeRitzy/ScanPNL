// Shared execution defaults and terminal fees. Keep dashboard and overlay aligned.
// Fee source notes and verification limits are in PLATFORM-FEES.md.
(function (root) {
  'use strict';
  const makeId = () => crypto.randomUUID();
  const positionKey = token => `${token.chain}:${token.address}`;
  const tradeFailure = (state,message) => ({ok:false,state,message});
  const ADDRESS_RE = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  function executeBuy(state, token, spendUsd) {
    if (!token.address || !Number.isFinite(token.price) || token.price <= 0) {
      return tradeFailure(state, "A valid token and current price are required.");
    }
    if (!Number.isFinite(spendUsd) || spendUsd <= 0) {
      return tradeFailure(state, "Enter a valid buy amount.");
    }

    const settings = execution(state.settings, "buy", token.terminal || 'unknown');
    // Flat execution costs are paid on top of the order and buy no tokens.
    // Optional terminal fees reduce the swap amount, not the observed price.
    const platformFeeUsd = (spendUsd * settings.feeBps) / 1e4;
    const netSwapUsd = spendUsd - platformFeeUsd;
    const gasFeeUsd =
      (settings.networkFeeSol + settings.priorityFeeSol + settings.mevBribeSol) *
      settings.solPrice;
    const totalFeeUsd = platformFeeUsd + gasFeeUsd;
    const totalCostUsd = spendUsd + gasFeeUsd;

    if (totalCostUsd > state.balanceUsd) {
      return tradeFailure(state, "Insufficient balance.");
    }

    const impactBps = 0;
    const executionBps = Math.min(9999, Math.max(0, impactBps));
    const fillPrice = token.price * (1 + executionBps / 1e4);
    if (fillPrice > (token.requestedPrice || token.price) * (1 + settings.slippageBps / 1e4) * (1 + 1e-12)) {
      return tradeFailure(state, "Price moved beyond your buy slippage tolerance. No fill.");
    }
    const quantity = netSwapUsd / fillPrice;
    const slippageUsd = netSwapUsd - quantity * token.price;

    const key = positionKey(token);
    const existingEntry = Object.entries(state.positions).find(
      ([candidateKey, candidate]) => candidateKey === key || sameToken(candidate.token, token)
    );
    const existing = existingEntry?.[1];
    const continuingRound = existing && existing.quantity > 1e-12;
    const roundId = continuingRound ? existing.roundId || makeId() : makeId();
    const newQuantity = (continuingRound ? existing.quantity : 0) + quantity;
    const roundCostBasis = (continuingRound ? existing.costBasis : 0) + totalCostUsd;

    const position = {
      key,
      roundId,
      token: mergeToken(existing?.token, token, {price:fillPrice}),
      quantity: newQuantity,
      costBasis: roundCostBasis,
      investedUsd: (existing?.investedUsd || existing?.costBasis || 0) + totalCostUsd,
      averageEntry: roundCostBasis / newQuantity,
      soldUsd: existing?.soldUsd ?? 0,
      realizedPnl: existing?.realizedPnl ?? 0,
      // Snapshot a display baseline only. Cash, cost basis and history remain intact.
      pnlBaselineUsd: (Number(existing?.realizedPnl) || 0) + (continuingRound ? existing.quantity * fillPrice - existing.costBasis : 0),
      pnlBasisUsd: (continuingRound ? existing.quantity * fillPrice : 0) + totalCostUsd,
      openedAt: existing?.openedAt || Date.now(),
      updatedAt: Date.now(),
    };

    const fill = {
      id: makeId(),
      roundId,
      token: mergeToken(position.token, token),
      side: "buy",
      quantity,
      price: fillPrice,
      ...fillSnapshot(token, fillPrice, settings.solPrice),
      grossUsd: spendUsd,
      netSwapUsd,
      feeUsd: totalFeeUsd,
      platformFeeUsd,
      gasFeeUsd,
      slippageUsd,
      realizedPnl: 0,
      timestamp: Date.now(),
    };

    const positions = { ...state.positions };
    if (existingEntry && existingEntry[0] !== key) delete positions[existingEntry[0]];
    positions[key] = position;

    return {
      ok: true,
      message: `Bought ${quantity.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })} ${token.symbol}`,
      fill,
      state: {
        ...state,
        initialFundingPending: false,
        balanceUsd: state.balanceUsd - totalCostUsd,
        fills: [fill, ...state.fills],
        positions,
      },
    };
  }
  function normalizeQuote(token, row, solPrice, now = Date.now(), maxAgeMs = 600) {
    if (!row || row.address !== (token.rowAddress || token.address) || !(Number(row.observedAt) > 0) || now - Number(row.observedAt) > Math.min(3000,maxAgeMs) || Number(row.observedAt) > now + 100) return null;
    if (row.priceObservedAt != null && (!Number.isFinite(Number(row.priceObservedAt)) || now - Number(row.priceObservedAt) > 3000 || Number(row.priceObservedAt) > now + 100)) return null;
    const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    // A displayed cap is not a token price. Convert only with a known supply,
    // never by dividing today's cap by yesterday's token price.
    const supply = positive(row.supply) || positive(token.supply);
    const cap = positive(row.marketCap) || positive(row.marketCapNative) * positive(solPrice) || positive(row.displayedMarketCap);
    // Missing supply must not veto a freshly read, explicitly denominated price.
    const directPrice = positive(row.price) || positive(row.priceNative) * positive(solPrice);
    if(row.quoteSource==='detail-cap' && !(supply>0))return null;
    const displayedCap=positive(row.displayedMarketCap);
    // A committed row can still carry an older typed-price snapshot. The
    // visible cap catches material disagreement; tolerate normal rounding.
    // A genuinely fresh feed tick outranks a visually frozen row instead.
    const inconsistentRow=row.quoteSource!=='row-feed' && supply>0 && displayedCap>0 && directPrice>0 && Math.abs(directPrice*supply/displayedCap-1)>.05;
    const price = (row.quoteSource==='detail-cap' || inconsistentRow) && supply>0 && displayedCap>0 ? displayedCap/supply : directPrice || (cap && supply ? cap / supply : 0);
    if (!(price > 0) || !Number.isFinite(price)) return null;
    return { ...token, ...row, address: ADDRESS_RE.test(row.mint || "") ? row.mint : token.address, altAddress: token.altAddress || (row.mint && row.mint !== token.address ? token.address : undefined), rowAddress: token.rowAddress || row.address,
      supply, price, marketCap: supply ? supply * price : cap,
      source: row.quoteSource === "row-feed" ? "row-feed" : row.quoteSource==='detail-cap' ? 'detail-cap' : "row-props", priceUpdatedAt: Number(row.priceObservedAt || row.observedAt), quickBuy: true };
  }
  const PLATFORM_FEES_BPS = Object.freeze({axiom:100, gmgn:100, terminal:100, photon:100, bullx:100, dexscreener:0, unknown:0});
  const sideDefaults = (side) => ({slippageBps:3000, networkFeeSol:0.000005, priorityFeeSol:0.001995, mevBribeSol:side === 'sell' ? 0.008 : 0.001});
  const profiles = () => ['p1','p2','p3'].map((id,i)=>({id,label:`P${i+1}`,...sideDefaults('buy'),buy:sideDefaults('buy'),sell:sideDefaults('sell')}));
  const DEFAULT_SOL_PRICE = 148.32;
  // Only newly created accounts carry this flag. Existing cash is never reset.
  const initialAccount = () => ({balanceUsd:DEFAULT_SOL_PRICE, initialFundingPending:true, fills:[], positions:{}});
  function fillLevels(fill, fallback = {}) {
    const positive = value => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : 0;
    const price = positive(fill.price), token = fill.token || {};
    const supply = positive(fill.supply) || positive(token.supply) ||
      (positive(token.marketCap) && positive(token.price) ? Number(token.marketCap)/Number(token.price) : 0) || positive(fallback.supply);
    const sol = positive(fill.solPrice) || positive(fallback.solPrice);
    return {usd:price, mcap:positive(fill.marketCap) || price*supply,
      native:positive(fill.priceNative) || (sol ? price/sol : 0),
      'native-mcap':positive(fill.marketCapNative) || (sol ? (positive(fill.marketCap) || price*supply)/sol : 0)};
  }
  function fillSnapshot(token, price, solPrice) {
    const levels = fillLevels({token,price,solPrice});
    return {solPrice, supply:levels.mcap>0 ? levels.mcap/price : undefined,
      marketCap:levels.mcap || undefined, priceNative:levels.native || undefined,
      marketCapNative:levels['native-mcap'] || undefined};
  }
  function averageFillLevels(fills, side, fallback) {
    const values={}, quantities={};
    for(const fill of fills) {
      const quantity=Number(fill.quantity);
      if(fill.side!==side || !Number.isFinite(quantity) || quantity<=0)continue;
      for(const [unit,price] of Object.entries(fillLevels(fill,fallback))) {
        if(!(price>0))continue;
        quantities[unit]=(quantities[unit]||0)+quantity;
        values[unit]=(values[unit]||0)+quantity*price;
      }
    }
    return Object.fromEntries(['usd','mcap','native','native-mcap'].map(unit=>[unit,quantities[unit]>0?values[unit]/quantities[unit]:0]));
  }
  function normalizeDefaults(settings, stored = {}) {
    delete settings.includePlatformFees;
    delete settings.showTradeBubbles;
    delete settings.showAverageLines;
    settings.quickBuyAction = ['new-tab','chart','none'].includes(stored.quickBuyAction) ? stored.quickBuyAction : 'none';
    const savedQuickAmount=Number(stored.quickBuyAmountSol);
    const legacyQuickPreset=(stored.buyPresets || settings.buyPresets || []).find(p=>p.primary) || (stored.buyPresets || settings.buyPresets || [])[0];
    const legacyQuickAmount=legacyQuickPreset?.unit==='USD' ? Number(legacyQuickPreset.value)/(Number(settings.solPrice)||DEFAULT_SOL_PRICE) : Number(legacyQuickPreset?.value);
    settings.quickBuyAmountSol=savedQuickAmount>0 ? savedQuickAmount : legacyQuickAmount>0 ? legacyQuickAmount : 0.5;
    if (stored.executionModelVersion !== 1) {
      settings.executionModelVersion = 1;
      settings.priceImpactBps = 0;
    }
    settings.pnlMode = stored.pnlMode === 'reset' ? 'reset' : 'cumulative';
    if (stored.activePresetDefaultVersion !== 1) {
      settings.activeExecutionPreset = settings.executionPresets.some(profile => profile.id === 'p1') ? 'p1' : settings.executionPresets[0]?.id;
      settings.activePresetDefaultVersion = 1;
    }
    if (stored.executionDefaultsVersion === 3) return settings;
    const old = {p1:{networkFeeSol:0.000005,priorityFeeSol:0.001,mevBribeSol:0.001},p2:{networkFeeSol:0.000005,priorityFeeSol:0.003,mevBribeSol:0.005},p3:{networkFeeSol:0,priorityFeeSol:0,mevBribeSol:0}};
    settings.executionPresets = settings.executionPresets.map(profile=>{
      const next={...profile};delete next.feeBps;
      for(const side of ['buy','sell']) {
        const prior={...profile,...profile[side]}, defaults=sideDefaults(side), oldDefaults=old[profile.id];
        const terms={...prior};
        // Only migrate absent/untouched defaults. Explicit custom side settings survive.
        for(const key of ['networkFeeSol','priorityFeeSol','mevBribeSol']) {
          if(prior[key] == null || (oldDefaults && prior[key] === oldDefaults[key])) terms[key]=defaults[key];
        }
        terms.slippageBps=Math.round(Math.min(100,Math.max(0,Number(prior.slippageBps ?? 3000)/100)))*100;
        next[side]={slippageBps:terms.slippageBps,networkFeeSol:terms.networkFeeSol,priorityFeeSol:terms.priorityFeeSol,mevBribeSol:terms.mevBribeSol};
      }
      return next;
    });
    Object.assign(settings, sideDefaults('buy'), {executionDefaultsVersion:3});
    delete settings.feeBps;
    return settings;
  }
  function execution(settings, side='buy', terminal='unknown') {
    const profile=settings.executionPresets?.find(item=>item.id===settings.activeExecutionPreset);
    return {...sideDefaults(side),...settings,...profile,...profile?.[side],feeBps:PLATFORM_FEES_BPS[terminal] ?? 0};
  }
  function pnlMetrics(position, mark, mode = 'cumulative') {
    const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    if (!position) return {unrealized:0,totalPnl:0,pnlPercent:0};
    const unrealized = n(position.quantity) * n(mark) - n(position.costBasis);
    const reset = mode === 'reset' && Number.isFinite(Number(position.pnlBaselineUsd));
    const totalPnl = n(position.realizedPnl) + unrealized - (reset ? n(position.pnlBaselineUsd) : 0);
    const invested = reset ? n(position.pnlBasisUsd) : n(position.investedUsd) || n(position.costBasis);
    return {unrealized,totalPnl,pnlPercent:invested > 0 ? totalPnl / invested * 100 : 0};
  }
  function editedAmounts(settings, draft) {
    const buys=draft.buys.map(item=>({...item,amount:String(item.amount).trim()}));
    const sells=draft.sells.map(value=>String(value).trim());
    if(buys.some(item=>!item.amount || !Number.isFinite(Number(item.amount)) || Number(item.amount)<=0)) throw new Error('Buy amounts must be greater than 0 SOL.');
    if(sells.some(value=>!value || !Number.isFinite(Number(value)) || Number(value)<=0 || Number(value)>100)) throw new Error('Sell percentages must be greater than 0 and at most 100.');
    return {...settings,amountLayoutVersion:1,
      buyPresets:buys.map(({amount,...original})=>{
        // Preserve a USD preset's unit/value when its displayed SOL value was not edited.
        const saved=settings.buyPresets.find(p=>p.id===original.id);
        if(saved && Number(amount)===Number(original.initialAmount)) return {...saved};
        const {initialAmount,...preset}=original;
        return {...preset,value:Number(amount),unit:'SOL',label:amount};
      }),
      sellPresets:sells.map(Number)};
  }
  // A route can name a pool, a curve or a mint. Keep every verified alias;
  // never join tokens by their ticker, and never join different chains.
  const tokenIds=t=>[...new Set([t?.address,t?.mint,t?.altAddress,t?.quoteAddress,t?.rowAddress,...(t?.aliases||[])].filter(id=>typeof id==='string'&&id))];
  const sameToken=(a,b)=>!!a&&!!b&&(a.chain||'solana')===(b.chain||'solana')&&tokenIds(a).some(id=>tokenIds(b).includes(id));
  function mergeToken(...tokens){const valid=tokens.filter(Boolean),merged=Object.assign({},...valid);merged.aliases=[...new Set(valid.flatMap(tokenIds))];for(const key of ['name','symbol']){const named=[...valid].reverse().find(t=>typeof t[key]==='string'&&t[key].trim()&&!/^(TOKEN|unknown)$/i.test(t[key].trim()));if(named)merged[key]=named[key];}return merged;}
  function tokenGroups(state){
    const groups=[];
    const add=(token,item,kind)=>{
      if(!token?.address)return;
      const matches=groups.filter(g=>sameToken(g.token,token));
      let group=matches.shift();
      if(!group){group={token,positions:[],fills:[]};groups.push(group);}
      for(const other of matches){group.token=mergeToken(group.token,other.token);group.positions.push(...other.positions);group.fills.push(...other.fills);groups.splice(groups.indexOf(other),1);}
      group.token=mergeToken(group.token,token);group[kind].push(item);
    };
    for(const f of [...(state.fills||[])].sort((a,b)=>a.timestamp-b.timestamp))add(f.token,f,'fills');
    for(const position of Object.values(state.positions||{}))add(position.token,position,'positions');
    return groups;
  }
  function reconcilePositions(state,knownToken){
    // An observed alias can connect older pool-keyed fills with a mint-keyed
    // position. No trade amounts, timestamps, or cash balances are rewritten.
    const input=knownToken?{...state,positions:Object.fromEntries(Object.entries(state.positions||{}).map(([key,p])=>[key,sameToken(p.token,knownToken)?{...p,token:mergeToken(p.token,knownToken)}:p]))}:state;
    const positions={};
    for(const group of tokenGroups(input)){
      if(!group.positions.length)continue;
      const ps=group.positions,latest=ps.reduce((a,b)=>(b.updatedAt||0)>(a.updatedAt||0)?b:a),sum=(items,fn)=>items.reduce((total,item)=>total+(Number(fn(item))||0),0);
      const buys=group.fills.filter(f=>f.side==='buy'),sells=group.fills.filter(f=>f.side==='sell');
      const token=mergeToken(group.token,latest.token),quantity=sum(ps,p=>p.quantity),costBasis=sum(ps,p=>p.costBasis);
      const key=`${token.chain||'solana'}:${token.address}`;
      positions[key]={...latest,key,token,quantity,costBasis,averageEntry:quantity>0?costBasis/quantity:0,
        investedUsd:buys.length?sum(buys,f=>(Number(f.grossUsd)||0)+(Number(f.gasFeeUsd)||0)):sum(ps,p=>p.investedUsd||p.costBasis),
        soldUsd:sells.length?sum(sells,f=>f.grossUsd):sum(ps,p=>p.soldUsd),
        realizedPnl:sells.length?sum(sells,f=>f.realizedPnl):sum(ps,p=>p.realizedPnl),
        openedAt:Math.min(...ps.map(p=>p.openedAt||Date.now()),...group.fills.map(f=>f.timestamp))};
    }
    return {...state,positions};
  }
  function tradeCycles(fills) {
    const cycles=[];let quantity=0,cycle=null,bought=0;
    // Stored fills are newest first; reverse before the stable timestamp sort
    // so fills sharing a millisecond retain their execution order.
    for(const fill of [...fills].reverse().sort((a,b)=>Number(a.timestamp)-Number(b.timestamp))) {
      const q=Number(fill.quantity);
      if(!Number.isFinite(q)||q<=0||!['buy','sell'].includes(fill.side))continue;
      if(!cycle || (fill.side==='buy' && quantity<=Math.max(1e-12,bought*1e-12))) {
        cycle={id:fill.id,roundId:fill.roundId,fills:[]};cycles.push(cycle);quantity=0;bought=0;
      }
      cycle.fills.push(fill);
      if(fill.side==='buy'){quantity+=q;bought+=q;}else quantity=Math.max(0,quantity-q);
    }
    return cycles;
  }
  root.TradeTerminalSettings={executeBuy,normalizeQuote,pnlMetrics,tradeCycles,DEFAULT_SOL_PRICE,initialAccount,fillLevels,fillSnapshot,averageFillLevels,PLATFORM_FEES_BPS,sideDefaults,profiles,normalizeDefaults,execution,editedAmounts,tokenIds,sameToken,mergeToken,tokenGroups,reconcilePositions};
})(typeof globalThis !== 'undefined' ? globalThis : this);
