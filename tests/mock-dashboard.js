// Synthetic portfolio only; never loaded by the extension's actual dashboard.
(() => {
const state={balanceUsd:10000,positions:{},fills:[],settings:{enabled:true,solPrice:100,startingBalance:10000}};
const symbols=['FABLE','ORBIT','MOSS','SHIFT','WAVE','GHOST','LUMA','NOVA','DUSK','ECHO','VELO','ASTRA'];
for(let i=0;i<18;i++){
 const date=new Date();date.setDate(date.getDate()-i*2);date.setHours(12,15,0,0);
 const address='DemoToken'+i,roundId='demo-round-'+i,token={address,symbol:symbols[i%symbols.length],name:'Demo '+symbols[i%symbols.length],chain:'solana',terminal:'axiom',price:.006};
 const cost=40+i*4,qty=cost/.005,buy={id:'buy-'+i,roundId,token,side:'buy',quantity:qty,price:.005,grossUsd:cost,feeUsd:.7,gasFeeUsd:.3,realizedPnl:0,timestamp:date.getTime()};state.fills.push(buy);state.balanceUsd-=cost+.3;
 const open=i<3,returnRate=i%4===0?-.45:.12+(i%5)*.18,sold=open?cost*.3:cost*(1+returnRate),soldQty=open?qty*.25:qty,basis=(cost+.3)*(soldQty/qty),realizedPnl=sold-.9-basis;
 const sell={id:'sell-'+i,roundId,token,side:'sell',quantity:soldQty,price:sold/soldQty,grossUsd:sold,feeUsd:.9,gasFeeUsd:.8,realizedPnl,timestamp:date.getTime()+3600000};state.fills.push(sell);state.balanceUsd+=sold-.9;
 state.positions['solana:'+address]={token,roundId,quantity:open?qty-soldQty:0,costBasis:open?cost+.3-basis:0,investedUsd:cost+.3,soldUsd:sold,realizedPnl,openedAt:date.getTime(),updatedAt:sell.timestamp};
}
state.fills.sort((a,b)=>b.timestamp-a.timestamp);
let stored=JSON.parse(localStorage.getItem('portfolio-fixture')||'null')||{paperTerminalState:state};const listeners=[];
window.chrome={storage:{local:{async get(keys){const requested=typeof keys==='string'?[keys]:keys;return Object.fromEntries(requested.map(k=>[k,structuredClone(stored[k])]))},async set(values){const changes={};for(const [k,v]of Object.entries(values)){changes[k]={oldValue:stored[k],newValue:v};stored[k]=structuredClone(v);}localStorage.setItem('portfolio-fixture',JSON.stringify(stored));listeners.forEach(fn=>fn(changes,'local'));}},onChanged:{addListener:fn=>listeners.push(fn)}},runtime:{onMessage:{addListener(){}},getURL:path=>'/'+path,async sendMessage(){return{}}}};
})();
