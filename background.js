// background worker: owns the paper account, fills orders, keeps prices and switches paper mode on and off
importScripts("core.js", "account.js", "market.js", "router.js", "guard-rules.js");

const fromPage = ScanPNLRouter.page;
const fromPopup = ScanPNLRouter.popup;

// axiom quote sources that beat dexscreener while under 2 minutes old
const AXIOM_SOURCES = ["axiom", "axiom-chart", "axiom-stream", "axiom-pulse"];

// account changes run one at a time; the last saved account is kept in memory
let queue = Promise.resolve();
let cachedAccount;
let marketFlight;
let marketQueue = Promise.resolve();

// drops the cached account when storage changes elsewhere
chrome.storage.onChanged?.addListener((changes, area) =>
{
  if (area === "local" && changes.ledger) cachedAccount = undefined;
});

// runs a task after every earlier one has finished
function serial(task)
{
  const run = queue.catch(() => {}).then(task);
  queue = run.catch(() => {});
  return run;
}

// loads the account; saves it back when it was upgraded or orphaned orders were cancelled
async function load()
{
  if (cachedAccount) return structuredClone(cachedAccount);
  const stored = await chrome.storage.local.get([
    "ledger",
    "walletCount",
    "pnlCurrency",
    "executionDelayMs",
  ]);
  const account = ScanPNLAccount.cancelOrphans(ScanPNLAccount.normalize(stored.ledger, stored));
  if (
    stored.ledger?.version !== ScanPNLAccount.VERSION ||
    account.orders.some((order, index) => order.status !== stored.ledger.orders?.[index]?.status)
  )
  {
    if (stored.ledger) await chrome.storage.local.set({ legacyBackupV1: stored.ledger });
    await chrome.storage.local.set({ ledger: account });
  }
  cachedAccount = structuredClone(account);
  return account;
}

// saves the account and keeps paper mode's guards in step with it
async function persist(account)
{
  account.updatedAt = Date.now();
  await chrome.storage.local.set({ ledger: account });
  cachedAccount = structuredClone(account);
  syncMode(account.preferences.paperEnabled).catch(() => {});
  return account;
}

// the account as a page (selected wallets combined) or the popup (with every wallet listed) sees it
function viewFor(account, market, sender)
{
  const view = fromPage(sender)
    ? ScanPNLAccount.tradingView(account, market)
    : ScanPNLAccount.view(account, market);
  if (fromPopup(sender))
  {
    view.walletSummaries = ScanPNLAccount.walletEntries(account).map(([id, wallet]) => ({
      id,
      name: id === "main" ? "scanpnl. Main" : wallet.name,
      balance: wallet.balance,
    }));
  }
  return view;
}

// latest market prices, kept for the browser session
async function market()
{
  return (await chrome.storage.session.get("market")).market || { quotes: {} };
}

// updates the stored market prices one change at a time
function updateMarket(change)
{
  const run = marketQueue
    .catch(() => {})
    .then(async () =>
    {
      const next = change(await market());
      await chrome.storage.session.set({ market: next });
      return next;
    });
  marketQueue = run.catch(() => {});
  return run;
}

// paper mode on: the page guard runs in every axiom frame at document_start (it survives restarts)
const PAGE_GUARD = {
  id: "scanpnl-guard",
  matches: ["https://axiom.trade/*", "https://*.axiom.trade/*"],
  js: ["guard-rules.js", "execution-guard.js"],
  runAt: "document_start",
  world: "MAIN",
  allFrames: true,
  matchOriginAsFallback: true,
  persistAcrossSessions: true,
};

// registers or removes the page guard
async function syncPageGuard(on)
{
  const ids = (await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_GUARD.id] })).map(
    (script) => script.id,
  );
  if (on && !ids.length) await chrome.scripting.registerContentScripts([PAGE_GUARD]);
  if (!on && ids.length) await chrome.scripting.unregisterContentScripts({ ids });
}

// reloads every open axiom tab
async function reloadAxiomTabs()
{
  for (const tab of await chrome.tabs.query({
    url: ["https://axiom.trade/*", "https://*.axiom.trade/*"],
  }))
  {
    chrome.tabs.reload(tab.id).catch(() => {});
  }
}

// browser-level rules: trade-shaped axiom writes from workers and frames the page guard cannot reach
const GUARD_CONDITION = {
  requestMethods: ["post", "put", "patch", "delete"],
  resourceTypes: ["xmlhttprequest", "ping", "other"],
  initiatorDomains: ["axiom.trade"],
};
const BLOCK_RULES = ScanPNLGuardRules.TRADE_WORDS.map((word, index) => ({
  id: 1 + index,
  priority: 1,
  action: { type: "block" },
  condition: { ...GUARD_CONDITION, urlFilter: "||axiom.trade/*" + word },
}));

// block rules plus an allow rule per read-only endpoint (any chrome cannot compile is skipped)
async function guardRules()
{
  const rules = [...BLOCK_RULES];
  for (const [index, regexFilter] of ScanPNLGuardRules.ALLOW.entries())
  {
    const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({
      regex: regexFilter,
      isCaseSensitive: true,
    });
    if (isSupported)
    {
      rules.push({
        id: 100 + index,
        priority: 2,
        action: { type: "allow" },
        condition: { ...GUARD_CONDITION, regexFilter, isUrlFilterCaseSensitive: true },
      });
    }
  }
  return rules;
}

// paper mode on/off: page guard and browser rules together, one switch at a time
let guardSynced;
let guardQueue = Promise.resolve();
function syncMode(on)
{
  guardQueue = guardQueue
    .catch(() => {})
    .then(async () =>
    {
      if (guardSynced === on) return;
      await syncPageGuard(on);
      const removeRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).map(
        (rule) => rule.id,
      );
      try
      {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds,
          addRules: on ? await guardRules() : [],
        });
      }
      catch (error)
      {
        // paper mode is never left without the block rules
        if (!on) throw error;
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds,
          addRules: BLOCK_RULES,
        });
      }
      guardSynced = on;
    });
  return guardQueue;
}

// refreshes dexscreener prices for held tokens (and one more mint when asked)
async function poll(fast = false, mint)
{
  if (marketFlight)
  {
    await marketFlight;
    if (!mint) return;
    const quote = (await market()).quotes?.[mint];
    if (quote && Date.now() - quote.at < 4000) return;
  }
  marketFlight = (async () =>
  {
    const account = await serial(load);
    const current = await market();
    if (!mint && Date.now() - (current.checkedAt || 0) < (fast ? 4000 : 20000)) return;
    try
    {
      const held = ScanPNLAccount.walletEntries(account)
        .flatMap(([, wallet]) => Object.values(wallet.positions))
        .filter((position) => position.qty > 0)
        .map((position) => position.mint);
      const fresh = await ScanPNLMarket.refresh(
        held.concat(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || "") ? [mint] : []),
        current,
      );
      await updateMarket((latest) =>
      {
        // dexscreener is only a fallback: axiom streams the price the user sees
        for (const [key, quote] of Object.entries(latest.quotes || {}))
        {
          if (
            !fresh.quotes[key] ||
            quote.at > fresh.quotes[key].at ||
            (AXIOM_SOURCES.includes(quote.source) && Date.now() - quote.at < 120000)
          )
          {
            fresh.quotes[key] = quote;
          }
        }
        if ((latest.solUsdAt || 0) > (fresh.solUsdAt || fresh.checkedAt || 0))
        {
          fresh.solUsd = latest.solUsd;
          fresh.solUsdAt = latest.solUsdAt;
        }
        return fresh;
      });

      // token images from the market data
      await serial(async () =>
      {
        const latestAccount = await load();
        let changed = false;
        for (const [key, quote] of Object.entries(fresh.quotes || {}))
        {
          const position = latestAccount.positions[key];
          if (
            position &&
            quote.image &&
            /^https:\/\//.test(quote.image) &&
            position.image !== quote.image
          )
          {
            position.image = quote.image;
            changed = true;
          }
        }
        if (changed) await persist(latestAccount);
      });
    }
    catch (error)
    {
      await updateMarket((latest) => ({ ...latest, checkedAt: Date.now(), error: error.message }));
    }
  })().finally(() =>
  {
    marketFlight = undefined;
  });
  return marketFlight;
}

// request handlers: each gets the loaded account in `job`; returning a reply ends the request,
// otherwise `job.changed` saves the account and the current state is sent back
const handlers = {
  // records a pending order from the page
  async prepare(job, message, sender)
  {
    if (!fromPage(sender)) throw Error("Prepare orders from Axiom only");
    const { state, order } = ScanPNLAccount.begin(job.account, message);
    await persist(state);
    return { state: viewFor(state, await market(), sender), order };
  },

  // fills a pending order at the page's quote; a failed fill marks the order failed
  async trade(job, message, sender)
  {
    if (!fromPage(sender)) throw Error("Execute orders from Axiom only");
    const order = job.account.orders.find((item) => item.id === message.id);
    if (order && order.status !== "pending")
    {
      return { state: viewFor(job.account, await market(), sender) };
    }
    try
    {
      job.account = ScanPNLAccount.fill(job.account, message, message.quote);
    }
    catch (error)
    {
      const pending = job.account.orders.find((item) => item.id === message.id);
      if (pending?.status === "pending")
      {
        Object.assign(pending, { status: "failed", reason: error.message, failedAt: Date.now() });
      }
      await persist(job.account);
      throw error;
    }
    job.changed = true;
  },

  // cancels a pending order
  async cancel(job, message)
  {
    const order = job.account.orders.find((item) => item.id === message.id);
    if (order?.status === "pending")
    {
      Object.assign(order, {
        status: "cancelled",
        cancelledAt: Date.now(),
        reason: "Cancelled by user",
      });
      job.changed = true;
    }
  },

  // live prices of held tokens from axiom's stream; a recent chart price is kept
  async marks(job, message, sender)
  {
    if (!fromPage(sender) || !job.account.preferences.paperEnabled)
    {
      throw Error("Invalid stream quote source");
    }
    await updateMarket((latest) =>
    {
      const quotes = { ...latest.quotes };
      let solUsd = latest.solUsd;
      let solUsdAt = latest.solUsdAt || 0;
      for (const quote of (message.quotes || []).slice(0, 100))
      {
        ScanPNLCore.quote(quote);
        if (
          !ScanPNLAccount.walletEntries(job.account).some(
            ([, wallet]) => wallet.positions[quote.mint]?.qty > 0,
          )
        )
        {
          continue;
        }
        const known = quotes[quote.mint];
        const chartIsFresh = known?.source === "axiom-chart" && Date.now() - known.at < 5000;
        if (!chartIsFresh && (!known || quote.at > known.at))
        {
          quotes[quote.mint] = { ...quote, source: "axiom-stream" };
          if (quote.at > solUsdAt)
          {
            solUsd = quote.solUsd;
            solUsdAt = quote.at;
          }
        }
      }
      return { ...latest, quotes, solUsd, solUsdAt };
    });
    return { ok: true };
  },

  // the price shown on the open token page; also keeps the token's supply and image
  async mark(job, message, sender)
  {
    if (!fromPage(sender)) throw Error("Invalid quote source");
    const quote = message.quote;
    ScanPNLCore.quote(quote);
    const position = job.account.positions[quote.mint];
    const supply = Number(quote.supply);
    let changed = false;
    if (
      position &&
      Number.isFinite(supply) &&
      supply > 0 &&
      supply <= 1e18 &&
      position.supply !== supply
    )
    {
      position.supply = supply;
      changed = true;
    }
    if (
      position &&
      typeof quote.image === "string" &&
      quote.image.startsWith("https://") &&
      position.image !== quote.image
    )
    {
      position.image = quote.image;
      changed = true;
    }
    if (changed) await persist(job.account);
    await updateMarket((latest) =>
    {
      const known = latest.quotes?.[quote.mint];
      if (known && quote.at <= known.at) return latest;
      return {
        ...latest,
        ...(quote.at > (latest.solUsdAt || 0) ? { solUsd: quote.solUsd, solUsdAt: quote.at } : {}),
        quotes: {
          ...latest.quotes,
          [quote.mint]: {
            ...quote,
            source: quote.source === "axiom-chart" ? "axiom-chart" : "axiom",
          },
        },
      };
    });

    // a small reply: sending the whole account back on every price froze axiom's page
    return { ok: true };
  },

  // adds a pnl history point per wallet, at most every 15 s
  async sample(job)
  {
    const prices = await market();
    const now = Date.now();
    for (const [, wallet] of ScanPNLAccount.walletEntries(job.account))
    {
      wallet.history ||= [];
      if (wallet.history.length && now - wallet.history.at(-1).at < 15000) continue;
      const priced = ScanPNLAccount.view(wallet, prices);
      wallet.history.push({ at: now, pnl: ScanPNLCore.portfolio(priced, priced.solUsd).pnl });
      wallet.history = wallet.history.slice(-5000);
      job.changed = true;
    }
  },

  // axiom's instant-trade panel settings (fees and slippage) read from the page
  async nativePanelSettings(job, message, sender)
  {
    if (!fromPage(sender)) throw Error("Native settings must come from Axiom");
    for (const side of ["buy", "sell"])
    {
      const settings = message.settings?.[side];
      if (
        !settings ||
        settings.source !== "axiom-native-panel" ||
        !Number.isFinite(settings.tolerance) ||
        settings.tolerance < 0 ||
        settings.tolerance > 1
      )
      {
        throw Error("Invalid native panel settings");
      }
      ScanPNLAccount.validatePreferences({ ...job.account.preferences, costs: settings.costs });
    }
    if (JSON.stringify(job.account.nativePanelSettings) !== JSON.stringify(message.settings))
    {
      job.account.nativePanelSettings = message.settings;
      job.changed = true;
    }
  },

  // adds a paper wallet (popup only)
  async createPaperWallet(job, message, sender)
  {
    if (!fromPopup(sender)) throw Error("Create wallets from the scanpnl extension");
    ScanPNLAccount.createWallet(job.account, message.name, message.funding);
    job.changed = true;
  },

  // chooses which paper wallets trade (from axiom's wallet menu)
  async selectPaperWallets(job, message, sender)
  {
    if (!fromPage(sender) || !job.account.preferences.paperEnabled)
    {
      throw Error("Select wallets in Axiom paper mode");
    }
    ScanPNLAccount.selectWallets(job.account, message.ids);
    job.changed = true;
  },

  // changes preferences; pages may only switch the pnl currency
  async preferences(job, message, sender)
  {
    const currencyOnly =
      fromPage(sender) &&
      Object.keys(message.preferences || {}).length === 1 &&
      message.preferences.pnlCurrency;
    if (!fromPopup(sender) && !currencyOnly) throw Error("Change settings from scanpnl only");
    const wasOn = job.account.preferences.paperEnabled;
    job.account.preferences = ScanPNLAccount.validatePreferences({
      ...job.account.preferences,
      ...message.preferences,
    });
    job.toggled = wasOn !== job.account.preferences.paperEnabled;
    job.changed = true;
  },

  // sets the free balance; the difference counts as a deposit, not pnl (popup only)
  async balance(job, message, sender)
  {
    if (
      !fromPopup(sender) ||
      !Number.isFinite(message.balance) ||
      message.balance < 0 ||
      message.balance > 1e6
    )
    {
      throw Error("Invalid balance");
    }
    job.account.initial += message.balance - job.account.balance;
    job.account.balance = message.balance;
    job.changed = true;
  },

  // starts pnl over: the page resets its selected wallets, the popup every wallet
  async resetPnl(job, message, sender)
  {
    if (!job.account.preferences.paperEnabled) throw Error("Paper mode is off");
    const prices = await market();
    const now = Date.now();
    const period = message.scope || "allTime";
    const wallets = fromPage(sender)
      ? ScanPNLAccount.selectedEntries(job.account)
      : ScanPNLAccount.walletEntries(job.account);
    for (const [id, wallet] of wallets)
    {
      const reset = ScanPNLAccount.resetPnl(
        wallet,
        ScanPNLAccount.view(wallet, prices),
        now,
        period,
      );
      if (id === "main") job.account = reset;
      else job.account.paperWallets[id] = reset;
    }
    job.changed = true;
  },

  // replaces the account with a fresh one, keeping preferences and a backup (popup only)
  async reset(job, message, sender)
  {
    if (!fromPopup(sender)) throw Error("Reset from scanpnl only");
    const fresh = ScanPNLAccount.normalize(ScanPNLCore.create(Number(message.balance)));
    fresh.preferences = job.account.preferences;
    fresh.resetCount = job.account.resetCount + 1;
    fresh.resetAt = Date.now();
    await chrome.storage.local.set({ lastResetBackup: ScanPNLAccount.backup(job.account) });
    job.account = fresh;
    job.changed = true;
  },

  // the account as a backup file (popup only)
  async export(job, message, sender)
  {
    if (!fromPopup(sender)) throw Error("Export from scanpnl only");
    return { backup: ScanPNLAccount.backup(job.account) };
  },

  // replaces the account from a backup file, keeping the current one as a backup (popup only)
  async import(job, message, sender)
  {
    if (!fromPopup(sender)) throw Error("Import from scanpnl only");
    const restored = ScanPNLAccount.restore(message.backup);
    await chrome.storage.local.set({ preImportBackup: ScanPNLAccount.backup(job.account) });
    job.account = restored;
    job.changed = true;
  },
};

// runs one request against the account and returns its reply
async function handle(message, sender)
{
  const job = { account: await load(), changed: false, toggled: false };
  const handler = handlers[message.type];
  if (!handler && message.type !== "state") throw Error("Unknown request");
  const reply = handler && (await handler(job, message, sender));
  if (reply) return reply;
  if (job.changed) await persist(job.account);
  // switching paper mode: guards are in place before axiom tabs reload into the new mode
  if (job.toggled)
  {
    await syncMode(job.account.preferences.paperEnabled);
    await reloadAxiomTabs();
  }
  return { state: viewFor(job.account, await market(), sender) };
}

// answers messages from axiom pages and the popup
chrome.runtime.onMessage.addListener((message, sender, reply) =>
{
  if (sender.id !== chrome.runtime.id) return;
  // with paper mode off a page asking to be set up gets nothing
  const authorized =
    message?.type === "scanpnl.bootstrap"
      ? serial(load).then((account) =>
        account.preferences.paperEnabled
          ? ScanPNLRouter.authorize(message, sender)
          : { handled: true, result: { allowed: false } },
      )
      : ScanPNLRouter.authorize(message, sender);
  authorized
    .then((auth) =>
    {
      if (auth.handled)
      {
        reply(auth.result);
        return;
      }

      // a fresh price for one token, outside the account queue
      if (message.type === "refresh")
      {
        poll(true, message.mint)
          .then(async () =>
          {
            const prices = await market();
            reply({
              state: viewFor(await serial(load), prices, sender),
              quote: prices.quotes?.[message.mint],
            });
          })
          .catch((error) => reply({ error: error.message }));
        return;
      }
      serial(() => handle(message, sender))
        .then((result) =>
        {
          reply(result);
          if (["state", "trade"].includes(message.type)) poll().catch(() => {});
        })
        .catch((error) => reply({ error: error.message }));
    })
    .catch((error) => reply({ error: error.message }));
  return true;
});

// refreshes prices every minute
chrome.alarms.onAlarm.addListener((alarm) =>
{
  if (alarm.name === "scanpnl-quotes") poll().catch(() => {});
});

// applies the saved paper mode; an unreadable account keeps paper mode on
const syncFromAccount = () =>
  serial(load)
    .then((account) => syncMode(account.preferences.paperEnabled))
    .catch(() => syncMode(true));

// worker start: price alarm, paper mode guards and a first price refresh
async function start()
{
  chrome.alarms.create("scanpnl-quotes", { periodInMinutes: 1 });
  // settings of the trade panel removed in 1.6.1
  chrome.storage.local.remove("scanpnlInstantPanel").catch(() => {});
  await syncFromAccount();
  await poll(true);
}
start().catch(() => {});
chrome.runtime.onStartup.addListener(() => start().catch(() => {}));

// after an update, guards are in place before open axiom tabs reload into the new version
chrome.runtime.onInstalled.addListener((details) =>
{
  (async () =>
  {
    await syncFromAccount();
    if (details.reason === "update") await reloadAxiomTabs();
    await start();
  })().catch(() => {});
});
