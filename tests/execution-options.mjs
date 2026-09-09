import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {loadWorker} from './load-worker.mjs';

const dir = new URL('../paper-terminal-extension/',import.meta.url);
const read = name => fs.readFileSync(new URL(name,dir),'utf8');
const events = new EventTarget();
const c = {structuredClone,crypto:webcrypto,console,Intl,CustomEvent,setTimeout,clearTimeout,
  location:{hostname:'axiom.trade',pathname:'/meme/mint',href:'https://axiom.trade/meme/mint'},window:events,document:{}};
vm.createContext(c);
vm.runInContext(read('trade-settings.js'),c);
vm.runInContext(read('content.js').replace('  init();',`globalThis.api={DEFAULT_STATE,normalizeState,executeBuy,executeSell,executionDelayMs};`),c);
const a=c.api,S=c.TradeTerminalSettings;
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
let count=0;
const test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
const token={address:'mint',chain:'solana',terminal:'dexscreener',price:1,supply:1000,marketCap:1000};
const clean=()=>{const s=a.normalizeState(null);s.balanceUsd=10000;s.settings.solPrice=100;for(const p of s.settings.executionPresets)for(const side of ['buy','sell'])Object.assign(p[side],{networkFeeSol:0,priorityFeeSol:0,mevBribeSol:0});return s;};
const buy=(s,amount,price=1)=>{const r=a.executeBuy(s,{...token,price,marketCap:price*1000},amount);assert.ok(r.ok,r.message);return a.normalizeState(r.state);};
const sell=(s,percent,price=1)=>{const r=a.executeSell(s,{...token,price,marketCap:price*1000},percent);assert.ok(r.ok,r.message);return a.normalizeState(r.state);};
const pos=s=>s.positions['solana:mint'];

await test('observed price is not marked up using market cap or slippage',()=>{
  const s=clean();s.settings.executionPresets[0].buy.slippageBps=9000;
  const r=a.executeBuy(s,{...token,marketCap:5},100);
  assert.ok(r.ok);close(r.fill.price,1);close(r.fill.quantity,100);close(r.fill.slippageUsd,0);
});
await test('default flat buy and sell costs are charged exactly once',()=>{
  const s=a.normalizeState(null);s.settings.solPrice=100;
  const b=a.executeBuy(s,token,10);assert.ok(b.ok);close(b.fill.gasFeeUsd,.3);close(b.fill.platformFeeUsd,0);close(b.fill.quantity,10);
  const r=a.executeSell(b.state,token,100);assert.ok(r.ok);close(r.fill.gasFeeUsd,1);close(r.state.balanceUsd,s.balanceUsd-1.3);close(pos(r.state).realizedPnl,-1.3);
});
await test('terminal fees are always charged even when an obsolete flag is false',()=>{
  const s=clean();s.settings.includePlatformFees=false;const r=a.executeBuy(s,{...token,terminal:'axiom'},100);
  close(r.fill.platformFeeUsd,1);close(r.fill.quantity,99);close(r.fill.price,1);
});
await test('buy rejects adverse price beyond tolerance but accepts favorable movement',()=>{
  const s=clean();s.settings.executionPresets[0].buy.slippageBps=1000;
  assert.equal(a.executeBuy(s,{...token,price:1.2,requestedPrice:1},10).ok,false);
  assert.equal(a.executeBuy(s,{...token,price:.5,requestedPrice:1},10).ok,true);
});
await test('sell checks price movement separately from fees',()=>{
  const s=buy(clean(),100);s.settings.executionPresets[0].sell.slippageBps=1000;
  assert.equal(a.executeSell(s,{...token,price:.8,requestedPrice:1},100).ok,false);
  assert.equal(a.executeSell(s,{...token,price:2,requestedPrice:1},100).ok,true);
});
await test('sell cannot produce a negative cash balance through flat fees',()=>{
  const s=buy(clean(),1);s.balanceUsd=0;s.settings.executionPresets[0].sell.mevBribeSol=1;
  const before=JSON.stringify(s);assert.equal(a.executeSell(s,token,100).ok,false);assert.equal(JSON.stringify(s),before);
});
await test('migration removes market-cap impact without rewriting historical money or personal presets',()=>{
  const s=buy(clean(),100);delete s.settings.executionModelVersion;s.settings.priceImpactBps=20;
  s.settings.executionPresets[0].sell.mevBribeSol=.012;
  const old=JSON.stringify([s.fills,s.positions,s.balanceUsd]);const migrated=a.normalizeState(s);
  assert.equal(migrated.settings.priceImpactBps,0);close(migrated.settings.executionPresets[0].sell.mevBribeSol,.012);
  assert.equal(JSON.stringify([migrated.fills,migrated.positions,migrated.balanceUsd]),old);
});
await test('re-entry keeps lifetime PNL or resets the display without changing the ledger',()=>{
  const s=buy(sell(buy(clean(),100),100,2),150,3);
  close(S.pnlMetrics(pos(s),3,'cumulative').totalPnl,100);
  close(S.pnlMetrics(pos(s),3,'reset').totalPnl,0);
  close(S.pnlMetrics(pos(s),2,'cumulative').totalPnl,50);
  close(S.pnlMetrics(pos(s),2,'reset').totalPnl,-50);
  close(S.pnlMetrics(pos(s),2,'reset').pnlPercent,-100/3);
  assert.equal(S.tradeCycles(s.fills).length,2);close(pos(s).realizedPnl,100);
});
await test('reset on each buy includes existing holdings and subsequent partial sales',()=>{
  let s=buy(buy(clean(),100),100,2);
  close(S.pnlMetrics(pos(s),2,'reset').totalPnl,0);
  close(S.pnlMetrics(pos(s),3,'reset').totalPnl,150);
  close(S.pnlMetrics(pos(s),3,'reset').pnlPercent,50);
  s=sell(s,50,3);close(S.pnlMetrics(pos(s),3,'reset').totalPnl,150);
  s=sell(s,100,4);close(S.pnlMetrics(pos(s),4,'reset').totalPnl,225);
  close(S.pnlMetrics(pos(s),4,'cumulative').totalPnl,325);
});
await test('reset retains the new buy fee as a loss instead of hiding its cost',()=>{
  const s=buy(clean(),100);s.settings.executionPresets[0].buy.mevBribeSol=.01;
  const next=buy(s,100,2);close(S.pnlMetrics(pos(next),2,'reset').totalPnl,-1);
});
await test('legacy holdings without a reset baseline preserve their original PNL',()=>{
  const p={quantity:10,costBasis:10,realizedPnl:20,investedUsd:40};close(S.pnlMetrics(p,2,'reset').totalPnl,30);
});
await test('delay is explicit, bounded, deterministic and zero by default',()=>{
  assert.equal(a.executionDelayMs({priorityFeeSol:1}),0);
  assert.equal(a.executionDelayMs({customDelayEnabled:true,customDelayMs:750}),750);
  assert.equal(a.executionDelayMs({customDelayEnabled:true,customDelayMs:-20}),0);
  assert.equal(a.executionDelayMs({customDelayEnabled:true,customDelayMs:99999}),10000);
});

let handler,stored=clean();
const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(fn){handler=fn}}},alarms:{onAlarm:{addListener(){}}},storage:{local:{async get(){return {paperTerminalState:structuredClone(stored)};},async set(v){stored=structuredClone(v.paperTerminalState);}}}};
loadWorker({chrome,console,Map,Date,AbortSignal,fetch:async()=>{throw new Error('Network is not part of this test');}});
const message=msg=>new Promise(resolve=>handler(msg,{},resolve));
await test('settings queued next to a trade cannot erase its fill or restore old cash',async()=>{
  const base=structuredClone(stored),traded=buy(base,100);
  const commit=message({type:'COMMIT_TRADE',terminal:'axiom',baseFillId:null,baseFillCount:0,baseBalance:base.balanceUsd,balanceUsd:traded.balanceUsd,positions:traded.positions,fills:traded.fills});
  const save=message({type:'SAVE_SETTINGS',settings:{...base.settings,pnlMode:'reset'},initialState:base});
  assert.equal((await commit).ok,true);assert.equal((await save).ok,true);
  assert.equal(stored.fills.length,1);close(stored.balanceUsd,traded.balanceUsd);assert.equal(stored.settings.pnlMode,'reset');
});
console.log(`${count} execution option tests passed`);
