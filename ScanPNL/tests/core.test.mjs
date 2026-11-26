// paper trade math (core.js), run with: node --test tests/*.test.mjs
// trade(state, side, amount, quote, costs, at): buy amount is sol, sell amount is a fraction
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../core.js");
const { create, trade, tradeMany, quote, metrics, pumpTax, defaults } = core;

const MINT = "So11111111111111111111111111111111111111112";
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const at = Date.now();
const q = (usd, solUsd = 100) => ({ mint: MINT, name: "TKN", usd, solUsd, at });
const axiom = { platform: 0.01, fee: 0.0125, slip: 0, fixed: 0.002 };

test("defaults charge Axiom's 1% platform fee and a priority + bribe", () =>
{
  assert.equal(defaults.platform, 0.01);
  assert.equal(defaults.fixed, 0.002);
});

test("buy: priority+bribe, then platform fee, then token tax come out of the amount", () =>
{
  const s = trade(create(10), "buy", 1, q(0.01), axiom, at);
  const t = s.trades[0];
  const swap = 1 - 0.002,
    platformFee = swap * 0.01,
    taxFee = (swap - platformFee) * 0.0125,
    net = swap - platformFee - taxFee;
  close(s.balance, 9);
  close(t.platformFee, platformFee);
  close(t.taxFee, taxFee);
  close(t.networkFee, 0.002);
  close(t.fee, 1 - net);
  close(s.positions[MINT].qty, net / (0.01 / 100));
  close(s.positions[MINT].bought, 1);
});

test("right after a buy, PnL at the same price equals minus the fees", () =>
{
  const s = trade(create(10), "buy", 1, q(0.01), axiom, at);
  const m = metrics(s.positions[MINT], 100, s.trades);
  close(m.pnl, -s.trades[0].fee, 1e-9);
  close(m.fees, s.trades[0].fee);
  assert.ok(m.pct < -2.3 && m.pct > -2.5, `pct=${m.pct}`);
});

test("live PnL follows the price: +10% price is about +7.4% after fees", () =>
{
  const s = trade(create(10), "buy", 1, q(0.01), axiom, at);
  const p = { ...s.positions[MINT], usd: 0.011 };
  const m = metrics(p, 100, s.trades);
  close(m.holding, (s.positions[MINT].qty * 0.011) / 100);
  assert.ok(m.pct > 7.3 && m.pct < 7.5, `pct=${m.pct}`);
});

test("sell: tax and platform fee come off the proceeds, then priority + bribe", () =>
{
  const bought = trade(create(10), "buy", 1, q(0.01), axiom, at);
  const qty = bought.positions[MINT].qty;
  const s = trade(bought, "sell", 1, q(0.02), axiom, at);
  const t = s.trades[1];
  const gross = (qty * 0.02) / 100,
    taxFee = gross * 0.0125,
    platformFee = (gross - taxFee) * 0.01;
  close(t.taxFee, taxFee);
  close(t.platformFee, platformFee);
  close(t.cash, gross - taxFee - platformFee - 0.002);
  assert.equal(s.positions[MINT].qty, 0);
  close(s.positions[MINT].realized, t.cash - 1);
});

test("orders saved before the platform fee existed charge none", () =>
{
  const legacy = { fee: 0, slip: 0, fixed: 0 };
  const s = trade(create(10), "buy", 1, q(1), legacy, at);
  close(s.trades[0].fee, 0);
  close(s.trades[0].platformFee, 0);
});

test("invalid costs and stale quotes are rejected", () =>
{
  assert.throws(
    () => trade(create(10), "buy", 1, q(1), { ...axiom, platform: 1 }, at),
    /Invalid simulation costs/,
  );
  assert.throws(
    () => trade(create(10), "buy", 1, q(1), { ...axiom, platform: -0.1 }, at),
    /Invalid simulation costs/,
  );
  assert.throws(() => quote({ ...q(1), at: at - 6e3 }, at), /fresh/);
  assert.throws(() => trade(create(1), "buy", 5, q(1), axiom, at), /Insufficient paper SOL/);
  assert.throws(
    () => trade(create(10), "buy", 0.001, q(1), axiom, at),
    /smaller than the simulated fee/,
  );
});

test("tradeMany charges priority + bribe per wallet", () =>
{
  const s = tradeMany(create(10), "buy", 1, q(0.01), 3, axiom, at);
  assert.equal(s.trades.length, 3);
  close(s.balance, 7);
  close(
    s.trades.reduce((a, t) => a + t.networkFee, 0),
    0.006,
  );
});

test("pumpTax follows pump.fun's schedule", () =>
{
  assert.equal(pumpTax("Pump V1", 0), 0.0125);
  assert.equal(pumpTax("Pump AMM", 0), 0.0125);
  assert.equal(pumpTax("Pump AMM", 5000), 0.01);
  assert.equal(pumpTax("PumpSwap", 1e6), 0.003);
  assert.equal(pumpTax("Raydium CPMM", 100), null);
  assert.equal(pumpTax(undefined, 100), null);
});

test("displayNumber: zero-count subscript up to 9, then at most 3 decimals", () =>
{
  const { displayNumber } = core;
  assert.equal(displayNumber(0.0084), "0.0\u208284");
  assert.equal(displayNumber(-0.0084), "-0.0\u208284");
  assert.equal(displayNumber(1.2e-10), "0.0\u208912");
  assert.equal(displayNumber(1.2e-11), "0");
  assert.equal(displayNumber(0.0131), "0.013");
  assert.equal(displayNumber(0.52164), "0.522");
  assert.equal(displayNumber(9.5216), "9.522");
  assert.equal(displayNumber(-9.5216), "-9.522");
  assert.equal(displayNumber(1234.5678), "1,234.568");
  assert.equal(displayNumber(10), "10");
});

test("pnlPercent: whole numbers, rounded down", () =>
{
  const { pnlPercent } = core;
  assert.equal(pnlPercent(7.9), "+7%");
  assert.equal(pnlPercent(-2.63), "-3%");
  assert.equal(pnlPercent(0), "+0%");
  assert.equal(pnlPercent(-0.2), "-1%");
});

test("PnL tracker (realized) does not move with price, only when a trade fills", () =>
{
  globalThis.ScanPNLCore = core;
  const chart = require("../pnl-chart.js");
  let s = trade(create(10), "buy", 1, q(0.01), axiom, at);
  const live = { ...s, positions: { [MINT]: { ...s.positions[MINT], usd: 0.02 } } };
  assert.equal(chart.series(live, 100, "realized").value, 0);
  s = trade(s, "sell", 1, q(0.02), axiom, at + 1);
  assert.ok(chart.series(s, 100, "realized").value > 0.9);
});

test("roundTrades: a buy after a full exit starts a new round; partial sells keep the round", () =>
{
  const { roundTrades } = core;
  let s = trade(create(10), "buy", 1, q(0.01), axiom, at);
  s = trade(s, "sell", 0.5, q(0.01), axiom, at + 1);
  assert.equal(roundTrades(s.trades, MINT).length, 2, "partial sell: same round");
  s = trade(s, "sell", 1, q(0.01), axiom, at + 2);
  assert.equal(roundTrades(s.trades, MINT).length, 3, "closed: last round kept until the next buy");
  s = trade(s, "buy", 0.5, q(0.02), axiom, at + 3);
  const r = roundTrades(s.trades, MINT);
  assert.equal(r.length, 1);
  assert.equal(r[0].at, at + 3);
  assert.equal(roundTrades(s.trades, "other").length, 0);
});

test("PnL tracker (cash flow): a buy takes its SOL off at once, price ticks don't move it, a sell adds back", () =>
{
  globalThis.ScanPNLCore = core;
  const chart = require("../pnl-chart.js");
  let s = trade(create(10), "buy", 1, q(0.01), axiom, at);
  assert.equal(chart.series(s, 100, "flow").value, -1);
  const live = { ...s, positions: { [MINT]: { ...s.positions[MINT], usd: 0.02 } } };
  assert.equal(chart.series(live, 100, "flow").value, -1);
  s = trade(s, "sell", 1, q(0.02), axiom, at + 1);
  close(chart.series(s, 100, "flow").value, s.trades[1].cash - 1, 1e-12);
  close(chart.series(s, 100, "flow").value, chart.series(s, 100, "realized").value, 1e-9);
});

test("displayNumber digits: 1 after the subscript in the instant panel, 2 in the PnL tracker", () =>
{
  const { displayNumber } = core;
  assert.equal(displayNumber(0.0015, 1), "0.0\u20822");
  assert.equal(displayNumber(0.0015), "0.0\u208215");
  assert.equal(displayNumber(-0.0084, 1), "-0.0\u20828");
  assert.equal(displayNumber(0.0096, 1), "0.01"); // rounding carried to 0.01: normal number
  assert.equal(displayNumber(1.2e-10, 1), "0.0\u20891");
  assert.equal(displayNumber(0.0131, 1), "0.013");
});
