// Executes the real render/event handlers against a small DOM double. This tests
// save behavior and template state; it does not claim browser layout coverage.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const dir=new URL('../paper-terminal-extension/',import.meta.url);
let content=fs.readFileSync(new URL('content.js',dir),'utf8');
for(const name of ['fitPanelSize','updateLiveMetrics','publishChartModel','makeDraggable','makeResizable']) {
 const a=content.indexOf(`  function ${name}(`), b=content.indexOf('\n  }',a)+4;
 content=content.slice(0,a)+`  function ${name}() {}`+content.slice(b);
}
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"');
class Node {
 constructor(tag,attrs=''){this.tagName=tag.toUpperCase();this.dataset={};this.style={};this.listeners={};this.offsetWidth=310;this.offsetHeight=268;this.attrs={};for(const match of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)){this.attrs[match[1]]=decode(match[2]||'');if(match[1].startsWith('data-'))this.dataset[match[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(match[2]||'');}this.id=this.attrs.id;this.value=this.attrs.value||'';this.className=this.attrs.class||'';this.hidden='hidden' in this.attrs;this.disabled='disabled' in this.attrs;this.classList={contains:x=>this.className.split(' ').includes(x)};}
 addEventListener(k,fn){this.listeners[k]=fn}
 focus(){this.focused=true}
 remove(){}
 matches(s){if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));const m=s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return !!m && m[1] in this.attrs && (m[2]===undefined||this.attrs[m[1]]===m[2])}
}
const shadow={nodes:[],get innerHTML(){return this.html},set innerHTML(html){this.html=html;this.nodes=[...html.matchAll(/<(button|input|label|section|div|i)\b([^>]*)>/g)].map(m=>new Node(m[1],m[2]));},querySelector(s){return this.nodes.find(n=>n.matches(s))||null},querySelectorAll(s){return this.nodes.filter(n=>n.matches(s))}};
let stored;
const window={innerWidth:2560,innerHeight:1440,dispatchEvent(){},setTimeout:()=>0};
const c={window,location:{hostname:'axiom.trade',pathname:'/t/So11111111111111111111111111111111111111112',hash:'',href:'https://axiom.trade/t/So11111111111111111111111111111111111111112'},document:{getElementById:id=>id==='paper-terminal-root'?{shadowRoot:shadow}:null},chrome:{storage:{local:{async get(){return {paperTerminalState:structuredClone(stored)}},async set(v){stored=structuredClone(v.paperTerminalState)}}}},structuredClone,crypto:webcrypto,Intl,console,CustomEvent:class {},clearTimeout,setTimeout};vm.createContext(c);
vm.runInContext(fs.readFileSync(new URL('trade-settings.js',dir),'utf8'),c);
vm.runInContext(content.replace('  init();',`  globalThis.api={mount(){state=structuredClone(DEFAULT_STATE);currentToken={address:'So11111111111111111111111111111111111111112',chain:'solana',symbol:'TEST',price:1};renderPanel();return state},refresh(){renderPanel()},state(){return state},draft(){return amountDraft},open(){return executionEditorOpen}};`),c);
stored=structuredClone(c.api.mount());
const $=s=>shadow.querySelector(s);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const key=k=>({key:k,preventDefault(){},stopPropagation(){}});
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name)}
await test('normal panel omits token price, chart status and platform fee field',()=>{assert.equal($('#live-price'),null);assert.equal($('#live-source'),null);assert.equal($('[data-exec-field="feeBps"]'),null);assert.equal($('.exec-editor').hidden,true)});
await test('footer keeps values without visible Bought/Sold/Holding/P&L headings',()=>{const foot=shadow.html.match(/<div class="foot">([\s\S]*?)<\/div>/)[1];assert.ok(!foot.includes('<small>'));assert.ok(foot.includes('id="foot-bought"'));assert.ok(shadow.html.includes('class="pnl-section"'));assert.ok(shadow.html.includes('id="foot-pnl"'));assert.equal(shadow.querySelectorAll('[data-execution-profile]').find(n=>n.classList.contains('active')).dataset.executionProfile,'p1')});
await test('pencil edits the existing amount cells and becomes checkmark',()=>{$('#tune').onclick();assert.ok($('.wrap').className.includes('editing-amounts'));assert.equal($('[data-buy]'),null);assert.ok($('[data-amount-side="buy"]').focused);assert.equal($('#tune').attrs['aria-label'],'Save amounts')});
await test('incoming render leaves typed values and focused input intact',()=>{const input=$('[data-amount-side="buy"]');input.value='.123';input.oninput();c.api.refresh();assert.equal($('[data-amount-side="buy"]'),input);assert.equal(input.value,'.123')});
await test('checkmark saves changed SOL and sell values and exits edit mode',async()=>{const sell=$('[data-amount-side="sell"]');sell.value='37';sell.oninput();await $('#tune').onclick();assert.equal(stored.settings.buyPresets[0].value,.123);assert.equal(stored.settings.sellPresets[0],37);assert.equal(c.api.draft(),null);assert.equal($('[data-amount-side="buy"]'),null);assert.equal($('#tune').attrs['aria-label'],'Edit amounts')});
await test('Enter saves an amount and returns normal buttons',async()=>{$('#tune').onclick();const buy=$('[data-amount-side="buy"]');buy.value='.456';buy.oninput();buy.onkeydown(key('Enter'));await tick();assert.equal(stored.settings.buyPresets[0].value,.456);assert.equal(c.api.draft(),null)});
await test('invalid percent stays in edit mode until corrected or escaped',async()=>{$('#tune').onclick();const sell=$('[data-amount-side="sell"]');sell.value='101';sell.oninput();await $('#tune').onclick();assert.ok(c.api.draft());assert.equal(stored.settings.sellPresets[0],37);sell.onkeydown(key('Escape'));assert.equal(c.api.draft(),null)});
await test('buy gas/slippage/bribe Save closes settings and persists exact terms',async()=>{$('.terms-edit').onclick();assert.equal($('.exec-editor').hidden,false);$('[data-exec-field="slippageBps"]').value='25';$('[data-exec-field="gasTotalSol"]').value='.004';$('[data-exec-field="mevBribeSol"]').value='.003';await $('#apply-execution').onclick();assert.equal($('.exec-editor').hidden,true);assert.equal(c.api.open(),false);const t=stored.settings.executionPresets[0].buy;assert.equal(t.slippageBps,2500);assert.ok(Math.abs(t.networkFeeSol+t.priorityFeeSol-.004)<1e-12);assert.equal(t.mevBribeSol,.003)});
await test('sell settings Enter saves separately and leaves buy fees untouched',async()=>{shadow.querySelectorAll('.terms-edit')[1].onclick();$('[data-exec-field="mevBribeSol"]').value='.009';$('.exec-editor').listeners.keydown(key('Enter'));await tick();assert.equal($('.exec-editor').hidden,true);assert.equal(stored.settings.executionPresets[0].sell.mevBribeSol,.009);assert.equal(stored.settings.executionPresets[0].buy.mevBribeSol,.003)});
console.log(`${count} editor flow tests passed`);
