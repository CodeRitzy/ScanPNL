// paper-mode network rules (guard-rules.js)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rules = require("../guard-rules.js");
const blocks = (method, href, body) => rules.blocks(method, new URL(href), body);

test("write requests to Axiom are denied by default", () =>
{
  for (const href of [
    "https://api3.axiom.trade/swap",
    "https://tx-pro.axiom.trade/send",
    "https://axiom.trade/api/buy",
    "https://sol-api2.axiom.trade/pool-state-x",
  ])
  {
    assert.equal(blocks("POST", href), true, href);
  }
});

test("read-only Axiom endpoints stay allowed", () =>
{
  for (const href of [
    "https://api6.axiom.trade/refresh-access-token",
    "https://sol-api.axiom.trade/pool-state?x=1",
    "https://api-sol2.axiom.trade/wo/search-v3",
    "https://axiom.trade/cdn-cgi/challenge-platform/x",
    "https://telemetry.axiom.trade/anything",
    "https://sol-api.axiom.trade/toggle-watchlist-v2",
    "https://api6.axiom.trade/toggle-watchlist-v3",
    "https://sol-api2.axiom.trade/get-recent-viewed-metadata",
  ])
  {
    assert.equal(blocks("POST", href), false, href);
  }
  assert.equal(blocks("GET", "https://api3.axiom.trade/swap"), false);
});

test("transaction broadcasts are blocked on any RPC host", () =>
{
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["x"] });
  assert.equal(blocks("POST", "https://mainnet.helius-rpc.com/?api-key=x", body), true);
  assert.equal(
    blocks(
      "POST",
      "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
      '{"method": "sendBundle"}',
    ),
    true,
  );
  assert.equal(blocks("POST", "https://mainnet.helius-rpc.com/", '{"method":"getBalance"}'), false);
});

test("Turnkey signing is blocked, Turnkey login is not", () =>
{
  assert.equal(blocks("POST", "https://api.turnkey.com/public/v1/submit/sign_transaction"), true);
  assert.equal(blocks("POST", "https://api.turnkey.com/public/v1/submit/sign_raw_payloads"), true);
  assert.equal(blocks("POST", "https://api.turnkey.com/public/v1/submit/stamp_login"), false);
});

test("patterns stay RE2-compatible for declarativeNetRequest", () =>
{
  for (const source of rules.ALLOW) assert.doesNotMatch(source, /\(\?[=!<]/, source);
});
