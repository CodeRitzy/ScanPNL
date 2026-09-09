// All creation paths start at 1 SOL. Existing cash and concurrent fills survive
// the worker's first SOL price refresh. HTTP and storage are controlled.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';import {loadWorker} from './load-worker.mjs';
const dir=new URL('../paper-terminal-extension/',import.meta.url),read=n=>fs.readFileSync(new URL(n,dir),'utf8');
let stored,handler,price=210,fetchGate=null;
const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(fn){handler=fn}}},storage:{local:{async get(){return {paperTerminalState:structuredClone(stored)}},async set(obj){stored=structuredClone(obj.paperTerminalState)}}},alarms:{onAlarm:{addListener(){}}}};
const base=()=>({chrome,structuredClone,crypto:webcrypto,console,Intl,location:{hostname:'axiom.trade'},window:{},document:{getElementById:()=>null},setTimeout,clearTimeout});
function context(source){const c=base();vm.createContext(c);vm.runInContext(read('trade-settings.js'),c);vm.runInContext(source,c);return c.api;}
const content=context(read('content.js').replace('  init();','  globalThis.api={DEFAULT_STATE,normalizeState};'));
const dashboard=context(read('dashboard.js').split('const D=PortfolioData')[0]+'\nglobalThis.api={DEFAULT_STATE,normalizeState};');
const popup=context(read('popup.js').replace(/render\(\);\s*$/,'globalThis.api={loadState};'));
const worker={chrome,AbortSignal,fetch:async()=>{if(fetchGate)await fetchGate;return {ok:true,json:async()=>({pairs:[{chainId:'solana',baseToken:{address:'So11111111111111111111111111111111111111112'},priceUsd:String(price)}]})}}};
loadWorker(worker,'\nglobalThis.api={refreshSolPrice,quoteCache};');
const refresh=async()=>{worker.api.quoteCache.clear();await worker.api.refreshSolPrice();};
let count=0;const test=async(name,run)=>{await run();count++;console.log('PASS '+name)};
await test('popup, dashboard and content all create an account worth exactly 1 SOL',async()=>{stored=undefined;for(const st of [content.normalizeState(null),dashboard.normalizeState(null),await popup.loadState()]){assert.equal(st.balanceUsd/st.settings.solPrice,1);assert.equal(st.settings.startingBalance,st.balanceUsd);assert.equal(st.initialFundingPending,true);}});
await test('normalizing a legacy account never opts it into new funding',()=>{const old={balanceUsd:427,fills:[],positions:{},settings:{enabled:true,solPrice:88}};for(const api of [content,dashboard]){const st=api.normalizeState(old);assert.equal(st.balanceUsd,427);assert.equal(st.initialFundingPending,false);}});
await test('first fresh SOL quote funds an untouched new account once',async()=>{stored=structuredClone(content.DEFAULT_STATE);await refresh();assert.equal(stored.balanceUsd,210);assert.equal(stored.settings.solPrice,210);assert.equal(stored.settings.startingBalance,210);assert.equal(stored.initialFundingPending,false);price=220;await refresh();assert.equal(stored.balanceUsd,210);assert.equal(stored.settings.solPrice,220);});
await test('legacy balances and fills are unchanged by a quote refresh',async()=>{stored={balanceUsd:4321,fills:[{id:'kept'}],positions:{},settings:{enabled:true,solPrice:100}};await refresh();assert.equal(stored.balanceUsd,4321);assert.deepEqual(stored.fills,[{id:'kept'}]);});
await test('a trade committed while the initial quote is in flight wins over initial funding',async()=>{stored=structuredClone(content.DEFAULT_STATE);let release;fetchGate=new Promise(r=>release=r);const pending=refresh();await Promise.resolve();const baseBalance=stored.balanceUsd;const result=await new Promise(resolve=>handler({type:'COMMIT_TRADE',terminal:'axiom',baseFillId:null,baseFillCount:0,baseBalance,balanceUsd:120,fills:[{id:'first'}],positions:{}},{},resolve));assert.equal(result.ok,true);release();await pending;fetchGate=null;assert.equal(stored.balanceUsd,120);assert.equal(stored.fills[0].id,'first');assert.equal(stored.initialFundingPending,false);});
await test('an old pending marker cannot fund an account that already contains trades',async()=>{stored=structuredClone(content.DEFAULT_STATE);stored.fills=[{id:'existing'}];stored.balanceUsd=72;await refresh();assert.equal(stored.balanceUsd,72);assert.equal(stored.initialFundingPending,false);});
console.log(`${count} initial balance tests passed`);
