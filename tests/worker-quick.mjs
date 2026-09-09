import assert from 'node:assert/strict';
import {loadWorker} from './load-worker.mjs';
const mint='So11111111111111111111111111111111111111112',route='https://axiom.trade/pulse';
let stored,handler,tabUrl=route,actions=[],requests=0;
const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(fn){handler=fn}}},alarms:{onAlarm:{addListener(){}}},storage:{local:{async get(){return {paperTerminalState:structuredClone(stored)};},async set(value){stored=structuredClone(value.paperTerminalState);actions.push('saved');}}},tabs:{async get(){return {id:7,url:tabUrl};},async create(options){actions.push(['new-tab',options.url]);},async update(id,options){actions.push(['chart',options.url]);}}};
const w={chrome,AbortSignal,console,fetch:async()=>{requests++;return {ok:true,json:async()=>({pairs:[]})};}};loadWorker(w);
let count=0;const reset=()=>{stored={balanceUsd:1000,fills:[],positions:{},settings:{enabled:true,trenchesQuickBuy:true,enabledTerminals:{axiom:true},solPrice:100,activeExecutionPreset:'p1',executionPresets:w.TradeTerminalSettings.profiles()}};actions=[];tabUrl=route;requests=0;};
const msg=(id,action='none')=>({type:'EXECUTE_QUICK_BUY',requestId:id,route,chartUrl:`https://axiom.trade/meme/${mint}`,action,spendUsd:100,token:{address:mint,rowAddress:mint,chain:'solana',terminal:'axiom'},snapshot:{address:mint,mint,price:1,supply:1000,marketCap:1000,observedAt:Date.now(),route}});
const send=message=>new Promise(resolve=>handler(message,{tab:{id:7,url:route}},resolve));
const test=async(name,run)=>{reset();await run();count++;console.log('PASS '+name);};
await test('worker commits a typed click quote without network reads',async()=>{const r=await send(msg('direct'));assert.ok(r.ok,r.message);assert.equal(requests,0);assert.equal(stored.fills.length,1);assert.equal(stored.fills[0].price,1);assert.equal(stored.fills[0].marketCap,1000);assert.equal(stored.fills[0].platformFeeUsd,1);});
await test('duplicate click delivery cannot create two fills',async()=>{const a=msg('duplicate');const results=await Promise.all([send(a),send(a)]);assert.ok(results.every(r=>r.ok));assert.equal(stored.fills.length,1);});
await test('simultaneous orders serialize against current cash without retry failures',async()=>{const results=await Promise.all([send(msg('concurrent-a')),send(msg('concurrent-b'))]);assert.ok(results.every(r=>r.ok));assert.equal(stored.fills.length,2);assert.ok(Math.abs(stored.balanceUsd-799.4)<1e-9);});
await test('jump to chart happens only after the trade is persisted',async()=>{assert.ok((await send(msg('jump','chart'))).ok);assert.equal(actions[0],'saved');assert.deepEqual(actions[1],['chart',`https://axiom.trade/meme/${mint}`]);});
await test('new tab happens only after the trade is persisted',async()=>{assert.ok((await send(msg('tab','new-tab'))).ok);assert.equal(actions[0],'saved');assert.equal(actions[1][0],'new-tab');});
await test('do nothing commits without navigation',async()=>{assert.ok((await send(msg('stay'))).ok);assert.deepEqual(actions,['saved']);});
await test('manual navigation cannot cancel a worker-owned fill or yank the page back',async()=>{tabUrl=`https://axiom.trade/meme/${mint}`;assert.ok((await send(msg('manual','chart'))).ok);assert.equal(stored.fills.length,1);assert.deepEqual(actions,['saved']);});
await test('worker rejects requests originating from Discover',async()=>{const request={...msg('discover'),route:'https://axiom.trade/discover'};assert.equal((await send(request)).ok,false);assert.equal(stored.fills.length,0);});
await test('turning trading off prevents a queued fill',async()=>{stored.settings.enabled=false;assert.equal((await send(msg('off'))).ok,false);assert.equal(stored.fills.length,0);});
await test('new pair cap stays usable while verified supply is acquired after 600 ms',async()=>{
  w.SolanaQuotes.supply=async requested=>{assert.equal(requested,mint);return {supply:1000,mint};};w.SolanaQuotes.quote=async()=>{throw Error('Not indexed');};
  const request=msg('supply-late');Object.assign(request.snapshot,{price:0,supply:0,marketCap:1200,observedAt:Date.now()-1200});
  const result=await send(request);assert.ok(result.ok,result.message);assert.equal(stored.fills.length,1);assert.equal(stored.fills[0].price,1.2);assert.equal(stored.fills[0].marketCap,1200);
});
await test('expired launch snapshot is not revived by a supply lookup',async()=>{
  const request=msg('supply-expired');Object.assign(request.snapshot,{price:0,supply:0,marketCap:1200,observedAt:Date.now()-4000});
  assert.equal((await send(request)).ok,false);assert.equal(stored.fills.length,0);
});
console.log(`${count} background quick-buy tests passed`);
