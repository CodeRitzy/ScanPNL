import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const dir=new URL('../paper-terminal-extension/',import.meta.url),read=n=>fs.readFileSync(new URL(n,dir),'utf8');
const mint='So11111111111111111111111111111111111111112';
let stored,releaseSupply,releaseMarket,mode='market',rowPrice=0,onDelay=()=>{};
const events=new EventTarget(),timers=[];events.setTimeout=setTimeout;
events.addEventListener('paper-terminal:quote-request',event=>{const req=JSON.parse(event.detail);events.dispatchEvent(new CustomEvent('paper-terminal:row-quote',{detail:JSON.stringify({requestId:req.requestId,quote:{address:mint,mint,marketCap:1000,price:rowPrice,observedAt:Date.now()}})}));});
const chrome={storage:{local:{async get(){return {paperTerminalState:structuredClone(stored)};}}},runtime:{async sendMessage(msg){
  if(msg.type==='FETCH_TOKEN_SUPPLY')return mode==='market'?new Promise(r=>{releaseSupply=r;}):{ok:true,mint,supply:1000,observedAt:Date.now()};
  if(msg.type==='FETCH_TRADE_QUOTE')return mode==='supply'?new Promise(r=>{releaseMarket=r;}):{ok:true,address:mint,observedAt:Date.now(),pair:{chainId:'solana',baseToken:{address:mint},priceUsd:'1',supply:1000,marketCap:1000}};
  if(msg.type==='COMMIT_TRADE'){stored={...stored,balanceUsd:msg.balanceUsd,positions:msg.positions,fills:msg.fills};return {ok:true,state:structuredClone(stored)};}
  return {ok:true};
}}};
const c={structuredClone,crypto:webcrypto,Intl,console,CustomEvent,clearTimeout,chrome,window:events,
  setTimeout:(fn,ms)=>{timers.push(ms);if(ms>100)onDelay();return setTimeout(fn,Math.min(ms,1));},
  location:{hostname:'axiom.trade',pathname:'/pulse',href:'https://axiom.trade/pulse'},document:{getElementById:()=>null},requestAnimationFrame:()=>0,cancelAnimationFrame(){}};
vm.createContext(c);vm.runInContext(read('trade-settings.js'),c);vm.runInContext(read('content.js').replace('  init();',`globalThis.api={DEFAULT_STATE,submitTrade};`),c);
const reset=()=>{stored=structuredClone(c.api.DEFAULT_STATE);stored.balanceUsd=10000;timers.length=0;rowPrice=0;onDelay=()=>{};};
const order=()=>c.api.submitTrade('buy',{address:mint,rowAddress:mint,chain:'solana',quickBuy:true},10);
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fast quote waited for slow source')),500);})]);}finally{clearTimeout(timer);}};
let count=0;const test=async(name,run)=>{reset();await run();count++;console.log('PASS '+name);};
await test('usable market quote commits before an unresolved supply lookup',async()=>{mode='market';const result=await bounded(order());assert.ok(result.ok,result.message);assert.equal(stored.fills.length,1);releaseSupply({ok:false});});
await test('verified supply plus cap commits before an unresolved market lookup',async()=>{mode='supply';const result=await bounded(order());assert.ok(result.ok,result.message);assert.equal(stored.fills[0].price,1);releaseMarket({ok:false});});
await test('Quick Buy bypasses custom delay unless explicitly enabled for quick orders',async()=>{rowPrice=1;stored.settings.customDelayEnabled=true;stored.settings.customDelayMs=450;const result=await order();assert.ok(result.ok);assert.ok(!timers.includes(450));});
await test('configured delay re-reads price and rejects adverse movement before commit',async()=>{rowPrice=1;stored.settings.customDelayEnabled=true;stored.settings.customDelayMs=450;stored.settings.quickBuyDelay=true;onDelay=()=>{rowPrice=2;};const result=await order();assert.equal(result.ok,false);assert.match(result.message,/slippage/i);assert.equal(stored.fills.length,0);assert.ok(timers.includes(450));});
await test('configured delay accepts a favorable fresh fill at its observed price',async()=>{rowPrice=1;stored.settings.customDelayEnabled=true;stored.settings.customDelayMs=450;stored.settings.quickBuyDelay=true;onDelay=()=>{rowPrice=.9;};const result=await order();assert.ok(result.ok,result.message);assert.equal(stored.fills[0].price,.9);});
console.log(`${count} quote race tests passed`);
