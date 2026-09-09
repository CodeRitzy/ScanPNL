const STORAGE_KEY = "paperTerminalState";
const root = document.getElementById("root");

const TERMINALS = [
  { id: "axiom", label: "Axiom", url: "https://axiom.trade/", logo: "assets/logos/axiom.ico" },
  { id: "gmgn", label: "GMGN", url: "https://gmgn.ai/", logo: "assets/logos/gmgn.png" },
  { id: "terminal", label: "Terminal (Padre)", url: "https://trade.padre.gg/", logo: "assets/logos/terminal.png" },
  { id: "photon", label: "Photon", url: "https://photon-sol.tinyastro.io/", logo: "assets/logos/photon.png" },
  { id: "bullx", label: "BullX", url: "https://bullx.io/", logo: "assets/logos/bullx.ico" },
  { id: "dexscreener", label: "DexScreener", url: "https://dexscreener.com/", logo: "assets/logos/dexscreener.ico" },
];

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || {
    ...TradeTerminalSettings.initialAccount(),
    settings: { enabled: true, solPrice:TradeTerminalSettings.DEFAULT_SOL_PRICE, startingBalance:TradeTerminalSettings.DEFAULT_SOL_PRICE },
  };
}

async function render() {
  const state = await loadState();
  const enabled = state.settings?.enabled !== false;
  root.innerHTML = `<main class="${enabled ? "" : "disabled"}">
    <header class="topbar"><button class="settings" id="settings" title="Settings and dashboard" aria-label="Open settings">⚙</button><div class="brand"><small>YOUR TRADING WORKSPACE</small><strong>ScanPNL</strong></div><span class="monogram"><img src="assets/scanpnl-icon-128.png" alt="ScanPNL logo"></span></header>
    <section class="power"><div><strong>${enabled ? "On" : "Off"}</strong><p>${enabled ? "Ready on supported token pages." : "Trading controls are disabled."}</p></div><label class="switch"><input id="enabled" type="checkbox" aria-label="Enable ScanPNL" ${enabled ? "checked" : ""}><span class="slider"></span></label></section>
    <div class="section-title"><h1>Open a terminal</h1><span>${TERMINALS.length} platforms</span></div>
    <nav class="platforms" aria-label="Trading terminals">${TERMINALS.map((terminal) => `<button class="platform" data-terminal="${terminal.id}" ${enabled ? "" : "disabled"}><img src="${terminal.logo}" alt=""><strong>${terminal.label}</strong><span class="arrow" aria-hidden="true">↗</span></button>`).join("")}</nav>
    <footer class="footer"><button class="dashboard" id="dashboard">Dashboard <span aria-hidden="true">→</span></button><p class="status">Your presets. Your layout.<br>One workspace.</p></footer>
  </main>`;

  root.querySelector("#settings").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  root.querySelector("#dashboard").onclick = root.querySelector("#settings").onclick;
  root.querySelector("#enabled").onchange = async (event) => {
    const latest = await loadState();
    latest.settings = { ...latest.settings, enabled: event.target.checked };
    await chrome.storage.local.set({ [STORAGE_KEY]: latest });
    render();
  };
  root.querySelectorAll("[data-terminal]").forEach((button) => {
    button.onclick = async () => {
      const terminal = TERMINALS.find((item) => item.id === button.dataset.terminal);
      if (!terminal) return;
      const latest = await loadState();
      if (latest.settings?.enabled === false) return;
      latest.settings = { ...latest.settings, mainTerminal: terminal.id };
      await chrome.storage.local.set({ [STORAGE_KEY]: latest });
      chrome.tabs.create({ url: terminal.url });
    };
  });
}

render();
