// Production bridge, event wiring and chart geometry with a controlled DOM.
// Does not claim a browser rendering or live-terminal compatibility pass.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const bridge=fs.readFileSync(new URL('../paper-terminal-extension/page-bridge.js',import.meta.url),'utf8');
class Style {
 constructor(){this.position='';this.isolation='';}
 set cssText(value){this._text=value;for(const item of value.split(';')){const i=item.indexOf(':');if(i>0)this[item.slice(0,i).trim().replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=item.slice(i+1).trim();}}
 get cssText(){return this._text||'';}
}
class Element {
 constructor(tag,rect={left:0,top:0,width:0,height:0}){this.tagName=tag.toUpperCase();this.style=new Style();this.dataset={};this.children=[];this.parentNode=null;this.attributes={};this.textContent='';this.rect=rect;this.offsetWidth=rect.width;this.offsetHeight=rect.height;this.clientLeft=0;this.clientTop=0;this.scrollLeft=0;this.scrollTop=0;this.ownerDocument=doc;}
 get parentElement(){return this.parentNode;}
 get childElementCount(){return this.children.length;}
 get isConnected(){return this===doc.documentElement||!!this.parentNode?.isConnected;}
 append(...nodes){nodes.forEach(n=>this.appendChild(n));}
 appendChild(n){n.remove();this.children.push(n);n.parentNode=this;return n;}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
 setAttribute(k,v){this.attributes[k]=v;}
 getAttribute(k){return this.attributes[k]||null;}
 removeAttribute(k){delete this.attributes[k];if(k==='id')delete this.id;}
 contains(n){return n===this||this.children.some(child=>child.contains(n));}
 matches(selector){return selector.split(',').some(raw=>{let s=raw.trim();if(s==='*')return true;if(s.includes(':not(iframe)')&&this.tagName==='IFRAME')return false;s=s.replace(':not(iframe)','');if(s.startsWith('#'))return this.id===s.slice(1);const tag=s.match(/^[a-z][a-z0-9-]*/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;const attr=s.match(/\[([\w-]+)(\*=|\^=|=)?(?:"([^"]*)")?(?: (i))?\]/);if(!attr)return !!tag;const key=attr[1];let value=key==='id'?this.id:key==='class'?this.className:key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]??this.attributes[key]:this.attributes[key];if(value===undefined)return false;let expect=attr[3];value=String(value);if(attr[4]){value=value.toLowerCase();expect=expect?.toLowerCase();}return !attr[2]|| (attr[2]==='='?value===expect:attr[2]==='*='?value.includes(expect):value.startsWith(expect));});}
 querySelectorAll(s){return this.walk().filter(n=>n.matches(s));}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 closest(s){for(let node=this;node;node=node.parentNode)if(node.matches(s))return node;return null;}
 walk(){return this.children.flatMap(n=>[n,...n.walk()]);}
 getBoundingClientRect(){return {...this.rect,right:this.rect.left+this.rect.width,bottom:this.rect.top+this.rect.height};}
}
const doc={};doc.documentElement=new Element('html');doc.body=doc.documentElement.appendChild(new Element('body'));
Object.assign(doc,{createElement:t=>new Element(t),getElementById(id){return this.documentElement.walk().find(n=>n.id===id)||null;},querySelectorAll(s){return this.documentElement.querySelectorAll(s);},querySelector(s){return this.querySelectorAll(s)[0]||null;},elementsFromPoint:()=>[]});
const location={};const navigate=url=>{const parsed=new URL(url,location.href||'https://axiom.trade');Object.assign(location,{href:parsed.href,pathname:parsed.pathname,hostname:parsed.hostname,hash:parsed.hash});};
const tokenURL='https://axiom.trade/meme/So11111111111111111111111111111111111111112';navigate(tokenURL);
const events=new Map(),frames=[],intervals=new Map();const window={setInterval:(fn,ms)=>{intervals.set(ms,fn);return 1;},setTimeout:()=>1,addEventListener(type,callback){if(!events.has(type))events.set(type,[]);events.get(type).push(callback);},dispatchEvent(event){for(const callback of events.get(event.type)||[])callback(event);}};
const history={pushState(_state,_title,url){if(url)navigate(url);},replaceState(_state,_title,url){if(url)navigate(url);}};
class CustomEvent {constructor(type,options={}){this.type=type;this.detail=options.detail;}}
let mutation;
const computed=el=>({position:el.style.position||'static',visibility:el.style.visibility||'visible',display:el.style.display||'block',opacity:el.style.opacity||'1'});
const c={document:doc,innerWidth:2560,innerHeight:1440,Intl,console,window,history,location,CustomEvent,URL,Date,Map,WeakMap,Set,Blob,ArrayBuffer,Uint8Array,TextDecoder,getComputedStyle:computed,clearTimeout(){},requestAnimationFrame:f=>frames.push(f),MutationObserver:class{constructor(callback){mutation=callback;}observe(){}}};vm.createContext(c);
const hook=`
window.testBridge={
 set(chart,model,bars,tick=1,mode='usd'){chartModel=model;masterEnabled=true;lastTickPrice=tick;candleCache={chart,bars,mode,resolution:'1S'};activeChart=chart;return layoutChartBubbles(chart);},
 clear(){resetChartState();fillAnchors.clear();chartOccludersScannedAt=0;},
 invalidate(){chartOccludersScannedAt=0;},
 nodes(){return [...bubbleNodes.values()];},
 host(){return chartLayers.get(BUBBLE_LAYER_ID)?.host;},
 rail:renderChartRail,draw:drawChartModel,model(){return chartModel;},
 layers(){return chartLayers.size;},
};
`;
vm.runInContext(bridge.slice(0,bridge.lastIndexOf('})();'))+hook+'})();',c);
const api=window.testBridge;
let px=100,py=200;const levels=[];
const pane=doc.body.appendChild(new Element('div',{left:30,top:100,width:1000,height:500}));pane.dataset.chart='';
const chart={createShape(){},resolution:()=> '1S',_chartWidget:{paneWidgets:()=>[{_div:pane}],model:()=>({mainSeries:()=>({priceScale:()=>({priceToCoordinate:p=>{levels.push(p);return py;}}),firstValue:()=>1}),timeScale:()=>({timeToCoordinate:()=>px})})}};
window.tvWidget=chart;
const fills=[{id:'a',side:'buy',timestamp:1000000,price:1}];
const model={address:'So11111111111111111111111111111111111111112',route:tokenURL,currentPrice:1,solPrice:100,fills,avgBuy:1.1,avgSell:0};const bars=[{time:1000,high:2}];
const render=(m=model)=>api.set(chart,m,bars);
const localPos=()=>api.nodes()[0].style.transform.match(/translate3d\(([-\d.]+)px,([-\d.]+)px/).slice(1).map(Number);
// Recover screen positions using the host's actual containing block, borders,
// scroll offsets and inverse scale, so changing to local CSS can't hide drift.
const hostOrigin=()=>{const host=api.host(),scope=host.parentNode,r=scope.getBoundingClientRect();const sx=r.width/scope.offsetWidth,sy=r.height/scope.offsetHeight;return [r.left+(parseFloat(host.style.left)+scope.clientLeft-scope.scrollLeft)*sx,r.top+(parseFloat(host.style.top)+scope.clientTop-scope.scrollTop)*sy];};
const pos=()=>localPos().map((v,i)=>v+hostOrigin()[i]);
const visible=(path,x,y)=>[...path.matchAll(/M ([\d.-]+) ([\d.-]+) H ([\d.-]+) V ([\d.-]+) H [\d.-]+ Z/g)].some(m=>x>=+m[1]&&x<=+m[3]&&y>=+m[2]&&y<=+m[4]);
const emit=(type,detail)=>window.dispatchEvent(new CustomEvent(type,{detail}));
let passes=0;
const test=(name,run)=>{api.clear();frames.length=0;px=100;py=200;navigate(tokenURL);for(const child of [...doc.body.children])child.remove();doc.body.appendChild(pane);pane.rect={left:30,top:100,width:1000,height:500};pane.style=new Style();pane.ownerDocument=doc;pane.clientLeft=pane.clientTop=pane.scrollLeft=pane.scrollTop=0;run();passes++;console.log('PASS '+name);};
test('screen coordinates use actual pane position and four-pixel gap',()=>{assert.ok(render(),doc.documentElement.dataset.paperTerminalChartError);assert.deepEqual(pos(),[120,276]);assert.equal(pos()[1]+20,100+200-4);});
test('drawings belong to an isolated chart scope, never a viewport overlay',()=>{render();assert.equal(api.host().parentNode,pane);assert.equal(pane.style.isolation,'isolate');assert.equal(api.host().style.position,'absolute');assert.equal(api.nodes()[0].style.position,'absolute');assert.equal(api.host().style.zIndex,'2');assert.equal(api.host().style.overflow,'hidden');});
test('scaled pane scales the anchor, not the marker gap',()=>{pane.rect.width=500;pane.rect.height=250;render();assert.deepEqual(pos(),[70,176]);assert.equal(api.host().style.transform,'scale(2,2)');});
test('foreign iframe offset, borders and scaling are applied once',()=>{const scope=doc.body.appendChild(new Element('div',{left:90,top:40,width:2100,height:1100}));scope.offsetWidth=1050;scope.offsetHeight=550;scope.clientLeft=4;scope.clientTop=2;scope.scrollLeft=8;scope.scrollTop=3;const frame=scope.appendChild(new Element('iframe',{left:100,top:50,width:2000,height:1000}));frame.offsetWidth=1000;frame.offsetHeight=500;frame.clientLeft=2;frame.clientTop=3;pane.ownerDocument={defaultView:{frameElement:frame}};render();assert.deepEqual(pos(),[354,632]);assert.equal(api.host().parentNode,scope);});
test('same-document iframe does not get its outer offset added',()=>{doc.defaultView={frameElement:{getBoundingClientRect:()=>({left:800,top:900})}};render();assert.deepEqual(pos(),[120,276]);});
test('null time coordinate removes stale marker',()=>{render();px=null;render();assert.equal(api.nodes().length,0);});
test('null price coordinate hides average and removes marker',()=>{render();py=null;render();assert.equal(api.nodes().length,0);assert.equal(api.host().querySelector('[data-average="buy"]').style.display,'none');});
test('detached chart takes its drawings out of the document immediately',()=>{render();const host=api.host();pane.remove();assert.equal(host.isConnected,false);assert.equal(render(),false);assert.equal(host.style.visibility,'hidden');api.clear();assert.equal(api.layers(),0);assert.equal(pane.style.isolation,'');});
test('hundreds of same-candle fills cannot stack upward',()=>{const many={...model,fills:Array.from({length:250},(_,i)=>({...fills[0],id:`many${i}`,timestamp:1000000+i,side:i%2?'buy':'sell'}))};render(many);assert.equal(api.nodes().length,2);assert.ok(api.nodes().every(n=>n.dataset.fillCount==='125'));assert.ok(api.nodes().every(n=>n.style.transform.endsWith(',176.0px,0)')));const markup=api.nodes().map(n=>n.innerHTML).join('');assert.ok(markup.includes('>B</text>')&&markup.includes('>S</text>'));assert.ok(!markup.includes('B/S'));assert.ok(!markup.includes('7px'));assert.equal(Math.abs(parseFloat(api.nodes()[0].style.transform.slice(12))-parseFloat(api.nodes()[1].style.transform.slice(12))),22);});
test('average levels use historical snapshots in all four chart units',()=>{const averageLevels={buy:{usd:1.1,mcap:1100,native:.012,'native-mcap':12}};for(const [mode,tick,expected] of [['usd',1,1.1],['mcap',1000,1100],['native',.01,.012],['native-mcap',10,12]]){levels.length=0;api.set(chart,{...model,supply:1000,averageLevels},bars,tick,mode);assert.equal(levels[0],expected);}});
test('price pan immediately updates marker and average',()=>{render();py=300;render();assert.equal(pos()[1],376);assert.equal(parseFloat(api.host().querySelector('[data-average="buy"]').style.top)+hostOrigin()[1],400);});
test('offscreen marker is removed instead of attached to chart edge',()=>{render();px=-1;render();assert.equal(api.nodes().length,0);});
test('native profile dialog cuts out drawings and closing restores them',()=>{const profile=doc.body.appendChild(new Element('div',{left:100,top:230,width:320,height:300}));profile.setAttribute('role','dialog');render();assert.equal(visible(api.host().style.clipPath,100,200),false);assert.equal(visible(api.host().style.clipPath,800,200),true);profile.remove();render();assert.equal(visible(api.host().style.clipPath,100,200),true);});
test('unlabeled native Instant Trade is masked and its drag follows each frame',()=>{const panel=doc.body.appendChild(new Element('div',{left:100,top:230,width:310,height:300}));panel.style.position='fixed';const heading=panel.appendChild(new Element('span'));heading.textContent='Instant Trade';render();assert.equal(visible(api.host().style.clipPath,100,200),false);panel.rect.left=700;render();assert.equal(visible(api.host().style.clipPath,100,200),true);assert.equal(visible(api.host().style.clipPath,800,200),false);});
test('overlapping native dialog and own Instant Trade stay masked',()=>{const own=doc.body.appendChild(new Element('div'));own.id='paper-terminal-root';const wrap=new Element('div',{left:100,top:230,width:310,height:300});own.shadowRoot={querySelector:()=>wrap};const profile=doc.body.appendChild(new Element('div',{left:200,top:300,width:400,height:300}));profile.setAttribute('role','dialog');render();assert.equal(visible(api.host().style.clipPath,200,250),false);assert.equal(visible(api.host().style.clipPath,30,30),true);});
test('a newly opened profile invalidates cached occluders immediately',()=>{render();const profile=doc.body.appendChild(new Element('div',{left:100,top:230,width:310,height:300}));profile.setAttribute('role','dialog');mutation([{target:doc.body,addedNodes:[profile],removedNodes:[]}]);render();assert.equal(visible(api.host().style.clipPath,100,200),false);});
test('route mismatch hides existing drawings even before navigation event handling',()=>{render();navigate('/profile/'+model.address);assert.equal(render(),false);assert.equal(api.host().style.visibility,'hidden');});
test('pushState clears bubbles and levels synchronously',()=>{render();api.rail();assert.equal(api.layers(),1);history.pushState({},'','/profile/'+model.address);assert.equal(api.model(),null);assert.equal(api.layers(),0);assert.equal(pane.style.isolation,'');assert.equal(pane.style.position,'');});
test('replaceState and browser Back clear old chart state',()=>{for(const type of ['replace','back']){navigate(tokenURL);render();if(type==='replace')history.replaceState({},'','/profile/'+model.address);else{navigate('/pulse');emit('popstate');}assert.equal(api.layers(),0);assert.equal(api.model(),null);}});
test('late model from previous token URL cannot resurrect an overlay',()=>{render();history.pushState({},'','/profile/'+model.address);emit('paper-terminal:chart-model',JSON.stringify(model));assert.equal(api.layers(),0);assert.equal(api.model(),null);});
test('malformed model removes all previously drawn content',()=>{render();api.rail();emit('paper-terminal:chart-model','not json');assert.equal(api.layers(),0);assert.equal(api.model(),null);});
test('Off removes all drawings and releases chart layout styles',()=>{render();api.rail();emit('paper-terminal:master-toggle','off');assert.equal(api.layers(),0);assert.equal(pane.style.position,'');assert.equal(pane.style.isolation,'');});
test('private-scale fallback never creates a chart corner summary',()=>{render();api.rail();assert.equal(doc.getElementById('trade-terminal-chart-rail'),null);assert.equal(api.layers(),1);});
test('average-only models track the chart without needing any fill bubbles',()=>{assert.ok(render({...model,fills:[]}));assert.equal(api.nodes().length,0);assert.ok(api.host().querySelector('[data-average="buy"]'));});
test('average lines recover when the same widget finishes rebuilding',()=>{const original=chart._chartWidget.model;let ready=false;chart._chartWidget.model=()=>ready?original():{mainSeries:()=>({firstValue:()=>null})};api.set(chart,model,bars);emit('paper-terminal:chart-model',JSON.stringify(model));assert.equal(api.host(),undefined);ready=true;emit('paper-terminal:chart-model',JSON.stringify(model));assert.equal(api.host().querySelector('[data-average="buy"]').style.display,'block');chart._chartWidget.model=original;});
test('periodic recovery retries a temporarily unavailable scale on the same chart',()=>{const original=chart._chartWidget.model;let ready=false;chart._chartWidget.model=()=>ready?original():{mainSeries:()=>({firstValue:()=>null})};api.set(chart,model,bars);api.draw();assert.equal(api.host(),undefined);ready=true;intervals.get(3000)();assert.equal(api.host().querySelector('[data-average="buy"]').style.display,'block');chart._chartWidget.model=original;});
test('one unavailable average coordinate does not hide the other side',()=>{const original=chart._chartWidget.model;chart._chartWidget.model=()=>({mainSeries:()=>({priceScale:()=>({priceToCoordinate:price=>{if(price===1.1)throw Error('scale');return 200;}}),firstValue:()=>1}),timeScale:()=>({timeToCoordinate:()=>100})});assert.ok(render({...model,avgSell:1.2}));assert.equal(api.host().querySelector('[data-average="buy"]').style.display,'none');assert.equal(api.host().querySelector('[data-average="sell"]').style.display,'block');chart._chartWidget.model=original;});
console.log(`${passes} geometry/lifecycle tests passed`);
