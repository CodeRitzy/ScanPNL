// sell sizing and which axiom controls the paper account handles
(function (root)
{
  "use strict";

  // true for axiom's "sell init" button text
  function sellInitial(text)
  {
    return /^sell\s*init(?:ial|ials|ial\s+investment)?\.?$/i.test(String(text).trim());
  }

  // true for trade buttons the paper account must intercept even when it cannot fill them
  function unsupported(text)
  {
    return (
      (/^(?:quick\s*)?(?:buy|sell)\b/i.test(text) && !/^buy\s+delay\b/i.test(text)) ||
      /^(?:follow sell|optimize dust|close all|sell all|snipe|withdraw|deposit|bridge to solana)\b/i.test(
        text,
      )
    );
  }

  // fraction of a position to sell so the proceeds cover what is still invested
  function initialFraction(position, token, costs, wallets)
  {
    if (!position || !(position.qty > 0)) throw Error("No paper position to sell");
    const invested = Math.max(0, position.bought - position.sold);
    if (!invested) throw Error("Initial investment is already recovered");
    const proceeds =
      ((position.qty * token.usd) / token.solUsd) *
      (1 - costs.slip) *
      (1 - costs.fee) *
      (1 - (costs.platform ?? 0));
    if (!(proceeds > 0)) throw Error("Fresh price unavailable");
    return Math.min(1, (invested + costs.fixed * wallets) / proceeds);
  }

  // fraction of a position worth the given amount of sol
  function solFraction(position, token, sol)
  {
    if (!position || !(position.qty > 0)) throw Error("No paper position to sell");
    const value = (position.qty * token.usd) / token.solUsd;
    if (!(value > 0) || !Number.isFinite(value) || !(sol > 0))
    {
      throw Error("Fresh price unavailable");
    }
    if (sol > value * (1 + 1e-9)) throw Error("Sell amount exceeds paper holding");
    return Math.min(1, sol / value);
  }

  // fraction a sell preview stands for: a sol amount or a percent
  function previewFraction(amount, unit, value)
  {
    if (!Number.isFinite(amount) || amount < 0) return 0;
    if (unit === "SOL") return value > 0 ? Math.min(1, amount / value) : 0;
    return Math.min(1, amount);
  }

  const api = { sellInitial, unsupported, initialFraction, solFraction, previewFraction };
  root.ScanPNLSafety = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
