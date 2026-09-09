// Pure portfolio calculations. USD is the persisted account denomination.
// Realized P&L comes from sell fills; buy fees already enter their cost basis.
(() => {
  const n=value=>Number.isFinite(Number(value))?Number(value):0;
  const key=token=>`${token?.chain||'solana'}:${String(token?.address||'')}`;
  const dateKey=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const buyCost=f=>n(f.grossUsd)+n(f.gasFeeUsd);
  const cashDelta=f=>f.side==='buy'?-buyCost(f):n(f.grossUsd)-n(f.feeUsd);
  const realized=f=>f.side==='sell'?n(f.realizedPnl):0;
  const fillsOf=state=>(state.fills||[]).filter(f=>['buy','sell'].includes(f.side)&&n(f.timestamp)>0).slice().sort((a,b)=>a.timestamp-b.timestamp);
  function periodBounds(range,now=Date.now()) {return {start:range==='max'?0:now-({ '1d':1,'7d':7,'30d':30 }[range]||1)*86400000,end:now+1};}
  function period(state,start=0,end=Date.now()+1) {
    const fills=fillsOf(state).filter(f=>f.timestamp>=start&&f.timestamp<end);
    const buys=fills.filter(f=>f.side==='buy'),sells=fills.filter(f=>f.side==='sell');
    const pnl=sells.reduce((sum,f)=>sum+realized(f),0),basis=sells.reduce((sum,f)=>sum+Math.max(0,n(f.grossUsd)-n(f.feeUsd)-realized(f)),0);
    return {fills,buys:buys.length,sells:sells.length,pnl,basis,percent:basis>0?pnl/basis*100:null,bought:buys.reduce((s,f)=>s+n(f.grossUsd),0),sold:sells.reduce((s,f)=>s+n(f.grossUsd),0),fees:fills.reduce((s,f)=>s+n(f.feeUsd),0)};
  }
  function month(state,year,monthIndex) {
    const start=new Date(year,monthIndex,1).getTime(),end=new Date(year,monthIndex+1,1).getTime();
    const summary=period(state,start,end),days=[];
    const count=new Date(year,monthIndex+1,0).getDate();
    for(let day=1;day<=count;day++) {
      const date=new Date(year,monthIndex,day),next=new Date(year,monthIndex,day+1);
      days.push({day,key:dateKey(date),start:date.getTime(),...period(state,date.getTime(),next.getTime())});
    }
    const all=fillsOf(state),cashAt=time=>n(state.balanceUsd)-all.filter(f=>f.timestamp>=time).reduce((sum,f)=>sum+cashDelta(f),0);
    return {...summary,start,end,days,startCash:cashAt(start),endCash:cashAt(end),positive:days.filter(d=>d.pnl>0).reduce((s,d)=>s+d.pnl,0),negative:days.filter(d=>d.pnl<0).reduce((s,d)=>s+d.pnl,0)};
  }
  function rounds(state,priceFor=token=>n(token.price)) {
    const grouped=TradeTerminalSettings.tokenGroups(state).flatMap(group=>{
      const cycles=TradeTerminalSettings.tradeCycles(group.fills);
      if(!cycles.length)return [group];
      return cycles.map((cycle,index)=>({...group,cycleId:cycle.id,fills:cycle.fills,positions:index===cycles.length-1?group.positions:[]}));
    });
    return grouped.map(group=>{
      const fills=group.fills.sort((a,b)=>a.timestamp-b.timestamp),token=group.token;
      const r={id:`${key(token)}:${group.cycleId || 'legacy'}`,identity:key(token),roundId:fills[0]?.roundId || group.positions[0]?.roundId,token,fills,bought:0,sold:0,invested:0,realized:0,quantity:0,costBasis:0,openedAt:fills[0]?.timestamp || group.positions[0]?.openedAt,updatedAt:fills.at(-1)?.timestamp || group.positions[0]?.updatedAt};
      for(const f of fills){
        if(f.side==='buy'){r.bought+=n(f.grossUsd);r.invested+=buyCost(f);r.quantity+=n(f.quantity);r.costBasis+=buyCost(f);}
        else if(f.side==='sell'){r.sold+=n(f.grossUsd);r.realized+=realized(f);r.quantity=Math.max(0,r.quantity-n(f.quantity));r.costBasis=Math.max(0,r.costBasis-(n(f.grossUsd)-n(f.feeUsd)-realized(f)));}
      }
      // Use existing positions for actual remaining inventory. The complete
      // fill log supplies lifetime totals, including older round IDs.
      if(group.positions.length){r.quantity=group.positions.reduce((s,p)=>s+n(p.quantity),0);r.costBasis=group.positions.reduce((s,p)=>s+n(p.costBasis),0);}
      if(!fills.length)for(const p of group.positions){r.invested+=n(p.investedUsd)||n(p.costBasis);r.bought+=n(p.investedUsd);r.sold+=n(p.soldUsd);r.realized+=n(p.realizedPnl);}
      const holding=r.quantity*priceFor(token),open=r.quantity>1e-12,unrealized=open?holding-r.costBasis:0;
      return {...r,open,holding,unrealized,pnl:r.realized+unrealized,percent:r.invested>0?(r.realized+unrealized)/r.invested*100:null};
    }).sort((a,b)=>b.updatedAt-a.updatedAt);
  }

  function equity(state,priceFor) {const all=rounds(state,priceFor),open=all.filter(r=>r.open),unrealized=open.reduce((s,r)=>s+r.unrealized,0),holding=open.reduce((s,r)=>s+r.holding,0);return {cash:n(state.balanceUsd),holding,total:n(state.balanceUsd)+holding,unrealized,realized:period(state).pnl,openCount:open.length};}
  function curve(state,start,end) {const selected=period(state,start,end).fills;let total=0;const points=[{time:start||selected[0]?.timestamp||end-86400000,value:0}];for(const f of selected){total+=realized(f);points.push({time:f.timestamp,value:total});}points.push({time:end,value:total});return points;}
  function cardForRound(r){return {scope:'trade',title:r.token.symbol||'TOKEN',kind:'',pnl:r.pnl,percent:r.percent,rows:[['Invested',r.invested],['Position',r.sold+r.holding]],timestamp:r.updatedAt};}
  function cardForPeriod(stats,title){return {scope:'period',title,kind:'Realized P&L',pnl:stats.pnl,percent:stats.percent,buys:stats.buys,sells:stats.sells,rows:[['Buy Volume',stats.bought],['Sell Volume',stats.sold]],timestamp:Date.now()};}
  globalThis.PortfolioData={n,key,dateKey,buyCost,cashDelta,realized,fillsOf,periodBounds,period,month,rounds,equity,curve,cardForRound,cardForPeriod};
})();
