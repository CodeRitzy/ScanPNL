// extension popup: on/off switch, account summary, open positions and settings; every change goes
// through the background, which checks and saves it
"use strict";

// element by id
const byId = (id) => document.getElementById(id);
// the account as the background last sent it
let state;

// sends a request to the background and keeps the account it returns
async function message(request)
{
  const reply = await chrome.runtime.sendMessage(request);
  if (reply?.error) throw Error(reply.error);
  if (reply?.state) state = reply.state;
  return reply;
}

// shows a line of feedback
const status = (text) => (byId("status").textContent = text);
// runs an action and shows any error in the status line
async function run(task)
{
  try
  {
    await task();
  }
  catch (error)
  {
    status(error.message);
  }
}

// true when amounts show in usd
const usdMode = () => state.preferences.pnlCurrency === "USD" && state.solUsd > 0;
// formats a number, or a dash when unknown
const num = (value) => (Number.isFinite(value) ? ScanPNLCore.displayNumber(value) : "—");
// an amount in sol or usd
const money = (value) =>
  usdMode() ? (value < 0 ? "-$" : "$") + num(Math.abs(value * state.solUsd)) : num(value) + " SOL";
// an amount with its sign
const signed = (value) => (value > 0 ? "+" : "") + money(value);
// a pnl percent as a whole number
const percent = (value) => ScanPNLCore.pnlPercent(value);
// colors an element green or red by the value
const tone = (node, value) =>
{
  node.classList.toggle("gain", value > 0);
  node.classList.toggle("loss", value < 0);
  return node;
};

// creates an element with an optional class and text
function node(tag, className, text)
{
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

// shows an empty-list message
function empty(list, text)
{
  list.replaceChildren(node("p", "empty", text));
}

// a token's ticker or name
const tokenName = (mint) =>
{
  const position = state.positions[mint];
  return position?.ticker || position?.name || mint.slice(0, 6);
};

// draws the whole popup from the account

function render()
{
  if (!state) return;
  const on = state.preferences.paperEnabled;
  byId("power").setAttribute("aria-checked", String(on));
  byId("power-label").textContent = on ? "On" : "Off";
  byId("mode-text").textContent = on
    ? "Paper trading on Axiom"
    : "Off · Axiom shows your real wallet";
  document.body.classList.toggle("off", !on);

  // account summary
  const account = ScanPNLCore.portfolio(state, state.solUsd);
  const open = Object.values(state.positions).filter((position) => position.qty > 0);
  byId("balance").textContent = usdMode()
    ? "$" + num(state.balance * state.solUsd)
    : num(state.balance);
  byId("balance-unit").hidden = usdMode();
  tone(byId("pnl"), account.pnl).textContent = signed(account.pnl);
  if (state.initial > 0) byId("pnl").title = percent((account.pnl / state.initial) * 100);
  byId("equity").textContent = money(account.equity);
  byId("open").textContent = String(open.length);
  renderPositions(open);
  renderSettings();
}

// open positions, largest first, each linking to its axiom page
function renderPositions(open)
{
  const list = byId("position-list");
  if (!open.length) return empty(list, "No open positions. Buy on Axiom while ScanPNL is on.");
  const rows = open
    .map((position) => ({
      position,
      stats: ScanPNLCore.metrics(position, state.solUsd, state.trades),
    }))
    .sort((first, second) => second.stats.holding - first.stats.holding)
    .map(({ position, stats }) =>
    {
      const row = node("div", "row");
      const link = node("a", "", tokenName(position.mint));
      link.href = "https://axiom.trade" + ScanPNLAccount.safeUrl(position.url, position.mint);
      link.target = "_blank";
      link.rel = "noopener";
      const side = node("div", "side-figure");
      side.append(
        node("span", "figure", money(stats.holding)),
        tone(node("span", "chip", percent(stats.pct)), stats.pnl),
      );
      row.append(
        link,
        side,
        node(
          "small",
          "",
          `${num(position.qty)} tokens · ${position.quoteStatus === "fresh" ? "live price" : "last price"}`,
        ),
      );
      return row;
    });
  list.replaceChildren(...rows);
}

// fills the settings tab
function renderSettings()
{
  const prefs = state.preferences;
  // a field being typed in is never overwritten
  if (document.activeElement !== byId("balance-input"))
  {
    byId("balance-input").value = Number(state.balance.toFixed(6));
  }
  if (document.activeElement !== byId("delay-input"))
  {
    byId("delay-input").value = prefs.executionDelayMs;
  }
  for (const button of document.querySelectorAll("[data-currency]"))
  {
    button.setAttribute("aria-checked", String(button.dataset.currency === prefs.pnlCurrency));
  }
  const wallets = state.walletSummaries || [];
  byId("wallet-list").replaceChildren(
    ...wallets.map((wallet) =>
    {
      const row = node("div", "row");
      row.append(
        node("span", "name", wallet.name.replace(/^scanpnl\. /, "")),
        node("span", "figure", num(wallet.balance) + " SOL"),
      );
      return row;
    }),
  );
}

// on/off: the background adds or removes the page scripts and reloads axiom tabs
byId("power").onclick = () =>
  run(async () =>
  {
    const on = !state.preferences.paperEnabled;
    byId("power").disabled = true;
    try
    {
      await message({
        type: "preferences",
        preferences: {
          paperEnabled: on,
        },
      });
    }
    finally
    {
      byId("power").disabled = false;
    }
    render();
    status(
      on
        ? "ScanPNL is on. Axiom tabs reloaded into paper mode."
        : "ScanPNL is off. Axiom tabs reloaded with nothing from ScanPNL.",
    );
  });

// tabs, switched by click or arrow keys
const tabs = [...document.querySelectorAll('[role="tab"]')];
// shows one tab and hides the others
function selectTab(tab)
{
  for (const other of tabs)
  {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    byId(other.getAttribute("aria-controls")).hidden = !selected;
  }
}
tabs.forEach((tab, index) =>
{
  tab.onclick = () => selectTab(tab);
  tab.onkeydown = (event) =>
  {
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
    }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  };
});

// sets the paper balance; positions and pnl stay
byId("set-balance").onclick = () =>
  run(async () =>
  {
    await message({
      type: "balance",
      balance: Number(byId("balance-input").value),
    });
    render();
    status("Balance saved. Positions and PnL kept.");
  });
// switches pnl between sol and usd
for (const button of document.querySelectorAll("[data-currency]"))
{
  button.onclick = () =>
    run(async () =>
    {
      await message({
        type: "preferences",
        preferences: {
          pnlCurrency: button.dataset.currency,
        },
      });
      render();
    });
}

// sets how long orders take to fill
byId("set-delay").onclick = () =>
  run(async () =>
  {
    const ms = Number(byId("delay-input").value);
    await message({
      type: "preferences",
      preferences: {
        executionDelayMs: ms,
        executionDelayMode: "fixed",
      },
    });
    render();
    status(`Orders fill ${ms} ms after you click.`);
  });
// adds a paper wallet funded from the main balance
byId("create-wallet").onclick = () =>
  run(async () =>
  {
    await message({
      type: "createPaperWallet",
      name: byId("wallet-name").value,
      funding: Number(byId("wallet-funding").value),
    });
    byId("wallet-name").value = "";
    byId("wallet-funding").value = "0";
    render();
    status("Paper wallet added.");
  });
// downloads the account as a backup file
byId("export").onclick = () =>
  run(async () =>
  {
    const { backup } = await message({
      type: "export",
    });
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      }),
    );
    const link = node("a");
    link.href = url;
    link.download = "scanpnl-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status("Backup exported.");
  });
// a checked backup waiting for confirmation before it replaces the account
let pendingImport;
// checks a chosen backup file
byId("import-file").onchange = () =>
  run(async () =>
  {
    const file = byId("import-file").files[0];
    byId("import-file").value = "";
    if (!file) return;
    if (file.size > 2e7) throw Error("Backup is larger than 20 MB.");
    const backup = JSON.parse(await file.text());
    ScanPNLAccount.restore(backup);
    pendingImport = backup;
    byId("confirm-import").hidden = false;
    status("Backup is valid. Press Replace account to load it.");
  });
// replaces the account with the checked backup
byId("confirm-import").onclick = () =>
  run(async () =>
  {
    await message({
      type: "import",
      backup: pendingImport,
    });
    pendingImport = undefined;
    byId("confirm-import").hidden = true;
    render();
    status("Account restored from backup.");
  });

// destructive buttons: the first press arms them, a second press within 5 s runs the task
function armed(button, label, task)
{
  const idle = button.textContent;
  button.onclick = () =>
    run(async () =>
    {
      // "true" rather than "": an empty string is falsy and would never count as armed
      if (!button.dataset.armed)
      {
        button.dataset.armed = "true";
        button.textContent = label;
        setTimeout(() =>
        {
          delete button.dataset.armed;
          button.textContent = idle;
        }, 5000);
        return;
      }
      delete button.dataset.armed;
      button.textContent = idle;
      await task();
      render();
    });
}

// starts pnl over; positions and history stay
armed(byId("reset-pnl"), "Confirm reset PnL", async () =>
{
  await message({
    type: "resetPnl",
    scope: "allTime",
  });
  status("PnL reset. Positions and history kept.");
});

// replaces the account with a fresh one
armed(byId("reset"), "Confirm reset", async () =>
{
  await message({
    type: "reset",
    balance: Number(byId("balance-input").value) || 10,
  });
  status("Paper account reset. The previous one is backed up locally.");
});

// redraws when the account or prices change

let refresh;
chrome.storage.onChanged.addListener((changes, area) =>
{
  if (
    refresh ||
    !((area === "local" && changes.ledger) || (area === "session" && changes.market))
  )
  {
    return;
  }
  refresh = setTimeout(() =>
  {
    refresh = undefined;
    run(async () =>
    {
      await message({
        type: "state",
      });
      render();
    });
  }, 300);
});

// first load
run(async () =>
{
  await message({
    type: "state",
  });
  render();
  requestAnimationFrame(() => document.body.classList.add("ready"));
});
