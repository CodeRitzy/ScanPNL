import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../paper-terminal-extension/page-bridge.js',import.meta.url),'utf8');
const fn=name=>{const start=source.indexOf(`  function ${name}(`);assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);};
const asyncFn=name=>{const start=source.indexOf(`  async function ${name}(`);assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);};
const c={console,Number,Math,Date,Map,WeakMap};vm.createContext(c);
vm.runInContext(`const fillAnchors=new Map();let chartModel={address:'mint',currentPrice:1,supply:1000,solPrice:100};let activeChart={};const chartUnits=new WeakMap();let lastTickPrice=1000,chartDrawGeneration=1,drawnObjects=[],active=true;let candleCache={};const chartContextActive=()=>active;
${['candleAtOrBefore','fillCandleAnchor','fillMarkerAnchor','chartAxis'].map(fn).join('\n')}
${asyncFn('drawNativeChartModel')}
globalThis.api={fillMarkerAnchor,chartAxis,drawNativeChartModel,objects:()=>drawnObjects,setTick(n){lastTickPrice=n;},setBars(chart,bars){candleCache={chart,bars,mode:'mcap',resolution:'1S'};},leave(){active=false;chartDrawGeneration++;}};`,c);
const a=c.api;let count=0;const test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
const fill={id:'one',timestamp:1001500,price:1,levels:{mcap:1000},side:'buy'};
await test('missing candle fallback uses the fill level and its own time bucket',()=>{const p=a.fillMarkerAnchor(fill,'1S',[],'mcap',1000);assert.equal(p.time,1001);assert.equal(p.high,1000);});
await test('loaded candle replaces the fallback with its actual wick',()=>{const p=a.fillMarkerAnchor(fill,'1S',[{time:1001,high:1030}],'mcap',1000);assert.equal(p.high,1030);});
await test('zooming out recomputes the correct interval without borrowing a prior bar',()=>{const p=a.fillMarkerAnchor({...fill,id:'zoom'},'5',[{time:300,high:9999}],'mcap',1000);assert.equal(p.time,900);assert.equal(p.high,1000);});
await test('unknown units are rejected rather than choosing the least-wrong scale',()=>{a.setTick(1000);assert.equal(a.chartAxis().mode,'mcap');a.setTick(250);assert.equal(a.chartAxis(),null);});
await test('native chart API draws averages and exact fill levels without private scales',async()=>{
  const draws=[];const chart={resolution:()=> '1S',createShape:async(point,options)=>{draws.push({point,options});return draws.length;},removeEntity(){}};
  a.setBars(chart,[{time:1001,high:1030}]);
  const ok=await a.drawNativeChartModel(chart,{mode:'mcap',factor:1000},{avgBuy:1,avgSell:0,averageLevels:{buy:{mcap:1000}},fills:[fill]},1);
  assert.equal(ok,true);assert.equal(draws.length,2);assert.equal(draws[0].options.shape,'horizontal_line');assert.equal(draws[1].point.time,1001);assert.equal(draws[1].point.price,1000);assert.equal(draws[1].options.disableSave,true);
});
await test('late native drawing completion is removed after navigation',async()=>{
  let finish,removed=[];const chart={resolution:()=> '1S',createShape:()=>new Promise(r=>{finish=r;}),removeEntity:id=>removed.push(id)};
  const pending=a.drawNativeChartModel(chart,{mode:'mcap',factor:1000},{avgBuy:1,avgSell:0,fills:[]},1);
  a.leave();finish('late');await pending;assert.deepEqual(removed,['late']);
});
console.log(`${count} chart fallback tests passed`);
