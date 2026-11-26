// token and quote behind discover and tracker quick-buy buttons (pulse-quote.js)
// fibers follow the live discover shape: pairInfo (d1), tokenPriceUsd (d2), row (d9)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { quoteFromToken, rowToken } = require("../pulse-quote.js");

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
// a button whose fiber chain carries the given props, innermost first
const button = (...props) =>
{
  let fiber = null;
  for (let i = props.length - 1; i >= 0; i--) fiber = { memoizedProps: props[i], return: fiber };
  return { __reactFiber$x: fiber };
};

test("rowToken merges the token's props up the fiber chain and keeps the nearest price", () =>
{
  const b = button(
    { type: "button" },
    { pairInfo: { pairAddress: "P", tokenAddress: MINT, tokenDecimals: 6 } },
    { tokenPriceUsd: 0.004 },
    {
      row: {
        chain: "sol",
        tokenAddress: MINT,
        tokenTicker: "DISC",
        tokenImage: "https://x/i.webp",
        supply: 1e9,
      },
    },
    { tokenPriceUsd: 9, row: { tokenAddress: OTHER, tokenTicker: "NOPE" } },
  );
  const t = rowToken(b);
  assert.equal(t.tokenAddress, MINT);
  assert.equal(t.tokenTicker, "DISC");
  assert.equal(t.supply, 1e9);
  assert.equal(t.tokenPriceUsd, 0.004);
});

test("quoteFromToken: live USD price, else market cap over supply; no price is reported", () =>
{
  const at = Date.now();
  const q = quoteFromToken(
    { tokenAddress: MINT, tokenPriceUsd: 0.004, chain: "sol" },
    MINT,
    100,
    at,
  );
  assert.equal(q.usd, 0.004);
  assert.equal(q.solUsd, 100);
  assert.equal(q.mint, MINT);
  assert.equal(
    quoteFromToken({ tokenAddress: MINT, marketCapUsd: 50000, supply: 1e9 }, MINT, 100, at).usd,
    0.00005,
  );
  assert.throws(
    () => quoteFromToken({ tokenAddress: MINT, marketCapUsd: 50000 }, MINT, 100, at),
    /has no price/,
  );
  assert.throws(
    () => quoteFromToken({ tokenAddress: OTHER, tokenPriceUsd: 1 }, MINT, 100, at),
    /identity/,
  );
  assert.throws(
    () => quoteFromToken({ tokenAddress: MINT, tokenPriceUsd: 1, chain: "bnb" }, MINT, 100, at),
    /Solana/,
  );
});
