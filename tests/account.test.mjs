// account orders (account.js) with axiom's cost model
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.ScanPNLCore = require("../core.js");
const account = require("../account.js");

const MINT = "So11111111111111111111111111111111111111112";
const panel = {
  source: "axiom-native-panel",
  costs: { platform: 0.01, fee: 0.0125, slip: 0, fixed: 0.002 },
  tolerance: 0.2,
  referenceUsd: 0.01,
};

function filled(settings = panel)
{
  let s = account.normalize(undefined);
  s.preferences.executionDelayMs = 0;
  const now = Date.now();
  const { state, order } = account.begin(
    s,
    {
      id: "order-0001",
      side: "buy",
      mint: MINT,
      amount: 1,
      walletCount: 1,
      nativeSettings: settings,
    },
    now,
  );
  return account.fill(
    state,
    order,
    { mint: MINT, name: "TKN", usd: 0.01, solUsd: 100, at: now },
    now,
  );
}

test("new accounts default to paper mode with the platform fee", () =>
{
  const s = account.normalize(undefined);
  assert.equal(s.preferences.paperEnabled, true);
  assert.equal(s.preferences.costs.platform, 0.01);
});

test("orders fill with Axiom's platform fee and the token tax", () =>
{
  const s = filled();
  const t = s.trades[0];
  assert.equal(s.orders[0].status, "filled");
  assert.ok(t.platformFee > 0.0099 && t.platformFee < 0.01, `platformFee=${t.platformFee}`);
  assert.ok(t.taxFee > 0.012 && t.taxFee < 0.0125, `taxFee=${t.taxFee}`);
  assert.equal(s.balance, 9);
});

test("orders from an unknown settings source are refused", () =>
{
  assert.throws(() => filled({ ...panel, source: "page" }), /Invalid native execution settings/);
});

test("a price move beyond the slippage tolerance fails the fill", () =>
{
  let s = account.normalize(undefined);
  s.preferences.executionDelayMs = 0;
  const now = Date.now();
  const { state, order } = account.begin(
    s,
    { id: "order-0002", side: "buy", mint: MINT, amount: 1, nativeSettings: panel },
    now,
  );
  assert.throws(
    () => account.fill(state, order, { mint: MINT, usd: 0.0125, solUsd: 100, at: now }, now),
    /slippage tolerance exceeded/,
  );
});

test("preferences accept a platform fee and reject an out-of-range one", () =>
{
  const p = account.normalize(undefined).preferences;
  assert.doesNotThrow(() =>
    account.validatePreferences({ ...p, costs: { ...p.costs, platform: 0.0075 } }),
  );
  assert.throws(
    () => account.validatePreferences({ ...p, costs: { ...p.costs, platform: 1 } }),
    /Invalid simulation costs/,
  );
});

test("backups round-trip and keep fee breakdowns", () =>
{
  const s = filled();
  const restored = account.restore(account.backup(s));
  assert.equal(restored.trades[0].platformFee, s.trades[0].platformFee);
  assert.equal(restored.balance, s.balance);
});
