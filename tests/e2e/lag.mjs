// lag check on an axiom-sized page: ~1.7k import map entries, chunks the extension cannot bind to,
// and images loading all the time; fails on any task over 100 ms
// usage: node tests/e2e/lag.mjs (env: PLAYWRIGHT_CORE, CHROMIUM as in run.mjs; EXTENSION=<dir>)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXTENSION || path.resolve(here, "../.."); // EXTENSION: compare another build
const require = createRequire(import.meta.url);
const core =
  process.env.PLAYWRIGHT_CORE ||
  path.join(
    execSync("npm root -g").toString().trim(),
    "@playwright/cli/node_modules/playwright-core",
  );
const { chromium } = require(core);

// an axiom-shaped import map: many shared-* and page-* chunks plus other modules
const hash = (i) => (i * 2654435761).toString(36).slice(-8);
const imports = {};
for (let i = 0; i < 300; i++)
{
  imports[`/assets/shared-${i}-${hash(i)}.js`] =
    `/assets/shared-${i}-${hash(i + 1)}.js?dpl=dpl_${hash(i + 2)}`;
}
for (let i = 0; i < 300; i++)
{
  imports[`/assets/page-route${i}-${hash(i + 3)}.js`] =
    `/assets/page-route${i}-${hash(i + 4)}.js?dpl=dpl_${hash(i + 5)}`;
}
for (let i = 0; i < 1062; i++)
{
  imports[`/assets/Module${i}-${hash(i + 6)}.js`] =
    `/assets/Module${i}-${hash(i + 7)}.js?dpl=dpl_${hash(i + 8)}`;
}
const head = `<script type="importmap">${JSON.stringify({ imports })}</script>
<script>performance.setResourceTimingBufferSize(10000); window.longTasks = [];
new PerformanceObserver((l) => { for (const e of l.getEntries()) window.longTasks.push(Math.round(e.duration)); }).observe({ type: "longtask" });
setInterval(() => { new Image().src = "/assets/avatar-" + Date.now() + ".webp"; }, 400);</script>`;
const page0 = fs
  .readFileSync(path.join(here, "fixture.html"), "utf8")
  .replace("<title>", head + "<title>");
const chunk = Array.from({ length: 2000 }, (_, i) => `var q${i}=function(a){return a+${i}};`).join(
  "",
);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scanpnl-lag-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM || undefined,
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.route(/^https:\/\/axiom\.trade\//, (route) =>
{
  const u = route.request().url();
  if (route.request().resourceType() === "document")
  {
    return route.fulfill({ contentType: "text/html", body: page0 });
  }
  if (/\/assets\/.*\.js/.test(u))
  {
    return route.fulfill({
      contentType: "text/javascript",
      body: chunk,
      headers: { "cache-control": "max-age=3600" },
    });
  }
  return route.fulfill({ status: 404, body: "" });
});
await context.route(/^https:\/\/([a-z0-9-]+\.axiom\.trade|api\.dexscreener\.com)\//, (r) =>
  r.fulfill({ status: 200, body: "[]" }),
);
let [worker] = context.serviceWorkers();
worker ||= await context.waitForEvent("serviceworker");
await worker.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
const page = await context.newPage();
await page.goto("https://axiom.trade/meme/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?chain=sol");
await page.waitForTimeout(6000); // ScanPNL injected, adapters attempted their binds
await page.evaluate(() => window.longTasks.splice(0));
await page.waitForTimeout(10000);
const tasks = await page.evaluate(() => window.longTasks);
const injected = await page.evaluate(() => document.documentElement.dataset.scanpnlStatus || "");
const worst = Math.max(0, ...tasks);
console.log(
  `ScanPNL injected: ${!!injected}  long tasks in 10 s: ${tasks.length}  worst: ${worst} ms`,
);
const ok = !!injected && worst <= 100;
console.log(
  ok ? "PASS  no freezes on an Axiom-like page" : "FAIL  page froze (or ScanPNL did not load)",
);
await context.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
