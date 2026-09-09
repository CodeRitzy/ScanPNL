// Full bridge click -> content order -> worker commit with a live DOM model.
// Geometry and public RPC/market responses are controlled, not a live-site test.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {loadWorker} from './load-worker.mjs';
const dir=new URL('../paper-terminal-extension/',import.meta.url),source=name=>fs.readFileSync(new URL(name,dir),'utf8');
const A='So11111111111111111111111111111111111111112',B='To11111111111111111111111111111111111111112';
async function fixture(mode='ok'){
 const dom=new JSDOM('<main><section id="feed"><h2>New Pairs</h2><div id="row" class="group">NEW MC $25K</div></section></main>',{url:'https://axiom.trade/pulse',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,row=w.document.getElementById('row');
 w.structuredClone=structuredClone;w.matchMedia=()=>({matches:false});
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 for(const [el,width,height,top]of [[row,400,90,120],[row.parentElement,400,900,80]]){el.getBoundingClientRect=()=>({left:100,top,right:100+width,bottom:top+height,width,height});Object.defineProperties(el,{offsetWidth:{get:()=>width},offsetHeight:{get:()=>height}});}
 row.__reactFiber$test={memoizedProps:{tokenAddress:A,marketCapInUsd:25000}};
 const messages=[],requests=[],outcomes=[];let stored,handler;
 const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){messages.push(msg);if(['REFRESH_SOL_PRICE','LIVE_PRICE'].includes(msg.type))return {ok:true};return new Promise(resolve=>handler(msg,{},resolve));}},storage:{onChanged:{addListener(){}},local:{async get(){return {paperTerminalState:structuredClone(stored)};},async set(obj){stored=structuredClone(obj.paperTerminalState);}}},alarms:{onAlarm:{addListener(){}}}};
 const worker={chrome,AbortSignal,console,fetch:async(url,opts)=>{requests.push({url,opts});if(mode==='navigate' && w.location.pathname==='/pulse'){w.history.pushState({},'',`/meme/${A}`);}if(opts?.method==='POST'){if(mode==='recycle'){row.__reactFiber$test.memoizedProps={tokenAddress:B,marketCapInUsd:25000};}return {ok:true,json:async()=>mode==='missing'?{error:{message:'mint not found'}}:{result:{value:{amount:'1000000000000000',decimals:6}}}};}return {ok:true,json:async()=>({pairs:[]})};}};
 loadWorker(worker);w.chrome=chrome;
 w.eval(source('page-bridge.js'));w.eval(source('trade-settings.js'));w.eval(source('content.js').replace('  init();','  globalThis.testContent={DEFAULT_STATE,init};'));
 stored=structuredClone(w.testContent.DEFAULT_STATE);stored.settings.solPrice=100;
 w.addEventListener('paper-terminal:quick-buy-done',e=>outcomes.push(JSON.parse(e.detail)));
 await w.testContent.init();
 async function until(predicate){const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Timed out waiting for '+mode);await new Promise(r=>setTimeout(r,10));}}
 await until(()=>row.querySelector('[data-paper-terminal-quick-address]'));
 return {dom,w,row,messages,requests,outcomes,state:()=>stored,until,async buy(){const pill=row.querySelector('[data-paper-terminal-quick-address]');assert.ok(pill);const n=outcomes.length;pill.dispatchEvent(new w.MouseEvent('pointerdown',{button:0,bubbles:true,cancelable:true}));if(mode==='immediate')w.history.pushState({},'',`/meme/${A}`);await until(()=>outcomes.length>n);return outcomes.at(-1);}};
}
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name);}
await test('unindexed new pair quick button uses verified supply and commits one fill',async()=>{const f=await fixture();try{const result=await f.buy();assert.ok(result.ok,result.message);assert.equal(f.state().fills.length,1);assert.equal(f.state().fills[0].token.price,.000025);assert.equal(f.messages.filter(m=>m.type==='EXECUTE_QUICK_BUY').length,1);assert.ok(f.requests.some(r=>r.url.includes('dexscreener')));const req=JSON.parse(f.requests[0].opts.body);assert.equal(req.method,'getTokenSupply');assert.equal(req.params[0],A);assert.ok(f.row.contains(f.row.querySelector('button')));}finally{f.dom.window.close();}});
await test('worker preserves the token clicked before a row is recycled',async()=>{const f=await fixture('recycle');try{const result=await f.buy();assert.equal(result.ok,true,result.message);assert.equal(f.state().fills.length,1);assert.equal(f.state().fills[0].token.address,A);}finally{f.dom.window.close();}});
await test('missing verified supply cannot create an invented new-pair fill',async()=>{const f=await fixture('missing');try{const result=await f.buy();assert.equal(result.ok,false);assert.equal(f.state().fills.length,0);assert.ok(f.requests.some(r=>r.url.includes('dexscreener')));}finally{f.dom.window.close();}});
await test('opening the chart during a validated Quick Buy keeps its pinned order',async()=>{const f=await fixture('navigate');try{const result=await f.buy();assert.ok(result.ok,result.message);assert.equal(f.w.location.pathname,`/meme/${A}`);assert.equal(f.state().fills.length,1);assert.equal(f.state().fills[0].token.address,A);assert.equal(f.messages.filter(m=>m.type==='EXECUTE_QUICK_BUY').length,1);}finally{f.dom.window.close();}});
await test('immediate chart navigation retains the verified pointer-down token',async()=>{const f=await fixture('immediate');try{const result=await f.buy();assert.ok(result.ok,result.message);assert.equal(f.state().fills.length,1);assert.equal(f.state().fills[0].token.address,A);}finally{f.dom.window.close();}});
console.log(`${count} new-pair integration tests passed`);
