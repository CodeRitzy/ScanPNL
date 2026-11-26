// reads token quotes from axiom's pulse cards and quick-buy rows (runs in the page)
(() =>
{
  "use strict";

  const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // quote from a pulse row: market cap in sol over supply
  function quoteFromRow(row, mint, solUsd, now = Date.now())
  {
    if (!row || row.tokenAddress !== mint || !(solUsd > 0))
    {
      throw Error("Native Pulse identity or SOL price unavailable");
    }
    const supply = Number(row.supply);
    const marketCap = Number(row.marketCap);
    if (!Number.isFinite(supply) || supply <= 0 || !Number.isFinite(marketCap) || marketCap <= 0)
    {
      throw Error("Native Pulse snapshot is incomplete");
    }
    return {
      mint,
      name: row.tokenTicker || row.tokenName || mint.slice(0, 6),
      image: row.tokenImage,
      supply,
      usd: (marketCap * solUsd) / supply,
      solUsd,
      at: now,
      source: "axiom-pulse",
      pairAddress: row.pairAddress,
      protocol: row.protocol,
      url: "/token/" + mint + "?chain=sol",
    };
  }

  // quote from discover or tracker row data: live usd price, else usd market cap over supply
  function quoteFromToken(token, mint, solUsd, now = Date.now())
  {
    if (!token || token.tokenAddress !== mint || !(solUsd > 0))
    {
      throw Error("Native row identity or SOL price unavailable");
    }
    if (token.chain && !/^sol/.test(token.chain))
    {
      throw Error("Only Solana paper quick buys are supported");
    }
    const supply = Number(token.supply);
    const usd =
      Number(token.tokenPriceUsd) ||
      Number(token.priceUsd) ||
      (supply > 0 ? Number(token.marketCapUsd) / supply : 0);
    if (!(usd > 0)) throw Error("Native row has no price");
    return {
      mint,
      name: token.tokenTicker || token.tokenName || mint.slice(0, 6),
      image: token.tokenImage,
      supply: supply > 0 ? supply : undefined,
      usd,
      solUsd,
      at: now,
      source: "axiom-row",
      pairAddress: token.pairAddress,
      protocol: token.protocol,
      url: "/token/" + mint + "?chain=sol",
    };
  }

  // token data behind a quick-buy button, merged from every react props object up its tree
  // that names the same token; also notes whether axiom would open the token after buying
  function rowToken(element)
  {
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber"));
    let fiber = key && element[key];
    let token;
    let price;
    let redirect = false;
    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return)
    {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== "object") continue;
      if (price === undefined && Number(props.tokenPriceUsd) > 0)
      {
        price = Number(props.tokenPriceUsd);
      }
      if (props.isPulse === true || props.shouldRedirect === true) redirect = true;
      for (const value of [props, ...Object.values(props)])
      {
        if (
          !value ||
          typeof value !== "object" ||
          !MINT.test(value.tokenAddress || "") ||
          (token && value.tokenAddress !== token.tokenAddress)
        )
        {
          continue;
        }
        token = { ...value, ...token };
      }
    }
    if (token && price && !(Number(token.tokenPriceUsd) > 0)) token.tokenPriceUsd = price;
    if (token) token.quickRedirect = redirect;
    return token;
  }

  if (typeof module !== "undefined") module.exports = { quoteFromRow, quoteFromToken, rowToken };
  if (typeof window === "undefined") return;

  // last sol price sent by the page scripts
  let broadcastSolUsd;

  // sol price from axiom's footer ("$70.27" next to the sol icon), else the last broadcast
  const solPrice = () =>
    Number(
      [...document.querySelectorAll('img[alt="SOL"]')]
        .map((image) => image.closest("button"))
        .find((button) => /^\s*\$[\d,.]+\s*$/.test(button?.textContent || ""))
        ?.textContent.replace(/[$,\s]/g, ""),
    ) || broadcastSolUsd;

  // quote for a mint from its pulse card, or from the quick-buy button marked for it
  function snapshot(mint)
  {
    const card = [...document.querySelectorAll("[data-pulse-token-address]")].find(
      (element) =>
        element.getAttribute("data-pulse-token-address") === mint &&
        element.closest("[data-pulse-chain]")?.getAttribute("data-pulse-chain") === "sol",
    );
    if (document.visibilityState !== "visible" || !navigator.onLine)
    {
      throw Error("Native Pulse row unavailable");
    }
    if (!card)
    {
      // mint is a checked base58 address, safe inside the selector
      const button = document.querySelector(`[data-scanpnl-quick-mint="${mint}"]`);
      if (!button) throw Error("Native Pulse row unavailable");
      return quoteFromToken(rowToken(button), mint, solPrice());
    }

    // search the card's react tree for the row data of this mint; the first objects naming the
    // token are display props without numbers, so keep looking until a row has supply and market cap
    const root = card[Object.keys(card).find((name) => name.startsWith("__reactFiber"))];
    const stack = [root];
    let visited = 0;
    let incomplete = false;
    while (stack.length && visited++ < 450)
    {
      const fiber = stack.pop();
      if (!fiber) continue;
      if (fiber !== root && fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
      const candidates = [
        fiber.memoizedProps,
        fiber.memoizedProps?.row,
        fiber.memoizedProps?.token,
        fiber.memoizedProps?.data,
      ];
      for (let state = fiber.memoizedState, count = 0; state && count++ < 40; state = state.next)
      {
        candidates.push(state.memoizedState?.current?.row, state.memoizedState?.row);
      }
      for (const row of candidates)
      {
        if (row?.tokenAddress !== mint) continue;
        if (Number(row.supply) > 0 && Number(row.marketCap) > 0)
        {
          return quoteFromRow(row, mint, solPrice());
        }
        incomplete = true;
      }
    }
    throw Error(
      incomplete ? "Native Pulse snapshot is incomplete" : "Native Pulse snapshot not ready",
    );
  }

  // replies with the token a marked quick-buy button buys
  function replyTarget(id)
  {
    const button = document.querySelector(`[data-scanpnl-quick-target="${id}"]`);
    const token = button && rowToken(button);
    window.postMessage(
      {
        type: "scanpnl-quick-target-response-v1",
        id,
        token: token && {
          mint: token.tokenAddress,
          name: token.tokenTicker || token.tokenName,
          image: token.tokenImage,
          chain: token.chain,
          redirect: token.quickRedirect,
        },
      },
      location.origin,
    );
  }

  // handles requests from the content script: sol price, quotes, quick-buy targets, opening a token
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.type === "scanpnl-sol-price-v1")
    {
      if (data.usd > 0) broadcastSolUsd = data.usd;
    }
    else if (data?.type === "scanpnl-pulse-quote-request-v1")
    {
      if (typeof data.id !== "string" || !MINT.test(data.mint || "")) return;
      try
      {
        window.postMessage(
          { type: "scanpnl-pulse-quote-response-v1", id: data.id, quote: snapshot(data.mint) },
          location.origin,
        );
      }
      catch (error)
      {
        window.postMessage(
          { type: "scanpnl-pulse-quote-response-v1", id: data.id, error: error.message },
          location.origin,
        );
      }
    }
    else if (data?.type === "scanpnl-quick-target-request-v1")
    {
      if (/^[0-9a-f-]{36}$/.test(data.id || "")) replyTarget(data.id);
    }
    else if (data?.type === "scanpnl-open-token-v1")
    {
      // opens the token page in-app (no reload), as axiom does after its own quick buy
      if (!MINT.test(data.mint || "")) return;
      history.pushState({}, "", "/token/" + data.mint + "?chain=sol");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }
  });
})();
