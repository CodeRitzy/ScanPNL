import fs from 'node:fs';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
const dir=new URL('../paper-terminal-extension/',import.meta.url),read=n=>fs.readFileSync(new URL(n,dir),'utf8');
const dom=new JSDOM('<main><div data-testid="chart"></div></main>',{url:'https://axiom.trade/meme/So11111111111111111111111111111111111111112',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
w.structuredClone=structuredClone;w.matchMedia=()=>({matches:false});let stored,failSave=false;
w.chrome={storage:{local:{async get(){return {paperTerminalState:structuredClone(stored)};}}},runtime:{async sendMessage(msg){
  if(msg.type==='SAVE_SETTINGS'){if(failSave)return {ok:false};stored={...stored,settings:structuredClone(msg.settings)};return {ok:true,state:structuredClone(stored)};}return {ok:true};
}}};
w.eval(read('trade-settings.js'));
w.eval(read('content.js').replace('  init();',`fitPanelSize=()=>({width:340,height:560});globalThis.api={mount(){state=structuredClone(DEFAULT_STATE);currentToken={address:'So11111111111111111111111111111111111111112',chain:'solana',price:1,symbol:'TEST'};const host=document.createElement('div');host.id=ROOT_ID;document.body.append(host);host.attachShadow({mode:'open'});renderPanel();return state;},render:renderPanel,flush:()=>panelSettingsQueue,refresh:refreshSurface};`));
stored=structuredClone(w.api.mount());const shadow=w.document.getElementById('paper-terminal-root').shadowRoot,$=s=>shadow.querySelector(s);
const tick=()=>new Promise(r=>setTimeout(r,0));let count=0;const test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
try {
  await test('cog opens a separate pane with current values and fee controls',()=>{
    $('#dash').click();assert.equal($('.main-pane').hidden,false);assert.equal($('#pnl-mode').value,'cumulative');assert.equal($('#delay-ms').disabled,true);assert.equal($('#quick-amount').tagName,'INPUT');assert.equal($('#quick-amount').type,'number');assert.equal($('#quick-amount').value,'0.5');assert.equal(shadow.querySelectorAll('[data-settings-side]').length,2);
  });
  await test('incoming renders preserve focused settings drafts',()=>{
    $('#custom-delay').checked=true;$('#custom-delay').dispatchEvent(new w.Event('change'));const input=$('#delay-ms');input.value='450';input.focus();w.api.render();assert.equal($('#delay-ms'),input);assert.equal(input.value,'450');
  });
  await test('Save persists options, retains newly arrived account data and closes pane',async()=>{
    $('#pnl-mode').value='reset';$('#quick-amount').value='0.25';$('#quick-delay').checked=true;$('#quick-action').value='chart';stored.balanceUsd=99;stored.fills=[{id:'arrived',timestamp:1}];
    await $('#settings-done').onclick();assert.equal($('.main-pane').hidden,true);assert.equal(stored.balanceUsd,99);assert.equal(stored.fills[0].id,'arrived');assert.equal(stored.settings.pnlMode,'reset');assert.equal(stored.settings.quickBuyAmountSol,.25);assert.equal(stored.settings.customDelayMs,450);assert.equal(stored.settings.quickBuyDelay,true);assert.equal(stored.settings.quickBuyAction,'chart');assert.equal($('#show-bubbles'),null);assert.equal($('#show-averages'),null);assert.equal($('#platform-fees'),null);assert.equal(stored.settings.buyPresets.find(p=>p.primary).id,'buy-05');
  });
  await test('invalid delay stays open without saving',async()=>{
    $('#dash').click();$('#delay-ms').value='-1';await $('#settings-done').onclick();assert.equal($('.main-pane').hidden,false);assert.equal(stored.settings.customDelayMs,450);assert.ok($('.toast').classList.contains('bad'));
  });
  await test('failed persistence retains edits for retry',async()=>{
    $('#delay-ms').value='700';failSave=true;await $('#settings-done').onclick();assert.equal($('.main-pane').hidden,false);assert.equal($('#delay-ms').value,'700');assert.equal(stored.settings.customDelayMs,450);failSave=false;
  });
  await test('Enter saves and restores the normal instant-trade panel',async()=>{
    $('#delay-ms').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal($('.main-pane').hidden,true);assert.equal($('.wrap').classList.contains('settings-open'),false);assert.equal(stored.settings.customDelayMs,700);
  });
  await test('buy execution shortcut opens the correct fee editor and Save closes it',async()=>{
    $('#dash').click();await $('[data-settings-side="buy"]').onclick();assert.equal($('.main-pane').hidden,true);assert.equal($('.exec-editor').hidden,false);$('[data-exec-field="mevBribeSol"]').value='.004';await $('#apply-execution').onclick();assert.equal($('.exec-editor').hidden,true);assert.equal(stored.settings.executionPresets[0].buy.mevBribeSol,.004);
  });
  await test('rapid settings changes autosave in order without closing the pane',async()=>{
    $('#dash').click();$('#pnl-mode').value='cumulative';$('#pnl-mode').dispatchEvent(new w.Event('change',{bubbles:true}));
    $('#quick-action').value='new-tab';$('#quick-action').dispatchEvent(new w.Event('change',{bubbles:true}));
    $('#quick-amount').value='0.33';$('#quick-amount').dispatchEvent(new w.Event('input',{bubbles:true}));
    $('#delay-ms').value='825';$('#delay-ms').dispatchEvent(new w.Event('input',{bubbles:true}));
    await w.api.flush();assert.equal(stored.settings.pnlMode,'cumulative');assert.equal(stored.settings.quickBuyAction,'new-tab');assert.equal(stored.settings.quickBuyAmountSol,.33);assert.equal(stored.settings.customDelayMs,825);assert.equal($('.main-pane').hidden,false);
  });
  await test('execution inputs autosave without hiding the editor',async()=>{
    await $('[data-settings-side="sell"]').onclick();const input=$('[data-exec-field="mevBribeSol"]');input.value='.009';input.dispatchEvent(new w.Event('input',{bubbles:true}));await w.api.flush();assert.equal(stored.settings.executionPresets[0].sell.mevBribeSol,.009);assert.equal($('.exec-editor').hidden,false);
  });
  await test('valid amount edits autosave while empty drafts leave saved values intact',async()=>{
    $('#tune').click();const input=$('[data-amount-side="buy"]');input.value='0.08';input.dispatchEvent(new w.Event('input',{bubbles:true}));await w.api.flush();assert.equal(stored.settings.buyPresets[0].value,.08);input.value='';input.dispatchEvent(new w.Event('input',{bubbles:true}));await w.api.flush();assert.equal(stored.settings.buyPresets[0].value,.08);
  });
  await test('entering another chart restores the main panel after settings changes',async()=>{
    $('#dash').click();w.history.pushState({},'', '/meme/11111111111111111111111111111111');await w.api.refresh();
    const root=w.document.getElementById('paper-terminal-root');assert.ok(root);assert.equal(root.shadowRoot.querySelector('.main-pane').hidden,true);assert.equal(root.shadowRoot.querySelector('.exec-editor').hidden,true);assert.equal(root.shadowRoot.querySelector('.wrap').classList.contains('collapsed'),false);
  });
} finally {w.close();}
console.log(`${count} settings pane tests passed`);
