// network rules for paper mode, shared by the page guard and the browser-level rules: every
// write to an axiom host is blocked unless it matches an allowed pattern
(function (root)
{
  "use strict";

  // end of a path: query, fragment or end of url
  const END = "(?:[?#]|$)";

  // pattern for an axiom subdomain family
  const host = (pattern) => "^https://(?:" + pattern + ")\\.axiom\\.trade/";

  // one pattern per path on a host family (chrome rejects rule regexes over 2 kb)
  const each = (hosts, list, prefix = "") => list.map((path) => host(hosts) + prefix + path + END);

  // host families of the read-only endpoints
  const API = "api[0-9]*";
  const SOL_API = "(?:sol-)?api[0-9]*|api-sol[0-9]*";
  const CHAINS = "sol|bnb|arc|ink|hype|base|eth|rh|robinhood";
  const ORDERS = [
    `(?:${CHAINS})-orders[0-9]*`,
    "orders-v2",
    `(?:${CHAINS})-api[0-9]*`,
    "api[0-9]*|api-sol[0-9]*",
  ];
  const TRACKER = "(?:sol|arc|rh|bnb|ink|hype|base|eth|eth-v2)-api[0-9]*|api[0-9]*|api-sol[0-9]*";
  const SEARCH_SUFFIX = "(?:-v[0-9]+)?/?";

  // writes that never move funds, so axiom keeps working in paper mode
  const ALLOW = [
    // cloudflare and axiom bot checks
    "^https://(?:[a-z0-9-]+\\.)*axiom\\.trade/cdn-cgi/",
    ...[
      "buddy(?:\\.js)?",
      "challenge",
      "verify",
      "verification",
      "security",
      "fingerprint",
      "sensor",
      "telemetry",
      "server-time",
    ].map((path) => "^https://(?:[a-z0-9-]+\\.)*axiom\\.trade/wo/" + path + "(?:[/._?#-]|$)"),
    // account, balance and session reads
    ...each(API, [
      "total-account-value-v3",
      "refresh-access-token",
      "wo/sol-wallet-transfers-v2",
      "wo/token-balances-v1",
      "wo/batched-sol-balance-v3",
      "wo/batched-wallet-token-accounts-v2",
      "wo/evm-smart-accounts",
      "wo/batched-bnb-nonces-v2",
      "wo/batched-arc-nonces",
      "wo/batched-ink-nonces",
      "wo/batched-hype-nonces",
      "wo/batched-base-nonces",
      "wo/batched-eth-v2-nonces",
      "user-nonce-accounts",
      "get-streamer-alerts",
      "get-streamer-favorites",
      "bundle-key-and-wallets-v2",
      "wo/evm-balance-v2/native",
      "wo/batched-robinhood-nonces-v2",
      "wo/ph/eval-flags",
    ]),
    // token search
    ...each(
      SOL_API,
      [
        "search",
        "token-search",
        "search-tokens",
        "search-solana",
        "search-sol",
        "search-memes",
      ].map((name) => name + SEARCH_SUFFIX),
      "(?:wo/)?",
    ),
    // transaction feeds
    ...each(SOL_API, [
      "batched-transactions-from-user-v4",
      "transactions-feed-trader-info-v3",
      "batched-transactions-from-user",
      "transactions-feed-trader-info",
      "transactions-from-traders",
    ]),
    // limit order reads
    ...ORDERS.flatMap((hosts) =>
      each(hosts, [
        "get-limit-orders-v2",
        "get-limit-orders",
        "get-limit-orders-evm",
        "get-limit-order-logs",
      ]),
    ),
    // wallet renames
    ...each("sol-api[0-9]*|api[0-9]*|api-sol[0-9]*", ["batch-rename-wallets"], "(?:wo/)?"),
    // wallet tracker reads
    ...each(TRACKER, [
      "tracked-wallet-transactions",
      "tracked-wallet-transfers",
      "wallet-transfers",
      "transactions-feed",
      "transactions-feed-trader-info-v3",
    ]),
    // wallet tracker settings
    ...each(API, ["update-tracked-wallet-v3"]),
    ...each(
      TRACKER,
      [
        "add-tracked-wallet",
        "update-tracked-wallet",
        "remove-tracked-wallet",
        "remove-all-user-tracked-wallets",
        "import-tracked-wallets",
        "import-tracked-wallets-v4",
      ],
      "(?:wo/)?",
    ),
    // watchlist star and the recent pairs read (sent as post)
    ...each(
      SOL_API,
      ["toggle-watchlist-v2", "toggle-watchlist-v3", "get-recent-viewed-metadata"],
      "(?:wo/)?",
    ),
    // translation and telemetry services
    host("translate|telemetry"),
    // quote and portfolio reads sent as post
    ...each("sol-api[0-9]*", [
      "rfq-quote-routes",
      "pool-state",
      "portfolio",
      "portfolio-transactions",
    ]),
    ...each("rh-api[0-9]*", ["identities/lookup"]),
  ];

  // words that mark a trade request; the browser-level rules block these in workers and frames,
  // where a full block would also stop axiom's own background requests
  const TRADE_WORDS = [
    "swap",
    "buy",
    "sell",
    "trade",
    "order",
    "submit",
    "execute",
    "snipe",
    "transfer",
    "withdraw",
    "bridge",
    "bundle",
    "transaction",
    "/tx",
    "-tx",
    "_tx",
  ];

  // turnkey calls that sign a transaction for the real wallet
  const SIGN =
    "^https://api\\.turnkey\\.com/public/v1/submit/sign_(?:transaction|raw_payloads?)" + END;

  // solana rpc methods that broadcast a signed transaction, on any rpc host
  const BROADCAST =
    '"method"\\s*:\\s*"(?:sendTransaction|sendRawTransaction|sendBundle|sendTransactionBatch)"';

  const allow = ALLOW.map((source) => new RegExp(source));
  const sign = new RegExp(SIGN);
  const broadcast = new RegExp(BROADCAST);

  // true when a request would move real funds in paper mode
  function blocks(method, url, body = "")
  {
    if (["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase())) return false;
    if (sign.test(url.href) || broadcast.test(body)) return true;
    return /(^|\.)axiom\.trade$/.test(url.hostname) && !allow.some((rule) => rule.test(url.href));
  }

  const rules = { ALLOW, TRADE_WORDS, SIGN, BROADCAST, blocks };
  root.ScanPNLGuardRules = rules;
  if (typeof module !== "undefined") module.exports = rules;
})(globalThis);
