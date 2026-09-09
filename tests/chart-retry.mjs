import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../paper-terminal-extension/page-bridge.js',import.meta.url),'utf8');
const extract=name=>{const start=source.indexOf(`  async function ${name}(`);assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }',start)+4);};
let finish,removed=[],draws=0;
const chart={resolution:()=> '1S',createShape:()=>{draws++;return new Promise(resolve=>{finish=resolve;});},removeEntity:id=>removed.push(id)};
const c={console,Date,JSON,Math,Number,chart,document:{documentElement:{dataset:{}}}};vm.createContext(c);
vm.runInContext(`let chartModel={address:'token',avgBuy:1,avgSell:0,averageLevels:{buy:{usd:1}},fills:[]},chartDrawGeneration=0,activeChart=chart,nativeDrawKey='',nativeDrawPending=null,drawnObjects=[],axisMode='',candleCache={bars:[]},bubbleChart=null;
const chartContextActive=()=>true,findChartApis=()=>[chart],chartAxis=()=>({mode:'usd',factor:1}),bubbleInternals=()=>null,layoutChartBubbles=()=>false;
const hideChartOverlay=()=>{},renderChartRail=()=>{},clearBubbleLayer=()=>{},clearChartLayer=()=>{},scheduleBubbleLayout=()=>{},fillCandleAnchor=()=>null;
const clearDrawnObjects=()=>{nativeDrawKey='';for(const o of drawnObjects)o.remove();drawnObjects=[];};
const CHART_RAIL_ID='rail';
${extract('drawNativeChartModel')}
${extract('drawChartModel')}
globalThis.api={draw:drawChartModel,objects:()=>drawnObjects,change:()=>{chartModel={...chartModel,avgBuy:2,averageLevels:{buy:{usd:2}}};}};`,c);
let count=0;
const pending=c.api.draw();assert.equal(draws,1);await c.api.draw();await c.api.draw();assert.equal(draws,1);finish('average');await pending;assert.equal(c.api.objects().length,1);assert.equal(removed.length,0);count++;
await c.api.draw();assert.equal(draws,1);count++;
c.api.change();const next=c.api.draw();assert.equal(draws,2);assert.deepEqual(removed,['average']);finish('updated');await next;assert.equal(c.api.objects().length,1);count++;
console.log(`${count} asynchronous chart retry tests passed`);
