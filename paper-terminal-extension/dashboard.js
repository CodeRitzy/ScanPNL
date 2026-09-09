// Single-page portfolio. Execution settings live in Instant Trade.
const STORAGE_KEY = "paperTerminalState";

const DEFAULT_STATE = {
  ...TradeTerminalSettings.initialAccount(),
  fills: [],
  positions: {},
  settings: {
    enabled: true,
    mainTerminal: "axiom",
    trenchesQuickBuy: true,
    trenchesInstantTrade: true,
    startingBalance: TradeTerminalSettings.DEFAULT_SOL_PRICE,
    solPrice: TradeTerminalSettings.DEFAULT_SOL_PRICE,
    buyPresets: [
      { id: "buy-01", label: "0.1", value: 0.1, unit: "SOL", shortcut: "1", primary: false, confirm: false, color: "neutral" },
      { id: "buy-025", label: "0.25", value: 0.25, unit: "SOL", shortcut: "2", primary: false, confirm: false, color: "neutral" },
      { id: "buy-05", label: "0.5", value: 0.5, unit: "SOL", shortcut: "3", primary: true, confirm: false, color: "violet" },
      { id: "buy-1", label: "1", value: 1, unit: "SOL", shortcut: "4", primary: false, confirm: false, color: "neutral" },
      { id: "buy-2", label: "2", value: 2, unit: "SOL", shortcut: "5", primary: false, confirm: false, color: "neutral" },
    ],
    quickBuyAmountSol: 0.5,
    sellPresets: [10, 25, 50, 75, 100],
    slippageBps: 3000,
    slippageFormatVersion: 2,
    executionDefaultsVersion: 3,
    networkFeeSol: 0.000005,
    priorityFeeSol: 0.001995,
    mevBribeSol: 0.001,
    activeExecutionPreset: "p1",
      activePresetDefaultVersion: 1,
    executionPresets: TradeTerminalSettings.profiles(),
    instantTradePositions: {},
    instantTradeUnit: "SOL",
    priceImpactBps: 20,
    latencyMs: 120,
    undoSeconds: 5,
    shortcutsEnabled: true,
    sounds: false,
    reducedMotion: false,
    enabledTerminals: { axiom: true, gmgn: true, terminal: true, photon: true, bullx: true, dexscreener: true, unknown: false },
  },
  version: 1,
};

const TERMINAL_LABELS = {
  axiom: "Axiom",
  gmgn: "GMGN",
  terminal: "Padre / Terminal",
  photon: "Photon",
  bullx: "BullX",
  dexscreener: "Dexscreener",
  unknown: "Other / unrecognized sites",
};

const wholeSlippageBps = (value) => Math.round(Math.min(100, Math.max(0, Number.isFinite(Number(value)) ? Number(value) / 100 : 30))) * 100;

function normalizeSlippageSettings(settings, stored = {}) {
  const migrating = stored.slippageFormatVersion !== 2;
  settings.slippageBps = wholeSlippageBps(migrating && stored.slippageBps === 50 ? 3000 : settings.slippageBps);
  const prior = { p1: [0, 100, 0.000005, 0.001, 0.001], p2: [50, 100, 0.000005, 0.003, 0.005], p3: [0, 0, 0, 0, 0] };
  const fields = ["slippageBps", "feeBps", "networkFeeSol", "priorityFeeSol", "mevBribeSol"];
  settings.executionPresets = settings.executionPresets.map((profile) => {
    const wasDefault = migrating && prior[profile.id] && fields.every((key, i) => profile[key] === prior[profile.id][i]);
    const next = { ...profile, slippageBps: wholeSlippageBps(wasDefault ? 3000 : profile.slippageBps ?? 3000) };
    for (const side of ["buy", "sell"]) if (profile[side]) next[side] = { ...profile[side],
      slippageBps: wholeSlippageBps(profile[side].slippageBps ?? next.slippageBps) };
    return next;
  });
  settings.slippageFormatVersion = 2;
  return settings;
}
function normalizeState(state) {
  if (!state) return structuredClone(DEFAULT_STATE);
  const storedProfiles = state.settings?.executionPresets;
  const oldDefaults = Array.isArray(storedProfiles) &&
    storedProfiles.some((profile) => profile.id === "p1" && profile.slippageBps === 25 && profile.feeBps === 50) &&
    storedProfiles.some((profile) => profile.id === "p2" && profile.slippageBps === 50 && profile.feeBps === 95) &&
    storedProfiles.some((profile) => profile.id === "p3" && profile.slippageBps === 200 && profile.feeBps === 125);
  const executionPresets = !Array.isArray(storedProfiles) || oldDefaults
    ? DEFAULT_STATE.settings.executionPresets.map((profile) => ({ ...profile }))
    : storedProfiles.map((profile) => ({ ...profile }));
  const settings = {
    ...DEFAULT_STATE.settings,
    ...state.settings,
    executionPresets,
    instantTradePositions: { ...DEFAULT_STATE.settings.instantTradePositions, ...state.settings?.instantTradePositions },
    buyPresets: state.settings?.buyPresets ?? DEFAULT_STATE.settings.buyPresets,
    enabledTerminals: { ...DEFAULT_STATE.settings.enabledTerminals, ...state.settings?.enabledTerminals },
  };
  return { ...DEFAULT_STATE, ...state, initialFundingPending:state.initialFundingPending===true, settings: TradeTerminalSettings.normalizeDefaults(normalizeSlippageSettings(settings, state.settings), state.settings) };
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

const fmtUsd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtCompactUsd = (n) => `$${Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(Math.max(0, n || 0))}`;
const fmtPrice = (n) => n > 0 ? n < 0.01 ? `$${n.toPrecision(4)}` : fmtUsd(n) : "—";
const positionKey = (token) => `${token.chain}:${token.address}`;

const D=PortfolioData,C=PnlCards,UI_KEY='paperTerminalPortfolioPrefs';
const root=document.getElementById('root'),calendarDialog=document.getElementById('calendar-dialog'),cardDialog=document.getElementById('card-dialog');
let state=null,livePrices={},ui={range:'max',unit:'SOL',tab:'positions'},query='',expanded=new Set(),calendarDate=new Date(),selectedDay=null,cardSession=null,refreshing=false,renderQueued=false;
const icons={calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',share:'<path d="M12 16V3m-4 4 4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',chevron:'<path d="m9 5 7 7-7 7"/>',expand:'<path d="m6 9 6 6 6-6"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.share}</svg>`;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tone=value=>value>1e-9?'positive':value< -1e-9?'negative':'neutral';
const solPrice=()=>Math.max(.000001,D.n(state.settings.solPrice)||1);
const money=(value,signed=false)=>C.amount(D.n(value),ui.unit,solPrice(),signed);
const pct=value=>value==null?'—':`${value>0?'+':''}${value.toFixed(2)}%`;
const quantity=value=>Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2}).format(value||0);
const dateText=stamp=>new Date(stamp).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
const priceFor=token=>livePrices[token.quoteAddress||token.altAddress||token.address]?.price||livePrices[token.address]?.price||D.n(token.price);
const allRounds=()=>D.rounds(state,priceFor);
const currentPeriod=()=>{const {start,end}=D.periodBounds(ui.range);return D.period(state,start,end);};
function persistUI(){chrome.storage.local.set({[UI_KEY]:ui}).catch(()=>{});}
function toast(message){const box=document.getElementById('toast');box.textContent=message;box.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>box.classList.remove('show'),3000);}
function buttonIcon(name,label,attrs=''){return `<button class="icon-button" aria-label="${escape(label)}" title="${escape(label)}" ${attrs}>${icon(name)}</button>`;}
function renderShell(){root.innerHTML=`<header class="topbar"><h1>Portfolio</h1><span class="spacer"></span><span class="account-value" id="account-value"></span></header><div class="toolbar"><span class="muted">Your trading, at a glance.</span><span class="spacer"></span><div class="periods" aria-label="P&L timeframe">${['1d','7d','30d','max'].map(id=>`<button data-range="${id}">${id==='max'?'Max':id.toUpperCase()}</button>`).join('')}</div><button class="unit-button" data-unit title="SOL values use the current SOL/USD quote">⇅ ${ui.unit}</button></div><section class="dashboard-shell"><div id="overview" class="overview"></div><div class="table-toolbar"><div class="table-tabs" role="tablist" aria-label="Trades"><button role="tab" data-tab="positions">Active positions <span id="open-count" class="count"></span></button><button role="tab" data-tab="history">History <span id="history-count" class="count"></span></button></div><span class="spacer"></span><input class="search" id="search" type="search" placeholder="Search token or address" aria-label="Search token or address"></div><div class="table-scroll"><table><thead><tr><th>Token</th><th>Bought</th><th>Sold</th><th>Holding</th><th>P&L</th><th>Last trade</th><th style="text-align:right">Actions</th></tr></thead><tbody id="trade-rows"></tbody></table><div id="empty-state" class="empty-state" hidden></div></div></section><footer class="bottom-note"><span>ScanPNL · 1.0.0</span><span>Execution settings in Instant Trade</span></footer>`;
  root.addEventListener('click',onRootClick);document.getElementById('search').addEventListener('input',event=>{query=event.target.value;renderTable();});render();
}
function render(){if(!state)return;renderOverview();renderTable();}
function renderOverview(){
  const total=D.equity(state,priceFor),period=currentPeriod(),rounds=allRounds(),closed=rounds.filter(r=>!r.open),wins=closed.filter(r=>r.pnl>0).length,losses=closed.filter(r=>r.pnl<0).length,winRate=wins+losses?wins/(wins+losses)*100:0;
  document.getElementById('account-value').innerHTML=`<img class="sol-icon" src="assets/solana-logomark.svg" alt="SOL">${escape((total.cash/solPrice()).toLocaleString(undefined,{maximumFractionDigits:3}))}`;
  for(const b of root.querySelectorAll('[data-range]')){b.classList.toggle('active',b.dataset.range===ui.range);b.setAttribute('aria-pressed',String(b.dataset.range===ui.range));}
  root.querySelector('[data-unit]').textContent=`⇅ ${ui.unit}`;
  document.getElementById('overview').innerHTML=`<section class="balance-panel"><div class="panel-heading"><h2>Balance</h2><span class="caption">${ui.unit}</span></div><div><div class="balance-label">Total value</div><div class="balance-value">${money(total.total)}</div></div><div><div class="balance-label">Unrealized P&L</div><div class="${tone(total.unrealized)}">${money(total.unrealized,true)}</div></div><hr class="balance-divider"><div class="balance-pair"><span class="muted">Available balance</span><span>${money(total.cash)}</span></div><div class="balance-pair"><span class="muted">Holding</span><span>${money(total.holding)}</span></div></section><section class="chart-panel"><div class="panel-heading"><h2>Realized P&L <span class="caption">· ${ui.range==='max'?'All time':ui.range.toUpperCase()}</span></h2><span>${buttonIcon('calendar','P&L calendar','data-calendar')}${buttonIcon('share','Share timeframe P&L','data-share-period')}</span></div><div class="chart-total ${tone(period.pnl)}">${money(period.pnl,true)}</div><span class="chart-caption">${pct(period.percent)} on closed cost basis · ${period.fills.length} transactions</span>${chartMarkup()}</section><section class="performance-panel"><div class="panel-heading"><h2>Performance</h2></div><div class="metric"><span class="muted">Realized P&L</span><strong class="${tone(period.pnl)}">${money(period.pnl,true)}</strong></div><div class="metric"><span class="muted">Transactions</span><strong>${period.fills.length} <span class="positive">${period.buys}</span> / <span class="negative">${period.sells}</span></strong></div><div class="metric"><span class="muted">All-time win rate</span><strong>${wins+losses?winRate.toFixed(1)+'%':'—'}</strong></div><div class="win-track"><div class="wins" style="width:${winRate}%"></div><div class="losses" style="width:${wins+losses?100-winRate:0}%"></div></div><div class="caption">${wins} profitable · ${losses} losing closed trades</div></section>`;
}
function chartMarkup(){const {start,end}=D.periodBounds(ui.range),points=D.curve(state,start,end),w=840,h=170,min=Math.min(0,...points.map(p=>p.value)),max=Math.max(0,...points.map(p=>p.value)),span=max-min||1,t0=points[0].time,dt=end-t0||1;
  const xy=p=>[12+(p.time-t0)/dt*(w-24),12+(max-p.value)/span*(h-34)];const path=points.map((p,i)=>`${i?'L':'M'}${xy(p).map(n=>n.toFixed(2)).join(' ')}`).join(' '),color=points.at(-1).value<0?'#ef4d79':'#2ed6aa';
  return `<svg class="chart" viewBox="0 0 ${w} ${h+20}" preserveAspectRatio="none" role="img" aria-label="Realized profit and loss over ${escape(ui.range)}"><defs><linearGradient id="pnl-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".16"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M12 ${h-20}H${w-12}" stroke="#ffffff09"/><path d="${path} L${w-12} ${h} L12 ${h} Z" fill="url(#pnl-area)"/><path d="${path}" fill="none" stroke="${color}" stroke-width="1.7" vector-effect="non-scaling-stroke"/><text x="12" y="${h+14}" class="chart-date">${escape(dateText(t0))}</text><text x="${w-12}" y="${h+14}" text-anchor="end" class="chart-date">Now</text></svg>`;
}
function tokenMarkup(token){const initial=String(token.symbol||'?').slice(0,1).toUpperCase();return `<div class="token-cell"><span class="token-avatar">${escape(initial)}</span><div><div class="token-name">${escape(token.symbol||'TOKEN')}</div><div class="token-sub">${escape(token.name||token.address||'')} · ${escape(TERMINAL_LABELS[token.terminal]||token.terminal||'')}</div></div></div>`;}
function renderTable(){const rounds=allRounds();document.getElementById('open-count').textContent=rounds.filter(r=>r.open).length;document.getElementById('history-count').textContent=rounds.length;for(const tab of root.querySelectorAll('[data-tab]')){const active=tab.dataset.tab===ui.tab;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));}
  const filtered=rounds.filter(r=>(ui.tab==='history'||r.open)&&`${r.token.symbol} ${r.token.name} ${r.token.address}`.toLowerCase().includes(query.toLowerCase()));
  const tbody=document.getElementById('trade-rows'),empty=document.getElementById('empty-state');empty.hidden=filtered.length>0;
  empty.innerHTML=query?'No trades match that search.':ui.tab==='positions'?'<strong>No open positions</strong>Your next buy will appear here.':'<strong>Your trading story starts here</strong>Buy or sell from Instant Trade to see your history.';
  tbody.innerHTML=filtered.map(r=>`<tr class="data-row"><td>${tokenMarkup(r.token)}</td><td class="positive">${money(r.bought)}<span class="subvalue">${r.fills.filter(f=>f.side==='buy').length} buys</span></td><td class="negative">${money(r.sold)}<span class="subvalue">${r.fills.filter(f=>f.side==='sell').length} sells</span></td><td>${money(r.holding)}<span class="subvalue">${r.open?quantity(r.quantity)+' '+escape(r.token.symbol||'tokens'):'Closed'}</span></td><td class="${tone(r.pnl)}">${money(r.pnl,true)}<span class="subvalue ${tone(r.pnl)}">${pct(r.percent)}</span></td><td>${escape(dateText(r.updatedAt))}<span class="subvalue">${new Date(r.updatedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span></td><td><div class="row-actions">${buttonIcon('expand','Show buys and sells',`data-expand="${escape(r.id)}" aria-expanded="${expanded.has(r.id)}"`)}${buttonIcon('share','Create P&L card',`data-share-round="${escape(r.id)}"`)}</div></td></tr>${expanded.has(r.id)?`<tr class="detail-row"><td colspan="7"><div class="fill-list">${r.fills.slice().reverse().map(fillMarkup).join('')||'<span class="muted">No individual fills saved for this legacy position.</span>'}</div></td></tr>`:''}`).join('');
}
function fillMarkup(f){return `<div class="fill-item"><strong class="${f.side==='buy'?'positive':'negative'}">${f.side==='buy'?'Buy':'Sell'}</strong><span>${escape(f.token.symbol||'TOKEN')}<small class="subvalue"> ${new Date(f.timestamp).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</small></span><span>${money(f.grossUsd)}<span class="muted"> · ${quantity(f.quantity)}</span></span><span class="${tone(D.realized(f))}">${f.side==='sell'?money(D.realized(f),true):'—'}<small class="muted"> ${f.side==='sell'?'realized':''}</small></span>${buttonIcon('share','Share trade',`data-share-fill="${escape(f.id)}"`)}</div>`;}
function onRootClick(event){const b=event.target.closest('button');if(!b)return;if(b.dataset.range){ui.range=b.dataset.range;persistUI();renderOverview();}if(b.hasAttribute('data-unit')){ui.unit=ui.unit==='SOL'?'USD':'SOL';persistUI();render();}if(b.dataset.tab){ui.tab=b.dataset.tab;persistUI();renderTable();}if(b.hasAttribute('data-calendar'))openCalendar();if(b.hasAttribute('data-share-period'))openCard(D.cardForPeriod(currentPeriod(),`${ui.range==='max'?'All-time':ui.range.toUpperCase()} Realized`));if(b.dataset.expand){expanded.has(b.dataset.expand)?expanded.delete(b.dataset.expand):expanded.add(b.dataset.expand);renderTable();}if(b.dataset.shareRound){const r=allRounds().find(r=>r.id===b.dataset.shareRound);if(r)openCard(D.cardForRound(r));}if(b.dataset.shareFill)shareFill(b.dataset.shareFill);}
function shareFill(id){const f=state.fills.find(f=>f.id===id);if(!f)return;if(f.side==='buy'){const r=allRounds().find(r=>r.fills.some(x=>x.id===id));if(r)openCard(D.cardForRound(r));}else{const basis=Math.max(0,D.n(f.grossUsd)-D.n(f.feeUsd)-D.realized(f));openCard({title:f.token.symbol||'TOKEN',kind:'Sell · realized P&L',pnl:D.realized(f),percent:basis?D.realized(f)/basis*100:null,rows:[['Bought',basis],['Sold',D.n(f.grossUsd)]],timestamp:f.timestamp});}}
function openCalendar(){calendarDate=new Date();selectedDay=null;renderCalendar();calendarDialog.showModal();}
function renderCalendar(){const year=calendarDate.getFullYear(),month=calendarDate.getMonth(),data=D.month(state,year,month),monthName=calendarDate.toLocaleDateString(undefined,{month:'long',year:'numeric'}),offset=(new Date(year,month,1).getDay()+6)%7,totalMovement=data.positive-data.negative,selected=data.days.find(d=>d.key===selectedDay),today=D.dateKey(Date.now());
  calendarDialog.innerHTML=`<header class="modal-head"><h2 id="calendar-title">P&L Calendar</h2><div class="calendar-navigation"><button class="icon-button" data-month="-1" aria-label="Previous month">‹</button><strong>${escape(monthName)}</strong><button class="icon-button" data-month="1" aria-label="Next month">›</button></div><button class="unit-button" data-calendar-unit>⇅ ${ui.unit}</button>${buttonIcon('close','Close calendar','data-close-calendar')}</header><div class="modal-body"><div class="calendar-summary"><div><div class="calendar-total ${tone(data.pnl)}">${money(data.pnl,true)}</div><div class="calendar-meta">${data.fills.length} transactions · <span class="positive">${data.buys} buys</span> / <span class="negative">${data.sells} sells</span></div></div><button data-share-month>Monthly P&L ${icon('share')}</button></div><div class="calendar-bars"><i style="width:${totalMovement?data.positive/totalMovement*100:0}%"></i><i style="width:${totalMovement?-data.negative/totalMovement*100:0}%"></i></div><div class="weekdays">${['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d=>`<span>${d}</span>`).join('')}</div><div class="calendar-grid">${'<div></div>'.repeat(offset)}${data.days.map(day=>`<button class="calendar-day ${day.pnl>0?'gain':day.pnl<0?'loss':''} ${day.key===selectedDay?'selected':''} ${day.key===today?'today':''}" data-day="${day.key}" aria-label="${escape(dateText(day.start))}: ${escape(money(day.pnl,true))}, ${day.fills.length} transactions" aria-pressed="${day.key===selectedDay}"><span class="day-number">${day.day}</span><span class="day-value ${tone(day.pnl)}">${escape(ui.unit==='SOL'?C.amount(day.pnl,'SOL',solPrice(),true).replace(' SOL',''):money(day.pnl,true))}</span><span class="tx-count">${day.fills.length?`${day.fills.length} txns`:' '}</span></button>`).join('')}</div><div class="calendar-footer"><span>${data.days.filter(d=>d.pnl>0).length} green days · ${data.days.filter(d=>d.pnl<0).length} red days</span><span>Realized P&L · Local time</span></div>${selected?`<section class="day-detail"><div class="day-title"><div><h3>${dateText(selected.start)}</h3><span class="calendar-meta">${selected.buys} buys · ${selected.sells} sells</span></div><strong class="${tone(selected.pnl)}">${money(selected.pnl,true)}</strong></div><div class="fill-list">${selected.fills.slice().reverse().map(fillMarkup).join('')||'<div class="muted">No trades this day.</div>'}</div></section>`:''}</div>`;
}
calendarDialog.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.hasAttribute('data-close-calendar'))calendarDialog.close();if(b.dataset.month){calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()+Number(b.dataset.month),1);selectedDay=null;renderCalendar();}if(b.hasAttribute('data-calendar-unit')){ui.unit=ui.unit==='SOL'?'USD':'SOL';persistUI();renderCalendar();render();}if(b.dataset.day){selectedDay=b.dataset.day;renderCalendar();calendarDialog.querySelector(`[data-day="${selectedDay}"]`)?.focus({preventScroll:true});const day=D.month(state,calendarDate.getFullYear(),calendarDate.getMonth()).days.find(d=>d.key===selectedDay);if(day)openCard({...D.cardForPeriod(day,new Date(day.start).toLocaleDateString(undefined,{month:"long",day:"numeric",year:"numeric"})),kind:"",timestamp:day.start});}if(b.hasAttribute('data-share-month')){const m=D.month(state,calendarDate.getFullYear(),calendarDate.getMonth());openCard({...D.cardForPeriod(m,calendarDate.toLocaleDateString(undefined,{month:'long',year:'numeric'})),rows:[['Start cash',m.startCash],['End cash',m.endCash],['Total sold',m.sold]]});}if(b.dataset.shareFill)shareFill(b.dataset.shareFill);});
async function openCard(card){
  if(cardSession)closeCardSession();
  const session={card,media:null,mediaUrl:null,urls:[],cancel:new AbortController(),generation:0,frame:0,mode:'image',busy:false};cardSession=session;
  cardDialog.className='card-dialog';cardDialog.innerHTML=`<header class="modal-head"><h2 id="card-title">P&L card</h2><span class="spacer"></span>${buttonIcon('close','Close P&L card','data-close-card')}</header><div class="card-stage"><canvas id="pnl-canvas" width="1200" height="800" role="img" aria-label="${escape(card.title)} P&L card"></canvas></div><div class="card-tools"><div class="tool-row"><div class="segmented" aria-label="Export format"><button data-mode="image" class="active">Image</button><button data-mode="video">Video</button></div><span class="spacer"></span><input class="card-name" id="card-handle" maxlength="40" aria-label="User handle on card" placeholder="@handle (optional)"><button data-card-unit class="unit-button">⇅ ${ui.unit}</button></div><div class="tool-row font-tools"><span id="card-font" class="caption">Univers</span><button data-font-upload>Upload Univers font</button><input id="font-upload" type="file" accept=".otf,.ttf,.woff,.woff2" hidden></div><div class="tool-label">BACKGROUND</div><div id="backgrounds" class="backgrounds"></div><input id="media-upload" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm,video/quicktime" hidden><div class="caption" style="font-size:10px">Images, GIFs and videos · saved on this device · up to 100 MB</div><div class="card-actions"><span class="spacer"></span><button id="copy-card">Copy image</button><button id="download-card" class="primary-button">Download</button></div><div class="card-status" id="card-status" role="status"></div><div class="photo-credit" id="photo-credit"></div></div>`;
  if(!cardDialog.open)cardDialog.showModal();session.canvas=cardDialog.querySelector('canvas');
  session.prefs=await C.preferences();if(cardSession!==session)return;session.handle=session.prefs.handle||session.prefs.name||'';session.unit=session.prefs.unit||ui.unit;cardDialog.querySelector('#card-handle').value=session.handle;cardDialog.querySelector('[data-card-unit]').textContent=`⇅ ${session.unit}`;
  session.font=await C.loadFont();if(cardSession!==session)return;cardDialog.querySelector('#card-font').textContent=session.font.label;
  try{session.assets=[...C.PRESETS,...await C.list()];}catch{session.assets=[...C.PRESETS];cardStatus('Saved media is unavailable. Built-in backgrounds still work.');}
  if(cardSession!==session)return;renderBackgrounds();await selectBackground(session.prefs.background||C.PRESETS[0].id);
}
function cardStatus(message){const node=cardDialog.querySelector('#card-status');if(node)node.textContent=message;}
function drawCard(){const s=cardSession;if(s)C.paint(s.canvas,s.media,s.card,{unit:s.unit||ui.unit,solPrice:solPrice(),handle:s.handle||'',fontFamily:s.font?.family||'Arial',theme:s.asset?.theme||'dark'});}
function renderBackgrounds(){const s=cardSession;if(!s)return;const box=cardDialog.querySelector('#backgrounds');box.innerHTML='';for(const asset of s.assets){const b=document.createElement('button');b.className='background-choice';b.dataset.background=asset.id;b.title=asset.name;b.setAttribute('aria-label',asset.name);const url=asset.blob?(asset.url ||= URL.createObjectURL(asset.blob)):asset.url;if(asset.blob&&!s.urls.includes(url))s.urls.push(url);const media=document.createElement(asset.type.startsWith('video/')?'video':'img');media.src=url;media.muted=true;media.preload='metadata';media.alt='';b.appendChild(media);const label=document.createElement('span');label.textContent=asset.name.length>15?asset.name.slice(0,12)+'…':asset.name;b.appendChild(label);if(asset.type==='image/gif'||asset.type.startsWith('video/')){const tag=document.createElement('span');tag.className='media-tag';tag.textContent=asset.type==='image/gif'?'GIF':'VIDEO';b.appendChild(tag);}box.appendChild(b);}const upload=document.createElement('button');upload.className='background-choice upload-button';upload.dataset.upload='';upload.textContent='+ Upload';box.appendChild(upload);}
async function selectBackground(id){const s=cardSession;if(!s)return;const asset=s.assets.find(a=>a.id===id)||s.assets[0],generation=++s.generation;cardStatus('Loading background…');try{const media=await C.loadMedia(asset);if(cardSession!==s||s.generation!==generation){media.pause?.();media.close?.();return;}s.media?.pause?.();s.media?.close?.();cancelAnimationFrame(s.frame);s.media=media;s.asset=asset;s.media.play?.().catch(()=>{});drawCard();if(asset.type==='image/gif'||asset.type.startsWith('video/')){const tick=()=>{if(cardSession!==s)return;drawCard();s.frame=requestAnimationFrame(tick);};s.frame=requestAnimationFrame(tick);}for(const b of cardDialog.querySelectorAll('[data-background]'))b.classList.toggle('active',b.dataset.background===asset.id);await C.preferences({background:asset.id});if(cardSession!==s)return;cardStatus('');const credit=cardDialog.querySelector('#photo-credit');credit.innerHTML=asset.page?`Photo by <a href="${escape(asset.page)}" target="_blank" rel="noopener noreferrer">${escape(asset.author)}</a> · Unsplash`:'Your saved background';}catch(error){if(cardSession===s){cardStatus(error.message);drawCard();}}}
function closeCardSession(){const s=cardSession;if(!s)return;s.cancel.abort();cancelAnimationFrame(s.frame);s.media?.pause?.();s.media?.close?.();for(const url of s.urls)URL.revokeObjectURL(url);cardSession=null;}
cardDialog.addEventListener('close',closeCardSession);
cardDialog.addEventListener('input',event=>{if(event.target.id==='card-handle'&&cardSession){cardSession.handle=event.target.value;drawCard();C.preferences({handle:cardSession.handle}).catch(()=>cardStatus('Handle could not be saved.'));}});
cardDialog.addEventListener('change',async event=>{if(event.target.id==='font-upload'&&cardSession){const s=cardSession,file=event.target.files?.[0];if(!file)return;try{const font=await C.saveFont(file);if(cardSession!==s)return;s.font=font;cardDialog.querySelector('#card-font').textContent=font.label;drawCard();cardStatus('');}catch(error){if(cardSession===s)cardStatus(error.message);}finally{event.target.value='';}return;}if(event.target.id!=='media-upload'||!cardSession)return;const file=event.target.files?.[0],s=cardSession;if(!file)return;cardStatus('Saving background…');try{const asset=await C.save(file);if(cardSession!==s)return;s.assets.push(asset);renderBackgrounds();await selectBackground(asset.id);}catch(error){cardStatus(error.message);}finally{event.target.value='';}});
cardDialog.addEventListener('click',async event=>{
  const b=event.target.closest('button'),s=cardSession;if(!b||!s)return;
  if(b.hasAttribute('data-close-card')){cardDialog.close();return;}if(s.busy)return;
  if(b.dataset.background)await selectBackground(b.dataset.background);
  if(b.hasAttribute('data-font-upload'))cardDialog.querySelector('#font-upload').click();
  if(b.hasAttribute('data-upload'))cardDialog.querySelector('#media-upload').click();
  if(b.dataset.mode){s.mode=b.dataset.mode;for(const item of cardDialog.querySelectorAll('[data-mode]'))item.classList.toggle('active',item.dataset.mode===s.mode);cardDialog.querySelector('#copy-card').disabled=s.mode==='video';cardStatus(s.mode==='video'?'Exports an 8-second WebM video.':'Exports the current frame as a PNG image.');}
  if(b.hasAttribute('data-card-unit')){s.unit=s.unit==='SOL'?'USD':'SOL';b.textContent=`⇅ ${s.unit}`;drawCard();await C.preferences({unit:s.unit});}
  if(['copy-card','download-card'].includes(b.id)){
    s.busy=true;const download=cardDialog.querySelector('#download-card'),copy=cardDialog.querySelector('#copy-card');download.disabled=copy.disabled=true;
    try{drawCard();const filename=String(s.card.title).replace(/[^a-z0-9_-]/gi,'-').slice(0,60)||'pnl';
      if(b.id==='copy-card'){const blob=await C.png(s.canvas);await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);cardStatus('Image copied.');}
      else if(s.mode==='video'){const blob=await C.record(s.canvas,drawCard,s.cancel.signal,percent=>cardStatus(`Creating video… ${Math.round(percent)}%`));C.download(blob,filename+'.webm');cardStatus('Video downloaded.');}
      else{C.download(await C.png(s.canvas),filename+'.png');cardStatus('Image downloaded.');}
    }catch(error){if(cardSession===s)cardStatus(error.message||'Export unavailable. Try Download image.');}
    finally{if(cardSession===s){s.busy=false;download.disabled=false;copy.disabled=s.mode==='video';}}
  }
});
async function refreshLivePrices(){if(refreshing||!state?.settings.enabled)return;refreshing=true;try{const tokens=Object.values(state.positions||{}).filter(p=>p.quantity>0).map(p=>p.token);await Promise.all(tokens.map(async token=>{try{const address=token.quoteAddress||token.altAddress||token.address,res=await chrome.runtime.sendMessage({type:'FETCH_PRICE',address,chain:token.chain,mint:token.mint,fresh:true,solPrice:solPrice()});if(res?.pair?.priceUsd)livePrices[address]={price:Number(res.pair.priceUsd),at:Date.now()};}catch{}}));}finally{refreshing=false;}}
function scheduleRender(){if(renderQueued)return;renderQueued=true;setTimeout(()=>{renderQueued=false;if(state){renderOverview();if(!root.contains(document.activeElement)||document.activeElement.id==='search')renderTable();}},150);}
chrome.runtime.onMessage.addListener(message=>{if(message?.type!=='LIVE_PRICE'||!(message.token?.price>0))return;for(const id of TradeTerminalSettings.tokenIds(message.token))livePrices[id]=message.token;scheduleRender();});
chrome.storage.onChanged.addListener((changes,area)=>{if(area&&area!=='local')return;if(changes[STORAGE_KEY]){state=normalizeState(changes[STORAGE_KEY].newValue);scheduleRender();if(calendarDialog.open&&!cardDialog.open)renderCalendar();}});
(async function init(){try{const stored=await chrome.storage.local.get([STORAGE_KEY,UI_KEY]);state=normalizeState(stored[STORAGE_KEY]);if(!stored[STORAGE_KEY])await saveState(state);const prefs=stored[UI_KEY]||{};ui={range:['1d','7d','30d','max'].includes(prefs.range)?prefs.range:'max',unit:prefs.unit==='USD'?'USD':'SOL',tab:prefs.tab==='history'?'history':'positions'};renderShell();await refreshLivePrices();render();const requestedCard=new URLSearchParams(location.hash.slice(1)).get('pnl');if(requestedCard){const completed=allRounds().find(r=>!r.open && r.fills.some(f=>f.id===requestedCard));if(completed)openCard(D.cardForRound(completed));}setInterval(async()=>{if(document.hidden)return;await refreshLivePrices();scheduleRender();},4000);}catch(error){root.innerHTML='<div class="empty-state"><strong>Portfolio could not load</strong>Reload this page to try again.</div>';console.error(error);}})();
