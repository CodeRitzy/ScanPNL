import fs from 'node:fs';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
const dir=new URL('../paper-terminal-extension/',import.meta.url),read=n=>fs.readFileSync(new URL(n,dir),'utf8');
const mint='So11111111111111111111111111111111111111112';
const alternate='To11111111111111111111111111111111111111112';
const dom=new JSDOM('<main><div data-testid="chart"></div></main>',{url:`https://axiom.trade/meme/${mint}`,runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
w.structuredClone=structuredClone;w.matchMedia=()=>({matches:false});let stored;
w.chrome={storage:{onChanged:{addListener(){}},local:{async get(){return {paperTerminalState:structuredClone(stored)};},async set(v){stored=structuredClone(v.paperTerminalState);}}},runtime:{onMessage:{addListener(){}},async sendMessage(m){if(m.type==='COMMIT_TRADE'){stored={...stored,balanceUsd:m.balanceUsd,positions:m.positions,fills:m.fills};return {ok:true,state:structuredClone(stored)};}return {ok:false};}}};
const props={tokenAddress:mint,name:'VerifiedCoin',symbol:'VER',priceUsd:1,supply:1000};w.document.querySelector('main').__reactFiber$test={memoizedProps:props};
w.eval(read('page-bridge.js').replace(/\}\)\(\);\s*$/,'window.bridgeApi={extractLatestPrice,detailDisplayedCap,inspectLivePayload,bubbleInternals,quoteFromReactFiber};})();'));
w.eval(read('trade-settings.js'));
w.eval(read('content.js').replace('  init();',`fitPanelSize=()=>({width:340,height:450});reclampPanel=()=>{};globalThis.api={DEFAULT_STATE,init,pollDetailQuote,metrics:positionMetrics,current:()=>currentToken,buy:()=>submitTrade('buy',{...currentToken,quickBuy:false},100)};`));
stored=structuredClone(w.api.DEFAULT_STATE);stored.balanceUsd=1000;stored.settings.solPrice=100;for(const p of stored.settings.executionPresets)for(const side of ['buy','sell'])Object.assign(p[side],{networkFeeSol:0,priorityFeeSol:0,mevBribeSol:0});
let count=0;const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`),test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
try{
await w.api.init();assert.ok((await w.api.buy()).ok);
await test('chart data without a labeled close never interprets volume as price',()=>{assert.equal(w.bridgeApi.extractLatestPrice({schema:['time','open','high','low','volume'],data:[[1,1,1.2,.9,6]]}),0);assert.equal(w.bridgeApi.extractLatestPrice({value:6,time:1}),0);});
await test('descending chart rows select the newest close rather than oldest last row',()=>{assert.equal(w.bridgeApi.extractLatestPrice({schema:['time','open','high','low','close'],data:[[20,1,1.2,.9,1.2],[10,1,6,.9,6]]}),1.2);});
await test('typed live price outranks inconsistent cap without inflating a 20 percent move',()=>{w.dispatchEvent(new w.CustomEvent('paper-terminal:feed-price',{detail:JSON.stringify({address:mint,priceUsd:1.2,marketCap:6000})}));close(w.api.current().price,1.2);close(w.api.current().marketCap,1200);close(w.api.metrics().pnlPercent,18.8);});
await test('token-checked live title cap updates PNL even when React price is unchanged',async()=>{w.document.title='VER $1.3K | Axiom';await w.api.pollDetailQuote();close(w.api.current().price,1.3);close(w.api.metrics().pnlPercent,28.7);});
await test('a different token title cannot price the active token',()=>{w.document.title='OTHER $6K | Axiom';assert.equal(w.bridgeApi.detailDisplayedCap(props),0);});
await test('a feed object may match the active pair even when its mint alias is new',()=>{w.bridgeApi.inspectLivePayload({mint:alternate,pairAddress:mint,priceUsd:1.4});close(w.api.current().price,1.4);});
await test('nested quote-asset prices cannot contaminate token quotes',()=>{const root=w.document.querySelector('main');root.__reactFiber$test.memoizedProps={...props,quoteToken:{priceUsd:6},stats:{priceUsd:7}};const quote=w.bridgeApi.quoteFromReactFiber(root,mint);assert.equal(quote.price,1);});
await test('private scale receives a numeric value from object-form firstValue',()=>{const pane=w.document.querySelector('[data-testid="chart"]');const result=w.bridgeApi.bubbleInternals({_chartWidget:{paneWidgets:()=>[{_div:pane}],model:()=>({mainSeries:()=>({firstValue:()=>({value:1,timePoint:1}),priceScale:()=>({priceToCoordinate(){}})}),timeScale:()=>({timeToCoordinate(){}})})}});assert.equal(result.firstValue,1);});
await test('old visibility and fee flags are removed during settings migration',()=>{const settings=structuredClone(stored.settings);Object.assign(settings,{includePlatformFees:false,showTradeBubbles:false,showAverageLines:false});w.TradeTerminalSettings.normalizeDefaults(settings,settings);assert.equal('includePlatformFees' in settings,false);assert.equal('showTradeBubbles' in settings,false);assert.equal('showAverageLines' in settings,false);});
}finally{w.close();}
console.log(`${count} price integrity tests passed`);
