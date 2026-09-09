import assert from 'node:assert/strict';import {loadWorker} from './load-worker.mjs';import {fixtureAccounts,MINT,CURVE,PUMP} from './launch-fixture.mjs';
function fixture(mode='ok'){
 let handler,slot=200,accounts=fixtureAccounts(mode==='complete'?{complete:true}:mode==='wrong-owner'?{owner:'11111111111111111111111111111111'}:mode==='quote-extension'?{extension:true}:{});const requests=[];
 const chrome={runtime:{sendMessage:async()=>{},onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(fn){handler=fn}}},alarms:{onAlarm:{addListener(){}}}};
 const w={chrome,AbortSignal,fetch:async(url,options)=>{
  if(!options?.body)return {ok:true,json:async()=>({pairs:[]})};
  const request=JSON.parse(options.body);requests.push({url,...request});if(mode==='failover'&&url.includes('publicnode'))return {ok:false,status:429};
  let result;
  if(request.method==='getAccountInfo')result={context:{slot},value:request.params[0]===MINT?accounts.mint:request.params[0]===CURVE?accounts.curve:null};
  if(request.method==='getMultipleAccounts')result={context:{slot},value:[accounts.mint,accounts.curve]};
  if(request.method==='getTokenAccountsByOwner')result={context:{slot},value:[{account:{data:{parsed:{info:{mint:mode==='wrong-mint'?'So11111111111111111111111111111111111111112':MINT}}}}}]};
  if(request.method==='getTokenSupply')result={context:{slot},value:{amount:'1000000000000000',decimals:6}};
  return {ok:true,json:async()=>({result})};
 }};loadWorker(w);
 return {w,requests,quote:(address=MINT)=>w.SolanaQuotes.quote(address,null,100),setSlot:v=>slot=v,send:msg=>new Promise(resolve=>handler(msg,{},resolve))};
}
let count=0;const test=async(name,run)=>{await run();count++;console.log('PASS '+name)};
await test('unindexed mint quotes virtual reserves with actual decimals and supply',async()=>{const f=fixture(),p=await f.quote();assert.equal(p.baseToken.address,MINT);assert.equal(p.pairAddress,CURVE);assert.ok(Math.abs(Number(p.priceUsd)-.000003)<1e-18);assert.ok(Math.abs(p.marketCap-3000)<1e-9);assert.equal(p.slot,200);assert.ok(f.requests.some(r=>r.method==='getMultipleAccounts'));});
await test('a curve-only row resolves its verified mint without an indexer',async()=>{const f=fixture(),p=await f.quote(CURVE);assert.equal(p.baseToken.address,MINT);assert.ok(f.requests.some(r=>r.method==='getTokenAccountsByOwner'));});
await test('rate limited RPC fails over to the second endpoint',async()=>{const f=fixture('failover');assert.ok(await f.quote());assert.ok(f.requests.some(r=>r.url.includes('mainnet.solana')));});
for(const mode of ['complete','wrong-owner','quote-extension','wrong-mint'])await test(mode+' cannot produce a false launch quote',async()=>{const f=fixture(mode);await assert.rejects(f.quote(mode==='wrong-mint'?CURVE:MINT));});
await test('older RPC slots cannot roll a position price backward',async()=>{const f=fixture();await f.quote();f.setSlot(199);await assert.rejects(f.quote());});
await test('fresh worker price bypasses its own published display cache',async()=>{const f=fixture();await f.send({type:'PUBLISH_PRICE',token:{address:MINT,price:99,priceUpdatedAt:Date.now()}}).catch(()=>{});const p=await f.send({type:'FETCH_PRICE',address:MINT,chain:'solana',fresh:true,solPrice:100});assert.ok(Math.abs(Number(p.pair.priceUsd)-.000003)<1e-18);});
console.log(`${count} on-chain quote tests passed`);
