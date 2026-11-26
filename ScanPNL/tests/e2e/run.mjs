// end-to-end check of the unpacked extension in chromium against a stand-in axiom page
// usage: node tests/e2e/run.mjs [--headed] [--hold]
// --hold keeps the browser open on cdp port 9333
// env: PLAYWRIGHT_CORE (playwright-core path), CHROMIUM (browser executable), SHOTS (screenshot dir)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const core =
  process.env.PLAYWRIGHT_CORE ||
  path.join(
    execSync("npm root -g").toString().trim(),
    "@playwright/cli/node_modules/playwright-core",
  );
const { chromium } = require(core);

const HEADED = process.argv.includes("--headed");
const HOLD = process.argv.includes("--hold");
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), "scanpnl-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PAIR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const PULSE_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const PAGE = `https://axiom.trade/meme/${PAIR}?chain=sol`;
const fixture = fs.readFileSync(path.join(here, "fixture.html"), "utf8");

// tiny assertion log
let failed = 0;
function check(name, ok, detail = "")
{
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}
const until = async (fn, ms = 10e3) =>
{
  for (
    const end = Date.now() + ms;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 100))
  )
  {
    if (await fn()) return true;
  }
  return false;
};

// browser with the extension
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scanpnl-e2e-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM || undefined,
  headless: !HEADED,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    ...(HOLD ? ["--remote-debugging-port=9333"] : []),
  ],
});

// network stand-ins; `reached` lists every request that got past the extension
const reached = [];
await context.route(/^https:\/\/axiom\.trade\//, (route) =>
  route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html", body: fixture })
    : route.fulfill({ status: 404, body: "" }),
);
await context.route(
  /^https:\/\/([a-z0-9-]+\.axiom\.trade|rpc\.test\.example|api\.turnkey\.com)\//,
  (route) =>
  {
    reached.push(route.request().method() + " " + route.request().url());
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "ok",
      headers: { "access-control-allow-origin": "*" },
    });
  },
);
await context.route(/^https:\/\/api\.dexscreener\.com\//, (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
);

let [worker] = context.serviceWorkers();
worker ||= await context.waitForEvent("serviceworker");
const extId = new URL(worker.url()).host;
const ruleCount = () =>
  worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length));
const expected = await worker.evaluate(
  () => ScanPNLGuardRules.ALLOW.length + ScanPNLGuardRules.TRADE_WORDS.length,
);
await until(async () => (await ruleCount()) === expected, 4e3);
check(
  "network backstop: block + every allow rule installed",
  (await ruleCount()) === expected,
  `${await ruleCount()}/${expected} rules`,
);
const qty = (mint) =>
  worker.evaluate(
    (m) => chrome.storage.local.get("ledger").then((r) => r.ledger?.positions?.[m]?.qty || 0),
    mint,
  );
const guardRegistered = () =>
  worker.evaluate(() =>
    chrome.scripting
      .getRegisteredContentScripts()
      .then((s) => s.some((c) => c.id === "scanpnl-guard")),
  );
await until(guardRegistered, 4e3);
check("page guard registered while ScanPNL is on", await guardRegistered());

const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(PAGE);

// the scanpnl chip on axiom's own instant-trade panel
const chip = page.locator("#scanpnl-chip");
await chip.waitFor({ state: "visible", timeout: 20e3 }).catch(() => {});
check("ScanPNL chip shows on Axiom's instant-trade panel", await chip.isVisible());
const chipText = (await chip.textContent()) || "";
check("chip says ScanPNL, no paper text", chipText.trim() === "ScanPNL", chipText);
const anchored = async () =>
{
  const [c, p] = await Promise.all([
    chip.boundingBox(),
    page.locator(".buy-click-container").boundingBox(),
  ]);
  return (
    Math.abs(c.x + c.width / 2 - (p.x + p.width / 2)) < 2 && Math.abs(c.y + c.height / 2 - p.y) < 2
  );
};
check("chip sits centred on the panel's top edge", await anchored());
await page.evaluate(() => window.moveInstant(700, 300));
await page.waitForTimeout(100);
check("chip follows when the panel is dragged", await anchored());
await page.evaluate(() => window.moveInstant(1080, 430));
const fees = await page.evaluate(() =>
  [...document.querySelectorAll(".buy-click-container [data-scanpnl-fee]")].map((e) =>
    e.textContent.trim(),
  ),
);
check(
  "fee item in Axiom's buy and sell fee rows (Axiom 1% + 1.25% tax)",
  fees.length === 2 && fees.every((t) => t === "1% + 1.25%"),
  JSON.stringify(fees),
);
check(
  "Axiom's panel stays usable (not inert)",
  !(await page.evaluate(() => document.querySelector(".buy-click-container").inert)),
);

// paper trading through axiom's own panel
const paperBalance = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".buy-click-container .head [data-scanpnl-owned]")]
      .map((e) => e.textContent)
      .join("|"),
  );
await until(async () => (await paperBalance()).includes("10"));
check(
  "panel header shows the paper balance",
  (await paperBalance()).includes("10"),
  await paperBalance(),
);
await page.waitForTimeout(800); // live price + native fee settings relayed
await page.locator(".buy-click-container .text-increase").nth(2).click(); // 0.5 SOL preset
await until(async () => (await qty(MINT)) > 0);
check("Axiom's 0.5 preset places a paper buy", (await qty(MINT)) > 0);
check("Axiom's own buy handler never ran", (await page.evaluate(() => window.nativeClicks)) === 0);
const pnlCell = () =>
  page.evaluate(() =>
  {
    const c = document.querySelector("[data-scanpnl-metric-row] [data-scanpnl-pnl]");
    if (!c) return null;
    const value = [...c.querySelectorAll("span")].find(
      (s) =>
        /\d/.test(s.textContent) &&
        getComputedStyle(s).display !== "none" &&
        /%/.test(s.textContent),
    );
    return {
      text: c.textContent.replace(/\s+/g, " ").trim(),
      lines: value ? value.getClientRects().length : 0,
      pctHidden: getComputedStyle(c.querySelector(".pct")).display === "none",
    };
  });
await until(async () => /\(-3%\)/.test((await pnlCell())?.text || ""));
let cell = await pnlCell();
check(
  "PnL right after the buy is minus the fees (-2.63% shown as -3%)",
  /\(-3%\)/.test(cell?.text || ""),
  cell?.text,
);
check(
  "PnL value and percent sit on one line",
  cell?.lines === 1 && cell?.pctHidden,
  JSON.stringify(cell),
);
await page.evaluate(() => window.setPrice(0.011));
await until(async () => /\(\+7%\)/.test((await pnlCell())?.text || ""), 3e3);
cell = await pnlCell();
check(
  "PnL follows a +10% price move live (+7.11% shown as +7%)",
  /\(\+7%\)/.test(cell?.text || ""),
  cell?.text,
);
await page.screenshot({ path: path.join(SHOTS, "page-paper.png") });
await page.locator("#instant").screenshot({ path: path.join(SHOTS, "instant-panel.png") });

// pulse quick buy goes to paper
// the mint's last fill, with the tax rate its order was charged
const lastTrade = (mint) =>
  worker.evaluate(
    (m) =>
      chrome.storage.local.get("ledger").then(({ ledger }) =>
      {
        const trade = ledger?.trades?.filter((t) => t.mint === m).at(-1);
        const order = ledger?.orders?.find((o) => o.id === trade?.orderId);
        return trade && { ...trade, taxRate: order?.costs?.fee };
      }),
    mint,
  );
const pulseClickAt = Date.now();
await page.locator("[data-pulse-token-address] button").click();
await until(async () => (await qty(PULSE_MINT)) > 0, 12e3);
check("Pulse quick buy places a paper buy", (await qty(PULSE_MINT)) > 0);
const pulseFill = await lastTrade(PULSE_MINT);
check(
  "Pulse quick buy fills at the card's market cap (30 SOL at $100 over 1B supply), right away",
  Math.abs(pulseFill?.usd / 3e-6 - 1) < 1e-9 &&
    pulseFill?.supply === 1e9 &&
    pulseFill.at - pulseClickAt < 2000,
  JSON.stringify({
    usd: pulseFill?.usd,
    supply: pulseFill?.supply,
    ms: pulseFill && pulseFill.at - pulseClickAt,
  }),
);
check(
  "Pulse quick buy charges the token's pump.fun tax (1.25%), not a percent stat on the card (60%)",
  pulseFill?.taxRate === 0.0125,
  String(pulseFill?.taxRate),
);
check(
  "quick buy never reached Axiom's handler",
  (await page.evaluate(() => window.nativeClicks)) === 0,
);
// current axiom cards: the quick buy is a div cell ([data-pulse-qb-cell]), not a button
const CELL_MINT = "5Hr7wZg7oBpVhH5nngRqzr5W7ZFUfCsfEhbziZJak7fr";
await page.locator("#qb-cell").click();
await until(async () => (await qty(CELL_MINT)) > 0, 12e3);
check("Pulse quick-buy cell places a paper buy", (await qty(CELL_MINT)) > 0);
check(
  "quick-buy cell never reached Axiom's handler",
  (await page.evaluate(() => window.nativeClicks)) === 0,
);

// discover and wallet-tracker quick buys go to paper
const DISCOVER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRACKER_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const bought = (mint) =>
  worker.evaluate(
    (m) => chrome.storage.local.get("ledger").then((r) => r.ledger?.positions?.[m]?.bought || 0),
    mint,
  );
await page.locator("#discover-qb").click();
await until(async () => (await qty(DISCOVER_MINT)) > 0, 12e3);
check(
  "Discover quick buy places a 0.2 SOL paper buy (token from Axiom's row props)",
  Math.abs((await bought(DISCOVER_MINT)) - 0.2) < 1e-9,
  String(await bought(DISCOVER_MINT)),
);
await page.locator("#tracker-qb").click();
await until(async () => (await qty(TRACKER_MINT)) > 0, 12e3);
check(
  "wallet-tracker quick buy places a 0.1 SOL paper buy (token from the row link)",
  Math.abs((await bought(TRACKER_MINT)) - 0.1) < 1e-9,
  String(await bought(TRACKER_MINT)),
);
await page.locator("#zero-qb").click();
await page.waitForTimeout(1500);
check(
  "a 0 SOL quick buy places nothing",
  (await qty("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")) === 0,
);
check(
  "Discover / tracker quick buys never reached Axiom's handler",
  (await page.evaluate(() => window.nativeClicks)) === 0,
);

// axiom's "quick buy behavior: go to token"
await page.evaluate(() =>
  localStorage.setItem("settings", JSON.stringify({ quickBuyBehavior: "goto" })),
);
await page.waitForTimeout(1100); // ScanPNL re-reads Axiom's settings object at most once a second
const discoverBefore = await bought(DISCOVER_MINT);
await page.locator("#discover-qb").click();
await until(async () => (await bought(DISCOVER_MINT)) > discoverBefore, 12e3);
await page.waitForTimeout(500);
check(
  "go to token: a Discover button without Axiom's shouldRedirect stays on the page",
  new URL(page.url()).pathname.startsWith("/meme/"),
  page.url(),
);
await page.locator("#qb-cell").click();
await until(async () => new URL(page.url()).pathname === "/token/" + CELL_MINT, 12e3);
check(
  "go to token: a Pulse quick buy opens the token in-app after the paper buy",
  new URL(page.url()).pathname === "/token/" + CELL_MINT,
  page.url(),
);
await page.evaluate(() =>
{
  localStorage.removeItem("settings");
  history.back();
});
await until(async () => new URL(page.url()).pathname.startsWith("/meme/"), 3e3);

// leaving the token page and coming back sends its paper trades to the chart lines again
await page.evaluate(() =>
{
  window.chartTrades = 0;
  window.addEventListener("message", (event) =>
  {
    if (event.data?.type === "scanpnl-chart-trades-v1") window.chartTrades++;
  });
});
await page.waitForTimeout(1500);
await page.evaluate(() =>
{
  history.pushState({}, "", "/pulse");
  window.dispatchEvent(new PopStateEvent("popstate"));
});
await page.waitForTimeout(1500);
await page.evaluate(() =>
{
  window.chartTrades = 0;
  history.back();
});
await until(async () => new URL(page.url()).pathname.startsWith("/meme/"), 3e3);
check(
  "returning to the token sends its paper trades to the chart again",
  await until(() => page.evaluate(() => window.chartTrades > 0), 3e3),
);

// real writes are blocked in every context
const attempt = (fn) => page.evaluate(fn);
const captured = await attempt(() =>
  window.capturedFetch("https://api3.axiom.trade/swap", { method: "POST", body: "x" }).then(
    () => "sent",
    (e) => "blocked: " + e.message,
  ),
);
check("fetch captured before injection is still guarded", captured.startsWith("blocked"), captured);
const fromWorker = await attempt(
  () =>
    new Promise((resolve) =>
    {
      const code =
        'fetch("https://api3.axiom.trade/worker-swap",{method:"POST",body:"x"}).then(()=>postMessage("sent"),e=>postMessage("blocked: "+e.message))';
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      w.onmessage = (e) => resolve(e.data);
      setTimeout(() => resolve("timeout"), 5e3);
    }),
);
check(
  "worker trade write to Axiom is blocked (browser-level rules)",
  fromWorker.startsWith("blocked"),
  fromWorker,
);
const workerRead = await attempt(
  () =>
    new Promise((resolve) =>
    {
      const code =
        'fetch("https://api3.axiom.trade/get-user-settings",{method:"POST",body:"x"}).then(()=>postMessage("sent"),e=>postMessage("blocked: "+e.message))';
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      w.onmessage = (e) => resolve(e.data);
      setTimeout(() => resolve("timeout"), 5e3);
    }),
);
check("worker non-trade request to Axiom still works", workerRead === "sent", workerRead);
const fromFrame = await attempt(() =>
{
  const f = document.createElement("iframe");
  document.body.append(f);
  return f.contentWindow
    .fetch("https://api3.axiom.trade/frame-swap", { method: "POST", body: "x" })
    .then(
      () => "sent",
      (e) => "blocked: " + e.message,
    );
});
check("about:blank iframe write to Axiom is blocked", fromFrame.startsWith("blocked"), fromFrame);
const rpc = await attempt(() =>
  fetch("https://rpc.test.example/", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["x"] }),
  }).then(
    () => "sent",
    (e) => "blocked: " + e.message,
  ),
);
check("sendTransaction to any RPC host is blocked", rpc.startsWith("blocked"), rpc);
const turnkey = await attempt(() =>
  fetch("https://api.turnkey.com/public/v1/submit/sign_transaction", {
    method: "POST",
    body: "{}",
  }).then(
    () => "sent",
    (e) => "blocked: " + e.message,
  ),
);
check("Turnkey transaction signing is blocked", turnkey.startsWith("blocked"), turnkey);
const readOnly = await attempt(() =>
  fetch("https://api6.axiom.trade/refresh-access-token", { method: "POST", body: "x" }).then(
    () => "sent",
    (e) => "blocked: " + e.message,
  ),
);
check("read-only Axiom endpoint still works", readOnly === "sent", readOnly);
check(
  "no blocked write reached the network",
  !reached.some((r) => /swap|native-buy|rpc\.test|sign_transaction/.test(r)),
  reached.join(" | "),
);

// sell through axiom's panel
await page.locator(".buy-click-container .text-decrease").nth(3).click(); // 100%
await until(async () => (await qty(MINT)) === 0);
check("Axiom's 100% preset sells the paper position", (await qty(MINT)) === 0);

// axiom's "reset pnl" (useCumulativePnl): bought starts over after a full exit
const boughtShown = () =>
  page.evaluate(() =>
  {
    const c = document.querySelector("[data-scanpnl-metric-row]")?.firstElementChild;
    return c
      ? [...c.querySelectorAll("span")]
        .filter(
          (s) =>
            !s.children.length && !s.closest("[data-scanpnl-hidden]") && /\d/.test(s.textContent),
        )
        .map((s) => s.textContent.trim())
        .join(" ")
      : "";
  });
await page.evaluate(() => localStorage.setItem("useCumulativePnl", "false"));
await page.locator(".buy-click-container .text-increase").nth(1).click(); // 0.1 SOL preset
await until(async () => (await qty(MINT)) > 0);
await until(async () => /^0\.1\b/.test(await boughtShown()), 4e3);
check(
  "Reset PNL on: Bought shows only the new round (0.1)",
  /^0\.1\b/.test(await boughtShown()),
  await boughtShown(),
);
await page.evaluate(() => localStorage.setItem("useCumulativePnl", "true"));
await until(async () => /^0\.6\b/.test(await boughtShown()), 4e3);
check(
  "Reset PNL off: Bought is cumulative (0.5 + 0.1)",
  /^0\.6\b/.test(await boughtShown()),
  await boughtShown(),
);
await page.evaluate(() => localStorage.removeItem("useCumulativePnl"));
await page.locator(".buy-click-container .text-decrease").nth(3).click(); // 100%: back to no position
await until(async () => (await qty(MINT)) === 0);

// ticker bar: paper positions only in active positions
const ticker = () =>
  page.evaluate(() => ({
    paper: document.querySelectorAll("[data-ticker-strip][data-scanpnl-owned] a[data-scanpnl-mint]")
      .length,
    axiom: !document
      .querySelector("[data-ticker-strip]:not([data-scanpnl-owned])")
      .hasAttribute("data-scanpnl-hidden"),
  }));
await page.waitForTimeout(700);
let tk = await ticker();
check("ticker: Recent pairs stays Axiom's own", tk.axiom && tk.paper === 0, JSON.stringify(tk));
await page.evaluate(() => window.tickerView("positions"));
await until(async () => (await ticker()).paper > 0, 3e3);
tk = await ticker();
check(
  "ticker: Active Positions shows the open paper positions",
  !tk.axiom && tk.paper === 4,
  JSON.stringify(tk),
);
await page.evaluate(() => window.tickerView("watchlist"));
await until(async () => (await ticker()).axiom, 3e3);
tk = await ticker();
check("ticker: Watchlist stays Axiom's own", tk.axiom && tk.paper === 0, JSON.stringify(tk));

// axiom's pnl tracker reset button resets the paper pnl (click twice)
const resetAt = () =>
  worker.evaluate(() =>
    chrome.storage.local.get("ledger").then((r) => r.ledger.pnlResets?.allTime?.at || 0),
  );
await page.locator("#tracker-reset").click();
await page.waitForTimeout(300);
check("tracker reset: first click only asks to confirm", (await resetAt()) === 0);
await page.locator("#tracker-reset").click();
await until(async () => (await resetAt()) > 0, 3e3);
check("tracker reset: second click resets the paper PnL", (await resetAt()) > 0);

// popup: glass panel with the on/off switch
const popup = await context.newPage();
await popup.setViewportSize({ width: 380, height: 640 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
popup.on("pageerror", (e) => console.log("popup pageerror:", e.message));
const power = popup.locator("#power");
await until(async () => (await power.getAttribute("aria-checked")) === "true", 5e3);
check("popup loads and shows ScanPNL on", (await power.getAttribute("aria-checked")) === "true");
check(
  "popup has no 'trade from paper wallets' option",
  (await popup.locator("text=/paper wallets option|Trade from paper wallets/i").count()) === 0,
);
check(
  "popup lists the open quick-buy positions",
  (await popup.locator("#position-list .row").count()) === 4,
);
await popup.screenshot({ path: path.join(SHOTS, "popup-on.png") });
await popup.locator("#tab-settings").click();
await popup.screenshot({ path: path.join(SHOTS, "popup-settings.png"), fullPage: true });
await popup.locator("#tab-positions").click();

// off: axiom with nothing from scanpnl
const reloaded = page.waitForEvent("load", { timeout: 15e3 }).catch(() => {});
await power.click();
await reloaded;
await until(async () => (await ruleCount()) === 0 && !(await guardRegistered()), 5e3);
check("off: network rules removed", (await ruleCount()) === 0);
check("off: page guard unregistered", !(await guardRegistered()));
await page.waitForTimeout(1500); // give any injection a chance to (wrongly) happen
const residue = await page.evaluate(() => ({
  guard: typeof window.ScanPNLGuardRules,
  mode: document.documentElement.dataset.scanpnlPaper ?? null,
  owned: document.querySelectorAll(
    "[data-scanpnl-owned],[data-scanpnl-hidden],#scanpnl-chip,#scanpnl-off",
  ).length,
}));
check(
  "off: no ScanPNL script, attribute or element on Axiom",
  residue.guard === "undefined" && residue.mode === null && residue.owned === 0,
  JSON.stringify(residue),
);
const offWrite = await page.evaluate(() =>
  window.capturedFetch("https://api3.axiom.trade/real-swap", { method: "POST", body: "x" }).then(
    () => "sent",
    (e) => "blocked: " + e.message,
  ),
);
check("off: real Axiom requests pass", offWrite === "sent", offWrite);
check("off: popup switch shows Off", (await power.getAttribute("aria-checked")) === "false");
await popup.screenshot({ path: path.join(SHOTS, "popup-off.png") });

// back on
const reloadedOn = page.waitForEvent("load", { timeout: 15e3 }).catch(() => {});
await power.click();
await reloadedOn;
await until(async () => (await ruleCount()) === expected && (await guardRegistered()), 5e3);
check(
  "on again: rules and page guard restored",
  (await ruleCount()) === expected && (await guardRegistered()),
);
await chip.waitFor({ state: "visible", timeout: 15e3 }).catch(() => {});
check("on again: chip back on Axiom's panel", await chip.isVisible());

// popup resets: each needs a second press
await popup.locator("#tab-settings").click();
const before = await resetAt();
await popup.locator("#reset-pnl").click();
await popup.locator("#reset-pnl").click();
await until(async () => (await resetAt()) > before, 3e3);
check(
  "popup Reset PnL resets on the second press",
  (await resetAt()) > before,
  await popup.textContent("#status"),
);
const account = () =>
  worker.evaluate(() =>
    chrome.storage.local.get("ledger").then(({ ledger: l }) => ({
      trades: l.trades.length,
      positions: Object.keys(l.positions).length,
      history: l.history.length,
      resets: l.resetCount,
    })),
  );
await popup.locator("#reset").click();
await popup.locator("#reset").click();
await until(async () => (await account()).resets === 1, 3e3);
const acc = await account();
check(
  "popup Reset account clears trades, positions and history",
  acc.resets === 1 && acc.trades === 0 && acc.positions === 0 && acc.history === 0,
  JSON.stringify(acc),
);
await popup.close();

console.log(`\n${failed ? failed + " FAILED" : "ALL PASSED"}  screenshots: ${SHOTS}`);
if (HOLD)
{
  console.log("Holding browser on http://localhost:9333 (Ctrl+C to quit).");
  await new Promise(() => {});
}
await context.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
