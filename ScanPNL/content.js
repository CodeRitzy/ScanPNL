// the page side of paper trading on axiom: shows the paper account in axiom's own interface and
// turns axiom's trade controls into paper orders
(() =>
{
  "use strict";

  // the account as the background last sent it, and orders in progress
  let account;
  let executing = false;
  let executingCount = 0;
  let lastMarkAt = 0;
  let chartKey = "";

  // the open token's latest price from axiom's page, and the pending render
  let nativeQuote;
  let renderScheduled = false;

  // paper copies: axiom element -> copy (weak, and iterable for cleanup), copy -> axiom element
  const clones = new WeakMap();
  const clonePairs = new Map();
  const originals = new WeakMap();

  // live prices sent to the background in batches, and the mints the page script streams
  const pendingMarks = new Map();
  let marksTimer;
  let subscribedKey = "";

  // quick buys in progress, and streamed prices for tokens that are not open
  const quickBuys = new Map();
  const streamPrices = new Map();
  let streamSolUsd;

  // the open share card's token, and click timing
  let shareMint;
  let positionsClickUntil = 0;
  let resetArmedUntil = 0;

  // pnl currency, the last pnl history sample and the positions table found last render
  let currencyMode = "SOL";
  let lastSampleAt = 0;
  let positionsScroll;

  // lookups cached during one render, and the paper mode last sent to the page scripts
  let renderCache;
  let publishedMode;

  // a click on a paper position pauses the positions table re-render for a second
  document.addEventListener(
    "pointerdown",
    (event) =>
    {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-scanpnl-mint],.scanpnl-position")
      )
      {
        positionsClickUntil = Date.now() + 1000;
      }
    },
    true,
  );

  // axiom elements that are children of an element (paper copies left out)
  const children = (element) =>
    element
      ? [...element.children].filter((child) => !child.hasAttribute("data-scanpnl-owned"))
      : [];
  // a selector limited to axiom elements; splits on commas, so no selector here may contain one inside [attr="..."]
  const unowned = (selector) =>
    selector
      .split(",")
      .map((part) => `${part}:not([data-scanpnl-owned]):not([data-scanpnl-owned] *)`)
      .join(",");
  // axiom elements matching a selector, cached for the duration of one render
  const native = (selector) =>
  {
    let elements = renderCache?.get(selector);
    if (!elements)
    {
      elements = [...document.querySelectorAll(unowned(selector))];
      renderCache?.set(selector, elements);
    }
    return elements.filter((element) => element.isConnected);
  };

  // true for an element inside a fixed card (the pnl tracker), not inside a dialog or banner
  function accountPnlTarget(element)
  {
    if (
      element.closest(
        '.global-modal-overlay,[role="dialog"],[class*="bg-scannerModalBackground"],[class*="group/banner"]',
      )
    )
    {
      return false;
    }
    for (let node = element; node && node !== document.body; node = node.parentElement)
    {
      if (node.classList.contains("fixed")) return true;
    }
    return false;
  }

  // label texts the page reads; leaves() indexes only these
  const LABELS = new Set(["Tax %", "Total Value", "Bought", "Balance", "PNL"]);
  // childless axiom spans by label text, indexed once per render
  const leaves = (label) =>
  {
    let byLabel = renderCache?.get(" leaves");
    if (!byLabel)
    {
      byLabel = new Map();
      for (const span of document.getElementsByTagName("span"))
      {
        if (span.firstElementChild) continue;
        const text = span.textContent;
        if (text.length > 24) continue;
        const trimmed = text.trim();
        if (!LABELS.has(trimmed) || span.closest("[data-scanpnl-owned]")) continue;
        byLabel.has(trimmed) ? byLabel.get(trimmed).push(span) : byLabel.set(trimmed, [span]);
      }
      renderCache?.set(" leaves", byLabel);
    }
    return (byLabel.get(label) || []).filter((span) => span.isConnected);
  };

  // the first axiom span with a label text
  const leaf = (label) => leaves(label)[0];
  // axiom-formatted numbers: cache, values waiting to be formatted, and the batch timer
  let formatAllowedAt = 0;
  const nativeFormats = new Map(),
    pendingFormats = new Set();
  let formatTimer;
  // formats a number; `digits` is the significant digits shown after the zero-count subscript
  function fmt(value, digits)
  {
    if (value == null || !Number.isFinite(Number(value))) return "\u2064";
    return ScanPNLCore.displayNumber(Number(value), digits);
  }

  // a balance as axiom shows it: large values use axiom's own compact format once it arrives
  function walletBalance(value, digits)
  {
    if (!Number.isFinite(value) || Math.abs(value) < 1000) return fmt(value, digits);
    if (nativeFormats.has(value)) return nativeFormats.get(value);
    if (Date.now() >= formatAllowedAt)
    {
      pendingFormats.add(value);
      if (!formatTimer)
      {
        formatTimer = setTimeout(() =>
        {
          formatTimer = undefined;
          formatAllowedAt = Date.now() + 1000;
          window.postMessage(
            {
              type: "scanpnl-format-v1",
              values: [...pendingFormats].slice(0, 200),
            },
            location.origin,
          );
          pendingFormats.clear();
        }, 0);
      }
    }
    return compact(value);
  }

  // a number with its sign
  const signed = (value) => (value >= 0 ? "+" : "") + fmt(value);
  // a number shortened with K, M or B
  function compact(value, digits)
  {
    const number = Number(value),
      size = Math.abs(number);
    if (value == null || !Number.isFinite(number)) return "\u2064";
    for (const [threshold, suffix] of [
      [1e9, "B"],
      [1e6, "M"],
      [1000, "K"],
    ])
    {
      if (size >= threshold) return Number((number / threshold).toFixed(2)).toString() + suffix;
    }
    return fmt(number, digits);
  }

  // writes a value into an element, turning subscript digits into <sub> elements
  function formatted(element, text, matchTypography = true)
  {
    if (!element) return;
    if (matchTypography) syncNumberTypography(element);
    if (String(text).includes("\u2064")) return;
    text = String(text).replace(/\u2063/g, "");
    if (
      element.dataset.scanpnlText === text &&
      element.textContent ===
        text.replace(/[\u2080-\u2089]/g, (digit) =>
          "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089".indexOf(digit),
        )
    )
    {
      return;
    }
    element.dataset.scanpnlText = text;
    element.dataset.scanpnlFormatted = "true";
    const parts = String(text).split(/([\u2080-\u2089]+)/);
    element.replaceChildren(
      ...parts.filter(Boolean).map((part) =>
      {
        if (!/^[\u2080-\u2089]+$/.test(part)) return document.createTextNode(part);
        const sub = document.createElement("sub");
        sub.textContent = [...part]
          .map((digit) =>
            "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089".indexOf(digit),
          )
          .join("");
        return sub;
      }),
    );
  }

  // number spans inside a copied wallet row (outermost span whose text is a number)
  function valueSpans(row)
  {
    const value = (span) =>
      !span.querySelector("img,svg,i,div,button") && /^[0-9.,]+$/.test(span.textContent.trim());
    return [...row.querySelectorAll("span")].filter(
      (span) =>
        value(span) && !(span.parentElement?.tagName === "SPAN" && value(span.parentElement)),
    );
  }

  // the four bought / sold / holding / pnl columns of a stats row
  function metricColumns(row)
  {
    const columns = children(row).filter((column) => /[0-9]/.test(column.textContent));
    return columns.length === 4 ? columns : [];
  }

  // the paper position of the open token page
  function activePaperPosition(quote)
  {
    if (quote?.mint && account.positions[quote.mint]) return account.positions[quote.mint];
    const path = location.pathname,
      routeId = path.split("/")[2];
    return Object.values(account.positions).find(
      (position) =>
        position.mint === routeId ||
        position.pairAddress === routeId ||
        position.url?.split("?")[0] === path,
    );
  }

  // fills the bought / sold / holding / pnl cells in sol or usd
  function metricCells(cells, stats, solUsd, joinPercent = false)
  {
    if (cells.length !== 4 || !stats) return;
    const usd = currencyMode === "USD";
    if (usd && !(solUsd > 0)) return;
    [stats.bought, stats.sold, stats.holding, stats.pnl].forEach((value, index) =>
    {
      const field = ["bought", "sold", "holding", "pnl"][index];
      const amount = usd && stats.usd ? stats.usd[field] : value * (usd ? solUsd : 1);
      const text =
        (index === 3 ? (amount >= 0 ? "+" : "-") : "") +
        (usd ? "$" : "") +
        (usd ? compact : walletBalance)(Math.abs(amount), 1);
      const suffix =
        index === 3 ? ` (${percent(usd && stats.usd ? stats.usd.pct : stats.pct)}%)` : "";
      numeric(cells[index], text, suffix, joinPercent);
      const cell = cells[index],
        valueSpan = cell?.querySelector("[data-scanpnl-formatted]");
      if (cell && valueSpan && !usd && !cell.querySelector('img[alt="SOL"],img[alt="Solana"]'))
      {
        const solIcon = native('img[alt="SOL"],img[alt="Solana"]')[0];
        if (solIcon)
        {
          const icon = solIcon.cloneNode(false);
          icon.removeAttribute("data-scanpnl-hidden");
          icon.dataset.scanpnlOwned = "true";
          icon.style.cssText =
            "width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:2px";
          valueSpan.before(icon);
        }
      }
      if (cell)
      {
        for (const image of cell.querySelectorAll('img[alt="SOL"],img[alt="Solana"]'))
        {
          if (image.dataset.scanpnlHidden === undefined)
          {
            if (usd) image.style.display = "none";
            else if (image.style.display === "none") image.style.removeProperty("display");
          }
        }
      }
      if (cells[index])
      {
        cells[index].dataset.scanpnlAction = "currency";
        cells[index].role = "button";
        cells[index].tabIndex = 0;
        cells[index].style.cursor = "pointer";
        cells[index].setAttribute("aria-label", `Show values in ${usd ? "SOL" : "USD"}`);
      }
    });
    tone(cells[3], stats.pnl);
    if (cells[3]) cells[3].dataset.scanpnlPnl = String(stats.pnl);
  }

  // a pnl percent as a whole number rounded down, without the "%"
  const percent = (value) => ScanPNLCore.pnlPercent(value).slice(0, -1);
  // when each copy last took its font settings
  const typographyCache = new WeakMap();
  // copies the font settings of an axiom element onto its paper copy (at most once a second)
  function typography(source, target)
  {
    const now = Date.now(),
      last = typographyCache.get(target);
    if (last?.source === source && now - last.at < 1000) return;
    typographyCache.set(target, {
      source,
      at: now,
    });
    const style = getComputedStyle(source);
    for (const property of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "fontStretch",
      "lineHeight",
      "letterSpacing",
      "wordSpacing",
      "fontVariant",
      "fontVariantNumeric",
      "fontFeatureSettings",
      "fontVariationSettings",
      "fontKerning",
      "fontOpticalSizing",
      "fontSynthesis",
      "textRendering",
      "webkitFontSmoothing",
      "textTransform",
    ])
    {
      target.style[property] = style[property];
    }
  }

  // matches a paper number's font to the number it replaces
  function syncNumberTypography(element)
  {
    const original = originals.get(element);
    if (!original?.isConnected) return;
    const numberSpan = [...original.querySelectorAll("span")].find(
      (span) =>
        !span.closest("sub,[data-scanpnl-owned]") &&
        !span.querySelector("span,img,svg") &&
        /[0-9]/.test(span.textContent),
    );
    typography(numberSpan || original, element);
  }

  // axiom's green or red for a pnl value
  function pnlColor(value)
  {
    const variable = value < 0 ? "--decrease" : "--increase";
    return (
      "rgb(" +
      (getComputedStyle(document.documentElement).getPropertyValue(variable).trim() ||
        (value < 0 ? "236 57 122" : "68 248 236")) +
      ")"
    );
  }

  // colors an element and its text by a pnl value
  function tone(element, value)
  {
    if (!element) return;
    const color = pnlColor(value);
    element.dataset.scanpnlPnlSign = value < 0 ? "negative" : "positive";
    for (const node of [element, ...element.querySelectorAll("span,sub")])
    {
      node.style.setProperty("color", color, "important");
      node.style.whiteSpace = "nowrap";
    }
  }

  // shows a message in axiom's own toast
  function notice(text)
  {
    window.postMessage(
      {
        type: "scanpnl-notice-v1",
        message: String(text),
      },
      location.origin,
    );
  }

  // hides an axiom element and shows a paper copy in its place (reused while it is on the page)
  function clone(original)
  {
    if (!original) return null;
    let copy = clones.get(original);
    if (!copy?.isConnected)
    {
      copy = original.cloneNode(true);
      copy.removeAttribute("data-scanpnl-hidden");
      copy.querySelectorAll("[data-scanpnl-owned]").forEach((owned) => owned.remove());
      copy
        .querySelectorAll("[data-scanpnl-hidden]")
        .forEach((hidden) => hidden.removeAttribute("data-scanpnl-hidden"));
      copy.dataset.scanpnlOwned = "true";
      copy.querySelectorAll("[id]").forEach((withId) => withId.removeAttribute("id"));
      const sources = [original, ...original.querySelectorAll("*")].filter(
        (element) => !element.closest("[data-scanpnl-owned]"),
      );
      const targets = [copy, ...copy.querySelectorAll("*")];
      sources.forEach((source, index) =>
      {
        if (source instanceof HTMLElement && targets[index] instanceof HTMLElement)
        {
          originals.set(targets[index], source);
          typography(source, targets[index]);
        }
      });
      original.setAttribute("data-scanpnl-hidden", "");
      original.after(copy);
      clones.set(original, copy);
      clonePairs.set(original, copy);
    }
    if (!original.hasAttribute("data-scanpnl-hidden"))
    {
      original.setAttribute("data-scanpnl-hidden", "");
    }
    return copy;
  }

  // writes a value and its percent together on one line in axiom's instant-trade pnl cell
  function instantPnl(container, valueSpan, value, percentText)
  {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const texts = [];
    let fullText = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode())
    {
      texts.push({
        node,
        start: fullText.length,
        end: fullText.length + node.data.length,
      });
      fullText += node.data;
    }
    const percents = [...fullText.matchAll(/\(\s*([+\u2212-]?\s*\d[\d.,]*)\s*%\s*\)/g)];
    const valueText = valueSpan.textContent;
    const valueNode = texts.find((text) => valueSpan.contains(text.node));
    if (!valueNode) return;
    // value and percent go into the value's own text so they stay on one line; axiom's separate
    // percent text is blanked and hidden
    const edits = percents.map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      text: "",
    }));
    const valueEnd =
      percents.length && percents[0].index > valueNode.start
        ? Math.min(valueNode.start + valueText.length, percents[0].index)
        : valueNode.start + valueText.length;
    const valueRun = fullText.slice(valueNode.start, valueEnd);
    // the gap after the value stays only when the percent is not right after it, so repeated renders
    // never pile up spaces
    const gap =
      percents.length && percents[0].index === valueEnd ? "" : valueRun.match(/\s+$/)?.[0] || "";
    edits.push({
      start: valueNode.start,
      end: valueEnd,
      text: value + percentText + gap,
    });
    for (const edit of edits.sort((first, second) => second.start - first.start))
    {
      if (fullText.slice(edit.start, edit.end) === edit.text) continue;
      let replacement = edit.text;
      for (const text of texts)
      {
        if (text.end <= edit.start || text.start >= edit.end) continue;
        const from = Math.max(0, edit.start - text.start),
          to = Math.min(text.end, edit.end) - text.start;
        text.node.replaceData(from, to - from, replacement);
        replacement = "";
      }
    }

    // hides elements the blanked percent left empty (icon wrappers stay)
    for (const text of texts)
    {
      if (
        percents.some(
          (match) => text.start < match.index + match[0].length && text.end > match.index,
        )
      )
      {
        const parent = text.node.parentElement;
        if (
          parent &&
          parent !== container &&
          container.contains(parent) &&
          !parent.textContent.trim() &&
          !parent.querySelector("img,svg")
        )
        {
          parent.style.display = "none";
        }
      }
    }
  }

  // writes a value into the number span of a cell
  function numeric(cell, value, suffix, joinPercent)
  {
    if (!cell) return;
    const spans = [...cell.querySelectorAll("span")].filter(
      (span) =>
        !span.querySelector("img,svg") && /^[+\u2212\-$\s]*\d/.test(span.textContent.trim()),
    );
    if (!spans.length) return;
    const target = spans.find((span) => !span.querySelector("span")) || spans[0];
    const original = originals.get(target);
    if (original?.isConnected) typography(original, target);
    if (joinPercent && suffix) instantPnl(cell, target, value, suffix);
    else formatted(target, value + suffix, false);
    target.style.whiteSpace = "nowrap";
  }

  // the open token's quote: axiom's live price when it has one, otherwise just its identity
  function getQuote(fresh = false)
  {
    if (!ScanPNLCore.tokenRoute(location.pathname)) throw Error("Open an Axiom token page");
    const chain = new URLSearchParams(location.search).get("chain");
    if (chain && chain !== "sol") throw Error("Paper trading supports Solana only");
    if (nativeQuote && nativeQuote.url.split("?")[0] === location.pathname)
    {
      const quote = {
        ...nativeQuote,
        url: location.pathname + location.search,
      };
      if (fresh)
      {
        const known = account?.positions[quote.mint] || account?.currentQuote;
        if (known?.at > quote.at)
        {
          Object.assign(quote, {
            usd: known.usd,
            solUsd: known.solUsd,
            at: known.at,
          });
        }
        ScanPNLCore.quote(quote);
      }
      return quote;
    }
    const solButton = native('img[alt="SOL"]')
      .map((image) => image.closest("button"))
      .find((button) => button && /^\s*\$[\d,.]+\s*$/.test(button.textContent));
    const solUsd = ScanPNLCore.priceText(solButton?.textContent || "");
    const solscan = native('a[href*="solscan.io/token/"]')[0];
    const mint = solscan?.href.match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
    const buyButton = native("button").find(
      (button) =>
        /^Buy\s+\S/.test(button.textContent.trim()) &&
        !/^Buy delay/.test(button.textContent.trim()),
    );
    const panelName = native(".buy-click-container span")
      .find(
        (span) => span.className.includes("max-w-[68px]") && span.classList.contains("truncate"),
      )
      ?.textContent.trim();
    const name =
      panelName ||
      account?.positions[mint]?.name ||
      buyButton?.textContent.trim().replace(/^Buy\s+/, "") ||
      mint?.slice(0, 6);
    const identity = {
      mint,
      name,
      usd: NaN,
      solUsd,
      at: 0,
      source: "identity-only",
      url: location.pathname + location.search,
    };
    if (fresh) ScanPNLCore.quote(identity);
    return identity;
  }

  // takes a new account state from the background, keeping fresher prices already shown
  function adoptState(next)
  {
    if (!next) return account;
    const previous = account;
    if (previous?.accountId && next.accountId !== previous.accountId)
    {
      shareMint = undefined;
      chartKey = "";
      window.postMessage(
        {
          type: "scanpnl-account-changed-v1",
        },
        location.origin,
      );
    }
    if (previous?.accountId === next.accountId)
    {
      if (
        (previous.updatedAt || 0) > (next.updatedAt || 0) ||
        ((previous.updatedAt || 0) === (next.updatedAt || 0) &&
          previous.trades.length > next.trades.length)
      )
      {
        return account;
      }
      for (const position of Object.values(next.positions))
      {
        const known = previous.positions[position.mint];
        if (!known) continue;
        if (
          (known.at > (position.at || 0) ||
            !Number.isFinite(position.usd) ||
            position.usd <= 0 ||
            !Number.isFinite(position.solUsd) ||
            position.solUsd <= 0) &&
          known.usd > 0 &&
          known.solUsd > 0
        )
        {
          Object.assign(position, {
            usd: known.usd,
            solUsd: known.solUsd,
            at: known.at,
            quoteSource: known.quoteSource,
            quoteStatus: Date.now() - known.at > 60000 ? "stale" : "fresh",
          });
        }
        if (!position.image && known.image) position.image = known.image;
      }
    }
    account = next;
    return account;
  }

  // the freshest price for the open token from the page, the account and the position
  function displayQuote(quote)
  {
    const onToken = ScanPNLCore.tokenRoute(location.pathname);
    if (!onToken) return quote;
    const position =
      account?.positions[quote?.mint] ||
      Object.values(account?.positions || {}).find(
        (item) =>
          item.mint === location.pathname.split("/")[2] ||
          item.url?.split("?")[0] === location.pathname,
      );
    const mint = position?.mint || quote?.mint;
    const candidates = [quote, account?.currentQuote, position]
      .filter(
        (item) =>
          item &&
          item.mint === mint &&
          Number.isFinite(item.usd) &&
          item.usd > 0 &&
          Number.isFinite(item.solUsd) &&
          item.solUsd > 0 &&
          Number.isFinite(item.at || 0) &&
          (item.at || 0) <= Date.now() + 1000,
      )
      .sort((first, second) => (second.at || 0) - (first.at || 0));
    const chartQuote = candidates.find(
      (item) => (item.source || item.quoteSource) === "axiom-chart" && Date.now() - item.at < 5000,
    );
    const best = chartQuote || candidates[0];
    if (!best) return quote;
    return {
      source: best.source || best.quoteSource,
      mint,
      name: position?.name || quote?.name || best.name,
      usd: best.usd,
      solUsd: best.solUsd,
      at: best.at || 0,
      supply: best.supply || position?.supply || quote?.supply,
      protocol: best.protocol || position?.protocol || quote?.protocol,
      image: best.image || position?.image || quote?.image,
      url: location.pathname + location.search,
    };
  }

  // sends a request to the background and adopts the account it returns
  async function send(request)
  {
    const reply = await chrome.runtime.sendMessage(request);
    if (reply.error) throw Error(reply.error);
    adoptState(reply.state);
    return account;
  }

  // sends a request to the page scripts and waits for the reply with the same id (undefined after the timeout)
  function askPage(name, data, timeout, id = crypto.randomUUID())
  {
    return new Promise((resolve) =>
    {
      const timer = setTimeout(() => finish(), timeout);

      // stops listening and hands back the reply
      function finish(reply)
      {
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(reply);
      }

      // the reply from this page, with this request's id
      function listener(event)
      {
        if (
          event.source === window &&
          event.origin === location.origin &&
          event.data?.type === name + "-response-v1" &&
          event.data.id === id
        )
        {
          finish(event.data);
        }
      }

      window.addEventListener("message", listener);
      window.postMessage({ type: name + "-request-v1", id, ...data }, location.origin);
    });
  }

  // asks the page script for a quote read from axiom's row data
  async function pulseSnapshot(mint)
  {
    const reply = await askPage("scanpnl-pulse-quote", { mint }, 500);
    if (!reply) throw Error("Native snapshot unavailable");
    if (!reply.quote) throw Error(reply.error);
    return reply.quote;
  }

  // a fill price for a quick-bought token: row data, then live stream ticks, then market data
  async function pulseExecutionQuote(mint)
  {
    let noPrice = false;
    try
    {
      const snapshot = await pulseSnapshot(mint);
      ScanPNLCore.quote(snapshot);
      return snapshot;
    }
    catch (error)
    {
      // a row without a price (e.g. a wallet-tracker trade) goes straight to the market quote
      noPrice = /has no price/.test(error.message);
    }
    const deadline = noPrice ? 0 : Date.now() + 5000;
    let nextTry = 0;
    while (Date.now() < deadline)
    {
      if (Date.now() >= nextTry)
      {
        nextTry = Date.now() + 150;
        try
        {
          const snapshot = await pulseSnapshot(mint);
          ScanPNLCore.quote(snapshot);
          return snapshot;
        }
        catch {}
      }
      if (!account?.preferences.paperEnabled) throw Error("Paper mode is off");
      const tick = streamPrices.get(mint),
        meta = quickBuys.get(mint)?.meta || account?.positions[mint];
      const solButton = native('img[alt="SOL"]')
        .map((image) => image.closest("button"))
        .find((button) => button && /^\s*\$[\d,.]+\s*$/.test(button.textContent));
      const solUsd = streamSolUsd || ScanPNLCore.priceText(solButton?.textContent || "");
      if (tick && Date.now() - tick.at < 5000 && Number.isFinite(solUsd) && solUsd > 0)
      {
        const quote = {
          ...meta,
          mint,
          usd: tick.usd,
          solUsd,
          at: tick.at,
          source: "axiom-stream",
          url: meta?.url || "/token/" + mint + "?chain=sol",
        };
        ScanPNLCore.quote(quote);
        return quote;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // last resort: the background's market quote (dexscreener)
    const market = await chrome.runtime
      .sendMessage({
        type: "refresh",
        mint,
      })
      .catch(() => undefined);
    if (market?.quote)
    {
      try
      {
        const quote = {
          ...quickBuys.get(mint)?.meta,
          ...market.quote,
          mint,
        };
        ScanPNLCore.quote(quote);
        return quote;
      }
      catch {}
    }
    throw Error("Waiting for Axiom\u2019s live price. No paper fill was placed.");
  }

  // a fresh fill price for an order
  async function executionQuote(mint)
  {
    if (mint && quickBuys.has(mint) && account?.currentQuote?.mint !== mint)
    {
      return pulseExecutionQuote(mint);
    }
    let pageQuote;
    try
    {
      pageQuote = getQuote();
    }
    catch (error)
    {
      if (!mint) throw error;
    }
    const target = mint || pageQuote?.mint,
      position = account?.positions[target];
    const page = pageQuote?.mint === target ? pageQuote : undefined;
    const candidates = [pageQuote, account?.currentQuote, position]
      .filter((item) => item?.mint === target)
      .sort((first, second) => (second.at || 0) - (first.at || 0));
    for (const candidate of candidates)
    {
      try
      {
        ScanPNLCore.quote(candidate);
        return {
          ...position,
          ...page,
          ...candidate,
          mint: target,
          name: position?.name || candidate.name,
          url: position?.url || candidate.url,
        };
      }
      catch {}
    }
    const path = location.pathname;
    const market = await chrome.runtime.sendMessage({
      type: "refresh",
      mint: target,
    });
    if (market.error) throw Error(market.error);
    if (market.state) adoptState(market.state);
    if (!mint && location.pathname !== path) throw Error("Token changed; try again");
    if (!market.quote) throw Error("Live price unavailable. Please try again shortly.");
    const quote = {
      ...position,
      ...page,
      ...market.quote,
      mint: target,
      name: position?.name || pageQuote?.name || market.quote.name,
      url: position?.url || pageQuote?.url || market.quote.url,
    };
    try
    {
      ScanPNLCore.quote(quote);
    }
    catch
    {
      throw Error("Live price unavailable. Please try again shortly.");
    }
    account.currentQuote = quote;
    return quote;
  }

  // fees and slippage for an order: axiom's panel, an earlier order, or axiom's default preset
  async function executionSettings(side, mint)
  {
    let settings;
    try
    {
      settings = nativeExecutionSettings(side);
    }
    catch {}
    settings ||= account.nativePanelSettings?.[side];
    const lastOrder = [...account.orders]
      .reverse()
      .find((order) => order.mint === mint && order.nativeSettings);
    if (!settings && lastOrder)
    {
      settings = {
        ...lastOrder.nativeSettings,
        costs: {
          ...lastOrder.costs,
        },
      };
    }
    if (!settings)
    {
      const preset = await quickSettings("default", side);
      settings = {
        source: "axiom-native-panel",
        costs: {
          platform: ScanPNLCore.defaults.platform,
          fee: nativeTradingFee(side),
          slip: 0,
          fixed: preset.fixed,
        },
        tolerance: preset.tolerance,
      };
    }
    let pageMint;
    try
    {
      pageMint = getQuote().mint;
    }
    catch {}
    if (mint !== pageMint && lastOrder)
    {
      settings = {
        ...settings,
        costs: {
          ...settings.costs,
          fee: lastOrder.costs.fee,
        },
      };
    }
    return settings;
  }

  // the token tax for one side from axiom's "Tax %" card ("1.25%", "0.2-1.28%" or "4.09% / 8.90%"), else pump.fun's schedule, else the last value seen
  function nativeTradingFee(side = "buy")
  {
    const TAX_PATTERN = /^(\d+(?:\.\d+)?)\s*%?\s*(?:[-\u2013\/]\s*(\d+(?:\.\d+)?)\s*)?%\s*\+?$/;
    const rate = (text) =>
    {
      const match = text.trim().match(TAX_PATTERN);
      return Number(side === "sell" && match[2] != null ? match[2] : match[1]) / 100;
    };
    // the "Tax %" label first: other stats (top-10 holders, snipers) also show percent icons
    const taxLabel = leaf("Tax %");
    if (taxLabel)
    {
      for (
        let node = taxLabel.parentElement, depth = 0;
        node && depth++ < 3;
        node = node.parentElement
      )
      {
        const value = [...node.querySelectorAll("span,div")].find(
          (element) => !element.children.length && TAX_PATTERN.test(element.textContent.trim()),
        );
        if (value) return rate(value.textContent);
      }
    }
    for (const icon of native('i[class*="percent"]'))
    {
      for (
        let node = icon.parentElement, depth = 0;
        node && depth++ < 4;
        node = node.parentElement
      )
      {
        const text = node.textContent.trim();
        if (TAX_PATTERN.test(text)) return rate(text);
      }
    }
    const pageQuote =
      nativeQuote?.url?.split("?")[0] === location.pathname ? nativeQuote : undefined;
    const pump = ScanPNLCore.pumpTax(
      pageQuote?.protocol,
      pageQuote?.supply > 0 && pageQuote.solUsd > 0
        ? (pageQuote.usd * pageQuote.supply) / pageQuote.solUsd
        : 0,
    );
    if (pump != null) return pump;
    const lastFee = account?.nativePanelSettings?.[side]?.costs?.fee;
    if (Number.isFinite(lastFee)) return lastFee;
    throw Error("Axiom trading fee is still loading");
  }

  // slippage, priority fee and bribe from axiom's instant-trade panel
  function nativeExecutionSettings(side)
  {
    const slippageIcons = native('.buy-click-container img[alt="Slippage"]');
    const slippageIcon = slippageIcons[side === "sell" ? 1 : 0] || native('img[alt="Slippage"]')[0];
    let feeRow = slippageIcon?.parentElement;
    for (
      let depth = 0;
      feeRow && depth < 5 && !feeRow.querySelector('i[class*="gas-station"]');
      depth++
    )
    {
      feeRow = feeRow.parentElement;
    }
    if (!feeRow || !feeRow.querySelector('i[class*="gas-station"]'))
    {
      throw Error("Native fee controls not ready");
    }
    const slippage = slippageIcon.parentElement.textContent.match(/([0-9.]+)\s*%/);
    const readFee = (selector) =>
    {
      const item = feeRow.querySelector(selector)?.parentElement,
        sub = item?.querySelector("sub");
      const value = ScanPNLCore.priceText(
        item?.textContent || "",
        sub?.textContent,
        sub?.nextSibling?.textContent,
      );
      if (!Number.isFinite(value)) throw Error("Native fee value is still loading");
      return value;
    };
    if (!slippage) throw Error("Native slippage is still loading");
    return {
      source: "axiom-native-panel",
      costs: {
        platform: ScanPNLCore.defaults.platform,
        fee: nativeTradingFee(side),
        slip: 0,
        fixed: readFee('i[class*="gas-station"]') + readFee('i[class*="coin"]'),
      },
      tolerance: Number(slippage[1]) / 100,
    };
  }

  // the instant-trade panel settings last sent to the background
  let panelSettingsKey = "";
  // sends axiom's panel settings to the background when they change
  function relayNativeSettings()
  {
    const panel = native(".buy-click-container")[0];
    if (!panel) return;
    try
    {
      const settings = {
          buy: nativeExecutionSettings("buy"),
          sell: nativeExecutionSettings("sell"),
        },
        key = JSON.stringify(settings);
      if (key !== panelSettingsKey)
      {
        panelSettingsKey = key;
        account.nativePanelSettings = settings;
        chrome.runtime
          .sendMessage({
            type: "nativePanelSettings",
            settings,
          })
          .catch(() => {});
      }
    }
    catch {}
  }

  // how many wallets axiom (or the paper wallet menu) has selected
  function nativeWalletCount(element)
  {
    if (account?.walletSummaries)
    {
      return account.walletSummaries.filter((wallet) => wallet.selected).length;
    }
    const region = element?.closest?.(".buy-click-container,[data-scanpnl-order-region]");
    const buttons = [
      ...(region ? [...region.querySelectorAll("button")] : []),
      ...native(".buy-click-container button"),
      ...native("[data-scanpnl-order-region] button"),
      ...native("button"),
    ];
    for (const button of new Set(buttons))
    {
      if (button.closest("[data-scanpnl-owned]")) continue;
      const walletIcon = button.querySelector("i.ri-wallet-line");
      if (!walletIcon) continue;
      if (walletIcon.parentElement === button && button.querySelector('img[alt="SOL"]')) continue;
      const countSpan = [...(walletIcon.parentElement.querySelectorAll?.("span") || [])].find(
        (span) =>
          !span.children.length &&
          !span.closest("[data-scanpnl-owned]") &&
          /^(0|[1-9]\d*)$/.test(span.textContent.trim()),
      );
      const count =
        countSpan?.textContent.trim() ||
        walletIcon.parentElement.textContent.replace(walletIcon.textContent || "", "").trim();
      if (!/^(0|[1-9]\d*)$/.test(count)) continue;
      return Number(count);
    }
    return undefined;
  }

  // milliseconds until an order may fill
  function executionWait(order, now = Date.now())
  {
    return Math.max(0, order.executeAfter - now);
  }

  // places a paper order: prepare, wait for the fill delay, fill at a fresh price
  async function execute(side, amount, mint, trigger, options)
  {
    executingCount++;
    executing = true;
    const id = crypto.randomUUID();
    let walletCount = 1;
    const transaction = (phase, error) =>
      window.postMessage(
        {
          type: "scanpnl-transaction-v1",
          id,
          side,
          phase,
          error,
          count: walletCount,
        },
        location.origin,
      );
    let started = false;
    try
    {
      if (!account) throw Error("Account is still loading");
      if (document.documentElement.dataset.scanpnlWalletGuard)
      {
        throw Error(
          "Wallet guard unavailable. Paper execution disabled; disconnect the real wallet.",
        );
      }
      if (!navigator.onLine) throw Error("Reconnect before placing an order");
      // no axiom wallet picker on this page (e.g. pulse): trade as one wallet
      const wallets = nativeWalletCount(trigger) ?? 1;
      if (!Number.isInteger(wallets) || wallets < 1 || wallets > 20)
      {
        throw Error("Select 1\u201320 wallets in Axiom before trading");
      }
      const quote = await executionQuote(mint);
      // quick buys build their settings from the bought token's quote (its own tax)
      const settings =
        typeof options?.settings === "function"
          ? options.settings(quote)
          : options?.settings || (await executionSettings(side, quote.mint));
      if (side === "buy" && (options?.usd || trigger?.dataset.scanpnlUsd === "true"))
      {
        amount /= quote.solUsd;
      }
      if (side === "sell" && trigger?.dataset.scanpnlSellUnit === "SOL")
      {
        amount = ScanPNLSafety.solFraction(account.positions[quote.mint], quote, amount);
      }
      const prepared = await chrome.runtime.sendMessage({
        type: "prepare",
        id,
        mint: quote.mint,
        side,
        amount,
        walletCount: wallets,
        url: quote.url,
        nativeSettings: {
          ...settings,
          referenceUsd: quote.usd,
        },
      });
      if (prepared.error) throw Error(prepared.error);
      if (prepared.order.status !== "pending")
      {
        throw Error("Order is already " + prepared.order.status);
      }
      adoptState(prepared.state);
      walletCount = prepared.order.walletCount;
      transaction("loading");
      started = true;
      await new Promise((resolve) => setTimeout(resolve, executionWait(prepared.order)));
      if (!navigator.onLine) throw Error("Reconnect before placing an order");
      const fillQuote = await executionQuote(mint);
      if (quote.mint !== fillQuote.mint || quote.url !== fillQuote.url)
      {
        throw Error("Token changed; try again");
      }
      await send({
        type: "trade",
        id,
        quote: fillQuote,
      });
      render();
      transaction("confirmed");
    }
    catch (error)
    {
      if (started)
      {
        transaction("error", error.message);
        chrome.runtime
          .sendMessage({
            type: "cancel",
            id,
          })
          .catch(() => {});
      }
      if (!started) notice(error.message);
    }
    finally
    {
      executingCount--;
      executing = executingCount > 0;
    }
  }

  // sells enough of the position to get the invested sol back
  async function sellInitial()
  {
    try
    {
      if (!account?.preferences?.paperEnabled) throw Error("Paper mode is off");
      const quote = await executionQuote(),
        position = account.positions[quote.mint];
      const wallets = nativeWalletCount() ?? 1;
      if (!Number.isInteger(wallets) || wallets < 1 || wallets > 20)
      {
        throw Error("Select 1\u201320 wallets in Axiom before trading");
      }
      const fraction = ScanPNLSafety.initialFraction(
        position,
        quote,
        (await executionSettings("sell", quote.mint)).costs,
        wallets,
      );
      await execute("sell", fraction);
    }
    catch (error)
    {
      notice(error.message);
    }
  }

  // the trade panel or order form an element belongs to
  function tradeRegion(element)
  {
    return (
      element.closest(".buy-click-container") ||
      [...document.querySelectorAll("[data-scanpnl-order-region]")].find((region) =>
        region.contains(element),
      )
    );
  }

  // the pulse column (new pairs, final stretch, migrated) a card sits in
  function pulseColumn(element)
  {
    const COLUMNS = {
      newpairs: "newPairs",
      finalstretch: "finalStretch",
      migrated: "migrated",
    };
    const column = (label) => COLUMNS[label?.toLowerCase().replace(/[^a-z]/g, "")];
    for (
      let node = element.parentElement;
      node && node !== document.body;
      node = node.parentElement
    )
    {
      const found = new Set();
      for (const search of node.querySelectorAll("[data-pulse-search-table]"))
      {
        const name = column(search.getAttribute("data-pulse-search-table"));
        if (name) found.add(name);
      }
      if (found.size === 1) return [...found][0];
      if (found.size > 1) break;
      for (const button of node.querySelectorAll("button[aria-label]"))
      {
        const match = button
          .getAttribute("aria-label")
          .match(/^Open (New Pairs|Final Stretch|Migrated) filters$/);
        if (match) found.add(column(match[1]));
      }
      if (found.size === 1) return [...found][0];
      if (found.size > 1) break;
      for (const heading of node.querySelectorAll("h1,h2,h3,h4,span,div"))
      {
        if (heading.children.length || heading.closest("[data-pulse-token-address]")) continue;
        const text = heading.textContent.trim();
        if (text === "New Pairs" || text === "Final Stretch" || text === "Migrated")
        {
          found.add(column(text));
        }
      }
      if (found.size === 1) return [...found][0];
      if (found.size > 1) break;
    }
  }

  // axiom's settings live in this page's storage: the pnl panel toggles as their own keys, the rest
  // in the `settings` object
  let settingsCache,
    settingsAt = 0;
  // one of axiom's own settings, read from this page's storage
  function axiomSetting(key)
  {
    try
    {
      const stored = localStorage.getItem(key);
      if (stored !== null) return JSON.parse(stored);
      // `settings` is about 40 kb, so it is parsed at most once a second
      if (Date.now() - settingsAt > 1000)
      {
        settingsCache = JSON.parse(localStorage.getItem("settings") || "{}");
        settingsAt = Date.now();
      }
      return settingsCache?.[key];
    }
    catch
    {
      return undefined;
    }
  }

  // the position and trades to show; with axiom's "reset pnl" on, only the current round
  function shown(position)
  {
    if (!position || axiomSetting("useCumulativePnl") !== false) return [position, account.trades];
    const fills = ScanPNLCore.roundTrades(account.trades, position.mint);
    const sum = (side) =>
      fills.reduce((sum, fill) => sum + (fill.side === side ? fill.cash : 0), 0);
    return [
      {
        ...position,
        bought: sum("buy"),
        sold: sum("sell"),
      },
      fills,
    ];
  }

  // position stats for display (see shown)
  function shownMetrics(position, solUsd)
  {
    const [shownPosition, fills] = shown(position);
    return ScanPNLCore.metrics(shownPosition, solUsd, fills);
  }

  // the token behind a discover, tracker or social quick-buy button: axiom's row data, else the /token/ link in the same row
  function quickTarget(button)
  {
    // the page script finds the button by the request id
    const id = crypto.randomUUID();
    button.dataset.scanpnlQuickTarget = id;
    return askPage("scanpnl-quick-target", {}, 500, id).then((reply) =>
    {
      delete button.dataset.scanpnlQuickTarget;
      const token = reply?.token;
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token?.mint || "")) return token;
      for (
        let node = button.parentElement;
        node && node !== document.body;
        node = node.parentElement
      )
      {
        if (node.querySelectorAll('button[class*="group/quickBuyButton"]').length > 1) break;
        const link = node
          .querySelector('a[href*="/token/"]')
          ?.getAttribute("href")
          .match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
        if (link)
        {
          return {
            mint: link[1],
          };
        }
      }
      throw Error("Native quick-buy token unavailable");
    });
  }

  // what a quick-buy button buys: token, amount, currency, preset table and redirect
  async function quickBuyContext(button)
  {
    const card = button.closest("[data-pulse-token-address]");
    let mint,
      meta = {};
    if (card)
    {
      mint = card.getAttribute("data-pulse-token-address");
      if (
        button.closest("[data-pulse-chain]")?.getAttribute("data-pulse-chain") !== "sol" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || "")
      )
      {
        throw Error("Only Solana paper quick buys are supported");
      }
    }
    else
    {
      meta = await quickTarget(button);
      if (meta.chain && !/^sol/.test(meta.chain))
      {
        throw Error("Only Solana paper quick buys are supported");
      }
      mint = meta.mint;
    }

    // amount text: pulse "0.5 SOL", discover "Buy 0.5 SOL", wallet tracker "0.5" (sol)
    const text = button.textContent
      .replace(/[^\x20-\x7e]/g, "")
      .trim()
      .replace(/^Buy\s*/i, "");
    const amountMatch = text.match(/^(\$)?([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s*(SOL|USDC)?$/i);
    const currencyIcon = button.querySelector('img[alt="SOL"],img[alt="Solana"],img[alt="USDC"]');
    if (!amountMatch || (card && !amountMatch[1] && !amountMatch[3] && !currencyIcon))
    {
      throw Error("Native quick-buy amount unavailable");
    }
    const amount = Number(amountMatch[2].replace(/,/g, ""));
    if (!(amount > 0))
    {
      throw Error(
        card
          ? "Set a quick-buy amount at the top of this Pulse column"
          : "Set a quick-buy amount first",
      );
    }

    // axiom's preset for the surface: the pulse column's, the wallet tracker's (not its social feed),
    // else the default
    const tracker =
      location.pathname.startsWith("/trackers") &&
      !button.closest('[data-perf-id="tracker-twitter-feed"]');
    return {
      mint,
      name: meta.name,
      image: meta.image,
      // pulse quick buys follow axiom's "quick buy behavior"; other buttons only when axiom's own
      // button would (its shouldRedirect prop)
      redirect: !!card || meta.redirect === true,
      table: (card && pulseColumn(card)) || (tracker ? "walletTracker" : "default"),
      amount,
      usd: !!amountMatch[1] || (amountMatch[3] || currencyIcon?.alt)?.toUpperCase() === "USDC",
    };
  }

  // axiom's quick-buy preset (fees and slippage) for a table
  async function quickSettings(table, side = "buy")
  {
    const reply = await askPage("scanpnl-quick-settings", { table, side }, 5000);
    if (!reply) throw Error("Native quick-buy settings are still loading");
    if (reply.error) throw Error(reply.error);
    return reply.settings;
  }

  // the bought token's own tax: pump.fun's schedule by protocol and market cap, else the paper default;
  // never the open page's percent text, which belongs to another token or is a card stat
  function quickBuyTax(quote)
  {
    const marketCapSol =
      quote.supply > 0 && quote.solUsd > 0 ? (quote.usd * quote.supply) / quote.solUsd : 0;
    const tax = ScanPNLCore.pumpTax(quote.protocol, marketCapSol) ?? account?.preferences.costs.fee;
    if (!Number.isFinite(tax)) throw Error("Paper fee is unavailable");
    return tax;
  }

  // quick-buy buttons with a buy in progress
  const quickBuying = new WeakSet();
  // places a paper buy for an axiom quick-buy button, then follows axiom's quick-buy behavior
  async function quickBuy(button)
  {
    if (quickBuying.has(button)) return;
    quickBuying.add(button);
    try
    {
      const path = location.pathname;
      const target = await quickBuyContext(button),
        card = button.closest("[data-pulse-token-address]");
      // axiom's quick buy behavior (nothing / goto / tab); a new tab opens now, while the click still
      // counts as a user action for the popup blocker
      const behavior = target.redirect ? axiomSetting("quickBuyBehavior") : "nothing";
      if (behavior === "tab")
      {
        window.open("/token/" + target.mint + "?chain=sol", "_blank", "noopener");
      }

      // axiom's preset (priority + bribe, slippage), else the instant-trade panel's fees, else the defaults
      const preset = await quickSettings(target.table).catch(() =>
      {
        const panel = account?.nativePanelSettings?.buy;
        return panel
          ? {
            fixed: panel.costs.fixed,
            tolerance: panel.tolerance,
          }
          : {
            fixed: account.preferences.costs.fixed,
            tolerance: 0.2,
          };
      });
      const tokenImage = [...(card?.querySelectorAll("img") || [])].find(
        (image) =>
          image.alt &&
          !["SOL", "Solana", "Pump", "Pump AMM", "Raydium", "USDC"].includes(image.alt),
      );
      const entry = quickBuys.get(target.mint) || {
        count: 0,
        meta: {
          mint: target.mint,
          name: target.name || tokenImage?.alt || target.mint.slice(0, 6),
          image: target.image || tokenImage?.src,
          url: "/token/" + target.mint + "?chain=sol",
        },
      };
      entry.count++;
      quickBuys.set(target.mint, entry);
      button.dataset.scanpnlQuickMint = target.mint;
      render();
      if (
        location.pathname !== path ||
        (card &&
          button.isConnected &&
          button.closest("[data-pulse-token-address]")?.getAttribute("data-pulse-token-address") !==
            target.mint)
      )
      {
        throw Error("Token changed; try again");
      }
      await execute("buy", target.amount, target.mint, button, {
        usd: target.usd,
        settings: (quote) => ({
          source: "axiom-native-panel",
          costs: {
            platform: ScanPNLCore.defaults.platform,
            fee: quickBuyTax(quote),
            slip: 0,
            fixed: preset.fixed,
          },
          tolerance: preset.tolerance,
        }),
      });

      // go to token: opened in this tab once the paper buy is done (axiom opens it after sending its
      // own buy, whatever the result)
      if (behavior === "goto" && location.pathname === path)
      {
        window.postMessage(
          {
            type: "scanpnl-open-token-v1",
            mint: target.mint,
          },
          location.origin,
        );
      }
    }
    catch (error)
    {
      notice(error.message);
    }
    finally
    {
      const quickMint = button.dataset.scanpnlQuickMint,
        entry = quickBuys.get(quickMint);
      if (entry && --entry.count <= 0) quickBuys.delete(quickMint);
      delete button.dataset.scanpnlQuickMint;
      quickBuying.delete(button);
      render();
    }
  }

  // intercepts clicks on axiom trade controls and handles them as paper actions
  function guard(event)
  {
    if (account?.preferences?.paperEnabled === false) return;
    if (!(event.target instanceof Element)) return;
    const target = event.target;
    const button = target.closest('button,[role="tab"]');
    if (
      button &&
      /^(?:Quick Buy|Snipe|Pulse Quick Buy|Discover Quick Buy)$/.test(button.textContent.trim()) &&
      button.closest('.global-modal-overlay,[role="dialog"]')
    )
    {
      return;
    }
    let action = target.closest("[data-scanpnl-action]");
    const pnlButton = target.closest("button");
    if (
      pnlButton &&
      pnlButton.closest("[data-scanpnl-metric-row]") &&
      /^PnL(?:\s|$)/i.test(pnlButton.textContent.trim())
    )
    {
      pnlButton.dataset.scanpnlAction = "share";
      action = pnlButton;
    }

    // the pnl tracker's reset button (shown on hover) resets the paper pnl, with a second click to
    // confirm
    const trackerButton = target.closest('[data-persistent-popup-frame="pnl-tracker"] button');
    if (!action && trackerButton?.querySelector("i.ri-reset-left-line"))
    {
      trackerButton.dataset.scanpnlAction = "resetPnl";
      action = trackerButton;
    }
    const labelled = target.closest("button[aria-label]");
    if (
      !action &&
      /^Show values in (?:USD|SOL)$/.test(labelled?.getAttribute("aria-label") || "")
    )
    {
      const row = labelled.closest("[data-scanpnl-metric-row]") || labelled.parentElement;
      if (
        row &&
        (/Bought[\s\S]*Sold[\s\S]*Holding/i.test(row.textContent) ||
          row.hasAttribute("data-scanpnl-metric-row"))
      )
      {
        labelled.dataset.scanpnlAction = "currency";
        action = labelled;
      }
    }
    if (location.pathname === "/portfolio" && portfolioPaper)
    {
      const sellButton = target.closest("button");
      if (sellButton?.querySelector("i.ri-arrow-up-line"))
      {
        let node = sellButton.parentElement,
          mint;
        for (let depth = 0; node && depth < 5; depth++, node = node.parentElement)
        {
          const link = node.querySelector('a[href*="/token/"]');
          const match = link?.getAttribute("href")?.match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
          if (match && account?.positions[match[1]])
          {
            mint = match[1];
            break;
          }
        }
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        if (event.type === "click")
        {
          if (mint) execute("sell", 1, mint, sellButton);
          else notice("Position unavailable");
        }
        return;
      }
    }
    const initialButton =
      target.closest('[data-scanpnl-action="initial"]') || target.closest("button,span,div");
    const sellsInitial = ScanPNLSafety.sellInitial(initialButton?.textContent || "");
    if (sellsInitial)
    {
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
      if (event.type === "click") sellInitial();
      return;
    }
    const region = tradeRegion(target);
    const clicked = target.closest("button");
    const label = clicked?.textContent.trim() || "";
    const tradeButton = /^(Buy|Sell)\s+\S/.test(label) && !/^Buy delay/.test(label);
    const preset = region && target.closest(".cursor-pointer");
    const presetAmount =
      preset &&
      /^(\d*\.)?\d+%?$/.test(preset.textContent.trim()) &&
      !preset.querySelector("input,i.ri-wallet-line") &&
      !clicked?.querySelector("i.ri-wallet-line");
    const ascii = label.replace(/[^\x20-\x7e]/g, "").trim();
    // pulse quick-buy buttons show "0.5 SOL", or "$5" / "0.5" with a sol icon
    const pulseButton =
      clicked &&
      (/^[0-9.,]+\s*SOL$/i.test(ascii) ||
        (!!clicked.closest("[data-pulse-token-address]") &&
          /^\$?[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:SOL|USDC)?$/i.test(ascii)));
    // pulse quick buy: a div cell ([data-pulse-qb-cell]) in current builds, a button inside
    // [data-pulse-qb-face] in older ones; pulseCell is the element showing the amount
    const pulseCell =
      target.closest("[data-pulse-qb-cell]") ||
      (clicked?.closest("[data-pulse-qb-face]") && clicked);
    // discover and wallet-tracker quick buys (button.group/quickBuyButton), and the lightning button
    // on the tracker's social feed
    const rowQuickBuy =
      clicked &&
      !region &&
      (clicked.matches('[class*="group/quickBuyButton"]') ||
        (!!clicked.querySelector("i.ri-flashlight-fill") &&
          !!clicked.closest('[data-perf-id="tracker-twitter-feed"]'))) &&
      clicked;
    const intercept =
      action ||
      tradeButton ||
      pulseButton ||
      pulseCell ||
      rowQuickBuy ||
      ScanPNLSafety.unsupported(label) ||
      /^(Deposit|Withdraw|Bridge to Solana)$/.test(label) ||
      presetAmount;
    if (!intercept) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
    if (event.type !== "click") return;
    if (action)
    {
      if (action.dataset.scanpnlAction === "paperWallet")
      {
        const wallets = account?.walletSummaries || [],
          walletId = action.dataset.scanpnlWallet;
        const ids =
          walletId === "none"
            ? []
            : walletId === "funded"
              ? wallets.filter((wallet) => wallet.balance > 0).map((wallet) => wallet.id)
              : wallets
                .filter((wallet) => (wallet.id === walletId ? !wallet.selected : wallet.selected))
                .map((wallet) => wallet.id);
        send({
          type: "selectPaperWallets",
          ids,
        })
          .then(render)
          .catch((error) => notice(error.message));
        return;
      }
      if (action.dataset.scanpnlAction === "portfolioWallet")
      {
        selectPortfolio(!portfolioPaper);
        return;
      }
      if (action.dataset.scanpnlAction === "tickerSell")
      {
        execute("sell", 1, action.dataset.scanpnlMint, action);
        return;
      }
      if (action.dataset.scanpnlAction === "resetPnl")
      {
        if (Date.now() > resetArmedUntil)
        {
          resetArmedUntil = Date.now() + 5000;
          notice("Click again to reset paper PNL. Positions stay saved.");
        }
        else
        {
          resetArmedUntil = 0;
          send({
            type: "resetPnl",
          })
            .then(render)
            .catch((error) => notice(error.message));
        }
        return;
      }
      if (action.dataset.scanpnlAction === "initial")
      {
        sellInitial();
        return;
      }
      if (action.dataset.scanpnlAction === "currency")
      {
        const next = currencyMode === "USD" ? "SOL" : "USD";
        currency(next);
        chrome.runtime
          .sendMessage({
            type: "preferences",
            preferences: {
              pnlCurrency: next,
            },
          })
          .catch((error) => notice(error.message));
        return;
      }
      const kind = action.dataset.scanpnlAction;
      // presets are re-read first: one axiom just relabelled has a new amount
      if (kind === "buy" || kind === "sell") render();
      if (kind === "buy" || kind === "sell")
      {
        execute(kind, Number(action.dataset.scanpnlAmount), undefined, action);
      }
      else if (kind === "submit")
      {
        const submitButton = native("button").find(
          (button) => button.dataset.scanpnlSubmit === action.dataset.scanpnlSubmit,
        );
        const region = submitButton?.closest("[data-scanpnl-order-region]");
        const input = region?.querySelector("input");
        const amount = Number(input?.value);
        execute(
          action.dataset.scanpnlSide,
          action.dataset.scanpnlSide === "sell" ? amount / 100 : amount,
          undefined,
          action,
        );
      }
      else if (kind === "share")
      {
        render();
        window.postMessage(
          {
            type: "scanpnl-share-v1",
          },
          location.origin,
        );
      }
    }
    else if (
      pulseCell ||
      rowQuickBuy ||
      (pulseButton && clicked.closest("[data-pulse-token-address]"))
    )
    {
      quickBuy(pulseCell || rowQuickBuy || clicked);
    }
    else notice("This control is not available in paper mode.");
  }

  // pointer and click events on trade controls go through the guard
  for (const type of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "touchstart",
    "touchend",
    "click",
    "dblclick",
    "contextmenu",
  ])
  {
    window.addEventListener(type, guard, {
      capture: true,
      passive: false,
    });
  }

  // keyboard: enter or space on paper controls clicks them; keys never reach axiom's trade inputs
  for (const type of ["keydown", "keyup", "keypress"])
  {
    window.addEventListener(
      type,
      (event) =>
      {
        if (account?.preferences?.paperEnabled === false) return;
        if (["Escape", "Tab"].includes(event.key)) return;
        const action =
          event.target instanceof Element &&
          (event.target.closest("[data-scanpnl-action]") ||
            event.target.closest("[data-pulse-qb-face] button"));
        if (action && ["Enter", " "].includes(event.key))
        {
          event.stopImmediatePropagation();
          event.preventDefault();
          if (event.type === "keydown" && !event.repeat) action.click();
          return;
        }
        const button = event.target instanceof Element && event.target.closest("button");
        if (
          button?.querySelector("i.ri-wallet-line") &&
          !/^(Buy|Sell)\b/.test(button.textContent.trim())
        )
        {
          return;
        }
        const field =
          event.target instanceof Element &&
          event.target.closest('input,textarea,[contenteditable="true"]');
        if (field?.closest(".buy-click-container")) return;
        if (
          !field ||
          (event.key === "Enter" && event.target instanceof Element && tradeRegion(event.target))
        )
        {
          event.stopImmediatePropagation();
          if (event.key === " " || event.key === "Enter") event.preventDefault();
        }
      },
      true,
    );
  }

  // axiom's order forms are never submitted in paper mode
  window.addEventListener(
    "submit",
    (event) =>
    {
      if (
        account?.preferences?.paperEnabled !== false &&
        event.target instanceof Element &&
        tradeRegion(event.target)
      )
      {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  // hovering a paper preset re-renders, so the sell preview follows the hovered amount
  document.addEventListener(
    "pointerover",
    (event) =>
    {
      const button = event.target.closest?.(
        '[data-scanpnl-action="buy"],[data-scanpnl-action="sell"]',
      );
      const panel = button?.closest(".buy-click-container");
      if (account?.preferences.paperEnabled && panel) requestAnimationFrame(() => render());
    },
    true,
  );
  // adds "1% + tax" (platform fee + token tax) to each fee row of axiom's instant-trade panel
  function feeRows(panel)
  {
    [...panel.querySelectorAll('img[alt="Slippage"]')].slice(0, 2).forEach((img, index) =>
    {
      let row = img.parentElement;
      for (
        let depth = 0;
        row && depth < 5 && !row.querySelector('i[class*="gas-station"]');
        depth++
      )
      {
        row = row.parentElement;
      }
      if (!row?.querySelector('i[class*="gas-station"]')) return;
      const side = index === 0 ? "buy" : "sell";
      let tax = 0;
      try
      {
        tax = nativeTradingFee(side);
      }
      catch {}
      const pct = (fraction) => Number((fraction * 100).toFixed(3)) + "%";
      const platform = ScanPNLCore.defaults.platform;
      const text = pct(platform) + (tax > 0 ? " + " + pct(tax) : "");
      let item = row.querySelector(":scope > [data-scanpnl-fee]");
      if (!item)
      {
        const divider = [...row.children].find((child) =>
          String(child.className).includes("bg-primaryStroke"),
        );
        if (divider)
        {
          const copy = divider.cloneNode(false);
          copy.dataset.scanpnlOwned = "";
          copy.dataset.scanpnlFeeDivider = "";
          row.append(copy);
        }
        item = document.createElement("div");
        item.dataset.scanpnlOwned = "";
        item.dataset.scanpnlFee = "";
        item.className = "flex flex-row items-center justify-start gap-[4px] whitespace-nowrap";
        item.innerHTML =
          '<i class="ri-percent-line text-[12px] text-textTertiary"></i><span class="text-[12px] leading-[16px] font-normal text-textSecondary" translate="no"></span>';
        row.append(item);
      }

      // the fee item is kept last: axiom's re-rendered items are appended after it
      if (row.lastElementChild !== item)
      {
        const copy = row.querySelector(":scope > [data-scanpnl-fee-divider]");
        if (copy) row.append(copy);
        row.append(item);
      }
      const label = item.querySelector("span");
      if (label.textContent !== text) label.textContent = text;
      item.title =
        `Fees on this ${side}: Axiom ${pct(platform)}` +
        (tax > 0 ? ` + token tax ${pct(tax)}` : "") +
        ", plus priority and bribe";
    });
  }

  // turns axiom's instant-trade panel into a paper panel: presets, balance, sell preview and stats
  function quickPanel(quote, stats)
  {
    for (const panel of native(".buy-click-container"))
    {
      feeRows(panel);
      const typing = !!panel.querySelector(
        'input:not([data-scanpnl-owned]),textarea,[contenteditable="true"]',
      );
      if (typing)
      {
        for (const preset of panel.querySelectorAll(
          "[data-scanpnl-action=buy],[data-scanpnl-action=sell]",
        ))
        {
          delete preset.dataset.scanpnlAction;
          delete preset.dataset.scanpnlAmount;
          delete preset.dataset.scanpnlSellUnit;
          delete preset.dataset.scanpnlUsd;
        }
      }
      if (typing)
      {
        for (const [original, copy] of clonePairs)
        {
          if (panel.contains(original) && ["buy", "sell"].includes(copy.dataset.scanpnlAction))
          {
            copy.remove();
            original.removeAttribute("data-scanpnl-hidden");
            clonePairs.delete(original);
          }
        }
      }
      for (const element of [...panel.querySelectorAll("button,span,div")].filter(
        (element) =>
          !element.children.length &&
          ScanPNLSafety.sellInitial(element.textContent) &&
          !element.closest("[data-scanpnl-owned]"),
      ))
      {
        const copy = clone(element);
        copy.dataset.scanpnlAction = "initial";
        copy.tabIndex = 0;
        copy.role = "button";
        copy.setAttribute("aria-label", "Paper sell initial investment");
      }
      for (const preset of [...panel.querySelectorAll("div.cursor-pointer")].filter(
        (element) => !element.closest("[data-scanpnl-owned]"),
      ))
      {
        if (typing) continue;
        const text = preset.textContent.trim(),
          value = text.replace(/^\$\s*/, "").replace(/,/g, "");
        if (!/^(\d*\.)?\d+%?$/.test(value)) continue;
        const isSell = preset.className.includes("text-decrease");
        const sellsSol = isSell && !value.endsWith("%");
        if (!preset.className.includes(isSell ? "text-decrease" : "text-increase")) continue;
        const copy = clonePairs.get(preset);
        if (copy)
        {
          copy.remove();
          clonePairs.delete(preset);
          clones.delete(preset);
        }
        preset.removeAttribute("data-scanpnl-hidden");
        const target = preset;
        const amount = isSell && !sellsSol ? parseFloat(value) / 100 : Number(value);
        target.dataset.scanpnlSellUnit = sellsSol ? "SOL" : "percent";
        const usd =
          !isSell &&
          (text.startsWith("$") ||
            [...panel.querySelectorAll("button")].some(
              (button) =>
                !button.closest("[data-scanpnl-owned]") &&
                /^USD\s*/.test(button.textContent.trim()) &&
                button.querySelector('i[class*="arrow-left-right"]'),
            ));
        target.dataset.scanpnlUsd = String(usd);
        target.dataset.scanpnlAction = isSell ? "sell" : "buy";
        target.dataset.scanpnlAmount = amount;
        target.tabIndex = 0;
        target.role = "button";
        target.setAttribute("aria-label", `Paper ${isSell ? "sell" : "buy"} ${value}`);
      }
      const balanceCell = children(panel.firstElementChild?.firstElementChild).at(-1);
      if (balanceCell?.querySelector('img[alt="SOL"]'))
      {
        const copy = clonePairs.get(balanceCell);
        if (copy)
        {
          copy.remove();
          clonePairs.delete(balanceCell);
          clones.delete(balanceCell);
          balanceCell.removeAttribute("data-scanpnl-hidden");
        }
        const amountSpan = [...balanceCell.querySelectorAll("span")]
          .filter(
            (span) =>
              !span.querySelector("img,svg,i,span") &&
              !span.closest("[data-scanpnl-owned]") &&
              /^[\u2014\u2013-]$|^\d[\d.,]*[KMB]?$/i.test(span.textContent.trim()),
          )
          .at(-1);
        if (amountSpan) formatted(clone(amountSpan), walletBalance(account.balance, 1));
      }
      const previewCell = children(panel.children[2]?.firstElementChild).at(-1);
      if (previewCell && /\$/.test(previewCell.textContent))
      {
        const hovered = panel.querySelector("[data-scanpnl-action=sell]:hover");
        const fraction = hovered
          ? ScanPNLSafety.previewFraction(
            Number(hovered.dataset.scanpnlAmount),
            hovered.dataset.scanpnlSellUnit,
            stats.holding,
          )
          : 1;
        const qty = (account.positions[quote?.mint]?.qty || 0) * fraction,
          value = stats.holding * fraction;
        const copy = clonePairs.get(previewCell);
        if (copy)
        {
          copy.remove();
          clonePairs.delete(previewCell);
          clones.delete(previewCell);
          previewCell.removeAttribute("data-scanpnl-hidden");
        }
        const preview = previewCell;
        const inner = preview.firstElementChild?.firstElementChild;
        if (inner)
        {
          const parts = children(inner);
          if (parts.length === 6)
          {
            formatted(clone(parts[0]), compact(qty, 1));
            const nameSpan = parts[1].querySelector("span");
            const name = account.positions[quote?.mint]?.name || quote?.name;
            if (nameSpan && name && nameSpan.textContent !== name) nameSpan.textContent = name;
            formatted(
              clone(parts[3]),
              "$" +
                compact(
                  value *
                    (quote?.solUsd ||
                      account.solUsd ||
                      account.positions[quote?.mint]?.solUsd ||
                      0),
                ),
            );
            const valuePart = clone(parts[5]);
            const valueSpan = [...valuePart.querySelectorAll("span")]
              .filter((span) => !span.children.length && !span.querySelector("img,svg"))
              .at(-1);
            if (valueSpan) formatted(valueSpan, fmt(value, 1));
            else if (!valuePart.querySelector("img,svg")) formatted(valuePart, fmt(value, 1));
            else
            {
              let amountSpan = valuePart.querySelector("[data-scanpnl-preview-amount]");
              if (!amountSpan)
              {
                for (const node of [...valuePart.childNodes])
                {
                  if (node.nodeType === Node.TEXT_NODE) node.remove();
                }
                amountSpan = document.createElement("span");
                amountSpan.dataset.scanpnlPreviewAmount = "";
                valuePart.append(amountSpan);
              }
              formatted(amountSpan, fmt(value, 1));
            }
            inner.dataset.scanpnlSellPreview = "";
            if (!panel.style.getPropertyValue("--scanpnl-preview-gray"))
            {
              const probe = document.createElement("span");
              probe.className = "text-textTertiary";
              probe.dataset.scanpnlOwned = "true";
              probe.style.display = "none";
              panel.append(probe);
              panel.style.setProperty("--scanpnl-preview-gray", getComputedStyle(probe).color);
              probe.remove();
            }
          }
        }
      }
      const metricRow = children(panel.parentElement).find(
        (row) => row !== panel && metricColumns(row).length === 4,
      );
      if (metricRow)
      {
        const row = clone(metricRow);
        row.dataset.scanpnlAction = "currency";
        row.dataset.scanpnlMetricRow = "";
        metricCells(
          metricColumns(row),
          stats,
          quote?.solUsd || account.solUsd || activePaperPosition(quote)?.solUsd,
          true,
        );
      }
    }
  }

  // shows the paper wallets in axiom's wallet menu on token pages
  function paperWalletPicker()
  {
    if (!ScanPNLCore.tokenRoute(location.pathname) || !account.walletSummaries)
    {
      document.querySelectorAll("[data-scanpnl-picker-hidden]").forEach((element) =>
      {
        delete element.dataset.scanpnlHidden;
        delete element.dataset.scanpnlPickerHidden;
      });
      document.querySelectorAll("[data-scanpnl-paper-wallets]").forEach((list) => list.remove());
      for (const [original, copy] of clonePairs)
      {
        if (copy.dataset.scanpnlAction === "paperWallet")
        {
          copy.remove();
          delete original.dataset.scanpnlHidden;
          clonePairs.delete(original);
          clones.delete(original);
        }
      }
      return;
    }
    for (const toggleAll of native("button").filter((button) =>
      /^(Unselect All|Select All)$/.test(button.textContent.trim()),
    ))
    {
      const menu = toggleAll.parentElement?.parentElement?.parentElement;
      const list = menu?.querySelector(".overflow-y-auto");
      const template =
        list &&
        children(list).find(
          (row) =>
            row.getAttribute("role") === "presentation" &&
            row.querySelector(".toggle-ring") &&
            row.querySelector('img[alt="SOL"]'),
        );
      const funded =
        menu &&
        [...menu.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === "Select All with Balance",
        );
      if (!template || !funded) continue;
      const tag = (element, walletId) =>
      {
        element.dataset.scanpnlAction = "paperWallet";
        element.dataset.scanpnlWallet = walletId;
      };
      tag(clone(toggleAll), "none");
      tag(clone(funded), "funded");
      for (const row of children(list))
      {
        if (row.getAttribute("role") === "presentation")
        {
          row.dataset.scanpnlHidden = "";
          row.dataset.scanpnlPickerHidden = "";
        }
      }
      let paperList = list.querySelector("[data-scanpnl-paper-wallets]");
      if (!paperList)
      {
        paperList = document.createElement("div");
        paperList.dataset.scanpnlOwned = "";
        paperList.dataset.scanpnlPaperWallets = "";
        list.prepend(paperList);
      }
      const signature = JSON.stringify(account.walletSummaries);
      if (paperList.dataset.signature === signature) continue;
      paperList.dataset.signature = signature;
      paperList.replaceChildren(
        ...account.walletSummaries.map((wallet) =>
        {
          const row = template.cloneNode(true);
          row.removeAttribute("data-scanpnl-hidden");
          row.setAttribute("role", "option");
          row.tabIndex = 0;
          row.setAttribute("aria-selected", String(wallet.selected));
          tag(row, wallet.id);
          row.querySelectorAll("button").forEach((button) => button.remove());
          const nameSpan = row.querySelector("span.text-nowrap");
          if (nameSpan)
          {
            nameSpan.textContent = wallet.name;
            nameSpan.nextElementSibling?.remove();
          }
          const ring = row.querySelector(".toggle-ring");
          ring?.classList.toggle("border-primaryBlue", wallet.selected);
          ring?.firstElementChild?.classList.toggle("bg-primaryBlue", wallet.selected);
          ring?.firstElementChild?.classList.toggle("bg-transparent", !wallet.selected);
          for (const span of valueSpans(row))
          {
            if (span !== nameSpan)
            {
              formatted(
                span,
                span.parentElement.querySelector('img[alt="SOL"],img[alt="Solana"]')
                  ? walletBalance(wallet.balance)
                  : String(wallet.tokens),
              );
            }
          }
          row.addEventListener("keydown", (event) =>
          {
            if (event.key === "Enter" || event.key === " ")
            {
              event.preventDefault();
              event.stopPropagation();
              row.click();
            }
          });
          return row;
        }),
      );
    }
  }

  // shows the paper balance on axiom's wallet buttons
  function accountBalances()
  {
    for (const button of native("button").filter((button) =>
      button.querySelector("i.ri-wallet-line"),
    ))
    {
      const copy = clonePairs.get(button);
      if (copy)
      {
        copy.remove();
        button.removeAttribute("data-scanpnl-hidden");
        clonePairs.delete(button);
      }
      const valueBox = button.querySelector('img[alt="SOL"]')?.parentElement;
      const valueSpan =
        valueBox &&
        [...valueBox.children].find(
          (child) => child.tagName === "SPAN" && !child.querySelector("img"),
        );
      if (valueSpan) formatted(clone(valueSpan), walletBalance(account.balance));
      if (account.walletSummaries && ScanPNLCore.tokenRoute(location.pathname))
      {
        const walletIcon = button.querySelector("i.ri-wallet-line"),
          countSpan = children(walletIcon?.parentElement).find(
            (span) =>
              span.tagName === "SPAN" &&
              !span.children.length &&
              /^\d+$/.test(span.textContent.trim()) &&
              span !== valueSpan,
          );
        if (countSpan)
        {
          formatted(
            clone(countSpan),
            String(account.walletSummaries.filter((wallet) => wallet.selected).length),
          );
        }
      }
    }
  }

  // shows the paper balance and value in axiom's account dropdown
  function accountDropdown()
  {
    const totalLabel = leaf("Total Value");
    if (!totalLabel) return;
    let menu = totalLabel.parentElement;
    for (let depth = 0; menu && depth < 7; depth++, menu = menu.parentElement)
    {
      if (!menu.textContent.includes("Withdraw") || !menu.textContent.includes("Deposit")) continue;
      const solLabel = [...menu.querySelectorAll("span")].find(
        (span) =>
          !span.children.length &&
          span.textContent.trim() === "SOL" &&
          /[0-9]/.test(span.parentElement.textContent),
      );
      if (solLabel)
      {
        const row = solLabel.parentElement;
        const valueSpan = [...row.querySelectorAll("span")].find(
          (span) =>
            !span.querySelector("img") &&
            /^[0-9]/.test(span.textContent.trim()) &&
            !span.closest("[data-scanpnl-owned]"),
        );
        if (valueSpan) formatted(clone(valueSpan), walletBalance(account.balance));
      }
      const totals = ScanPNLCore.portfolio(account, account.solUsd);
      const usdSpans = [...menu.querySelectorAll("span")].filter(
        (span) =>
          !span.children.length &&
          !span.closest("[data-scanpnl-owned]") &&
          /^\$[0-9]/.test(span.textContent.trim()),
      );
      if (usdSpans[0] && account.solUsd > 0)
      {
        formatted(clone(usdSpans[0]), "$" + compact(totals.equity * account.solUsd));
      }
      break;
    }
  }

  // paper values in the market panel: holding value, order buttons and stats rows
  function marketPanel(stats, quote)
  {
    for (const callout of native("button").filter((button) =>
      button.textContent.includes("Make a callout"),
    ))
    {
      const holdingLabel = [...callout.querySelectorAll("span,div")].find(
        (element) => !element.children.length && element.textContent.trim() === "Holding",
      );
      const holdingValue =
        holdingLabel?.parentElement &&
        [...holdingLabel.parentElement.querySelectorAll("span,div")].find(
          (element) =>
            !element.children.length &&
            /^(?:\$|[\u2014\u2013-]$)/.test(element.textContent.trim()) &&
            !element.closest("[data-scanpnl-owned]"),
        );
      if (holdingValue)
      {
        formatted(
          clone(holdingValue),
          "$" +
            compact(
              stats.holding *
                (quote?.solUsd || account.solUsd || account.positions[quote?.mint]?.solUsd || 0),
            ),
        );
      }
    }
    let submitIndex = 0;
    for (const submit of native("button").filter(
      (button) =>
        /^(Buy|Sell)\s+\S/.test(button.textContent.trim()) &&
        !/^Buy delay/.test(button.textContent.trim()),
    ))
    {
      let form = submit.parentElement;
      for (let depth = 0; form && depth < 7 && !form.querySelector("input"); depth++)
      {
        form = form.parentElement;
      }
      if (!form || !form.querySelector("input") || !/AMOUNT/i.test(form.textContent)) continue;
      form.dataset.scanpnlOrderRegion = "";
      submit.dataset.scanpnlSubmit = String(submitIndex++);
      const copy = clone(submit);
      copy.dataset.scanpnlSubmit = submit.dataset.scanpnlSubmit;
      copy.dataset.scanpnlAction = "submit";
      copy.dataset.scanpnlSide = submit.textContent.trim().startsWith("Sell") ? "sell" : "buy";
      if (copy.textContent !== submit.textContent)
      {
        copy.replaceChildren(...[...submit.childNodes].map((node) => node.cloneNode(true)));
      }
    }
    for (const boughtLabel of leaves("Bought"))
    {
      const row = boughtLabel.parentElement?.parentElement;
      if (!row || !row.textContent.includes("Holding")) continue;
      const copy = clone(row);
      const columns = metricColumns(copy);
      if (columns.length !== 4) continue;
      copy.dataset.scanpnlAction = "currency";
      copy.dataset.scanpnlMetricRow = "";
      metricCells(
        columns,
        stats,
        quote?.solUsd || account.solUsd || activePaperPosition(quote)?.solUsd,
      );
    }
  }

  // shows the paper balance and pnl on axiom's pnl tracker, with its chart and reset button
  function pnlCard(quote)
  {
    const solUsd =
      quote?.solUsd ||
      account.solUsd ||
      account.trades.at(-1)?.solUsd ||
      Object.values(account.positions).find((position) => position.solUsd > 0)?.solUsd;
    const totals = ScanPNLCore.portfolio(account, solUsd),
      // the tracker counts sol in and out: a buy takes its sol off as it fills, a sell adds the
      // proceeds, and price ticks never move it
      curve = ScanPNLPnlChart.series(account, solUsd, "flow");
    totals.pnl = curve.value;
    for (const label of [...leaves("Balance"), ...leaves("PNL")].filter(accountPnlTarget))
    {
      const valueBox = children(label.parentElement || document.createElement("div"))[0];
      if (!valueBox) continue;
      const valueSpan = [valueBox, ...valueBox.querySelectorAll("span")].find(
        (element) =>
          element.tagName === "SPAN" &&
          /text-\[\d+px\]/.test(element.className) &&
          !element.querySelector("img") &&
          !element.closest("[data-scanpnl-owned]"),
      );
      if (!valueSpan) continue;
      const copy = clone(valueSpan);
      const isPnl = label.textContent.trim() === "PNL";
      const usd = currencyMode === "USD",
        amount = (isPnl ? totals.pnl : totals.balance) * (usd ? solUsd || 0 : 1);
      formatted(
        copy,
        (isPnl ? (amount >= 0 ? "+" : "-") : "") +
          (usd ? "$" : "") +
          (usd ? compact : walletBalance)(Math.abs(amount)),
      );
      for (const image of valueBox.querySelectorAll('img[alt="SOL"]'))
      {
        if (!image.closest("[data-scanpnl-owned]")) clone(image).style.display = usd ? "none" : "";
      }
      let icon = copy.querySelector("[data-scanpnl-account-icon]");
      if (!usd && !icon && !valueBox.querySelector('img[alt="SOL"]'))
      {
        const solImage = native('img[alt="SOL"]')[0];
        if (solImage)
        {
          icon = solImage.cloneNode(true);
          icon.dataset.scanpnlOwned = "true";
          icon.dataset.scanpnlAccountIcon = "";
          icon.removeAttribute("data-scanpnl-hidden");
          icon.style.cssText =
            "width:24px;height:24px;display:inline-block;vertical-align:middle;margin-right:4px";
          copy.prepend(icon);
        }
      }
      if (icon) icon.style.display = usd ? "none" : "inline-block";
      if (isPnl) tone(copy, totals.pnl);
      copy.title = isPnl
        ? "P&L tracker: " + (account.preferences.pnlChartMode || "total")
        : "Available SOL";
      const usdSpan = children(
        label.parentElement || document.createElement("div"),
      )[1]?.querySelector("span");
      if (
        usdSpan &&
        /^[-+]?\$/.test(usdSpan.textContent.trim()) &&
        Number.isFinite(solUsd) &&
        solUsd > 0
      )
      {
        const usdAmount = (isPnl ? totals.pnl : totals.balance) * solUsd;
        const usdCopy = clone(usdSpan);
        formatted(
          usdCopy,
          (isPnl ? (usdAmount >= 0 ? "+" : "-") : "") + "$" + compact(Math.abs(usdAmount)),
        );
        if (isPnl) tone(usdCopy, totals.pnl);
      }
    }
    for (const button of native("button").filter(
      (element) =>
        /^SOL/.test(element.textContent.trim()) &&
        element.querySelector('img[alt="SOL"]') &&
        accountPnlTarget(element),
    ))
    {
      const parts = children(button);
      if (parts.length !== 3) continue;
      const values = [totals.balance, totals.pnl];
      for (let index = 1; index < 3; index++)
      {
        const pair = children(parts[index]);
        if (pair.length !== 2) continue;
        formatted(
          clone(pair[0]),
          (index === 2 && values[index - 1] >= 0 ? "+" : "") + walletBalance(values[index - 1]),
        );
        formatted(
          clone(pair[1]),
          (index === 2 && values[index - 1] >= 0 ? "+" : "") +
            "$" +
            compact(values[index - 1] * (solUsd || 0)),
        );
        if (index === 2)
        {
          tone(clonePairs.get(pair[0]), totals.pnl);
          tone(clonePairs.get(pair[1]), totals.pnl);
        }
      }
    }
    for (const canvas of native('canvas[aria-label="PNL History"]').filter(accountPnlTarget))
    {
      const copy = clone(canvas);
      if (copy.width !== canvas.width) copy.width = canvas.width;
      if (copy.height !== canvas.height) copy.height = canvas.height;
      copy.setAttribute("aria-label", "PNL History");
      const context = copy.getContext("2d");
      if (!context) continue;
      const points = curve.points;
      const width = copy.width,
        height = copy.height;
      context.clearRect(0, 0, width, height);
      const lowest = Math.min(0, ...points.map((point) => point.pnl)),
        highest = Math.max(0, ...points.map((point) => point.pnl));
      const range = highest - lowest || 1;
      const start = points[0].at,
        span = Math.max(1, points.at(-1).at - start);
      const yOf = (pnl) => height - height * 0.12 - ((pnl - lowest) / range) * height * 0.76;
      context.strokeStyle = "#555b66";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, yOf(0));
      context.lineTo(width, yOf(0));
      context.stroke();
      context.strokeStyle = pnlColor(totals.pnl);
      context.lineWidth = 2 * (devicePixelRatio || 1);
      context.beginPath();
      points.forEach((point, index) =>
      {
        const x = ((point.at - start) / span) * width;
        if (index) context.lineTo(x, yOf(point.pnl));
        else context.moveTo(x, yOf(point.pnl));
      });
      context.stroke();
      copy.dataset.scanpnlPnl = String(totals.pnl);
      copy.title = `P&L ${signed(totals.pnl)} SOL`;
    }
    const resetButtons = new Set(
      native("button").filter((button) =>
        /reset.*pnl/i.test(
          [button.getAttribute("aria-label"), button.getAttribute("title")].join(" "),
        ),
      ),
    );
    for (const canvas of native('canvas[aria-label="PNL History"]').filter(accountPnlTarget))
    {
      let card = canvas.parentElement;
      for (
        let depth = 0;
        card && card !== document.body && depth < 10;
        depth++, card = card.parentElement
      )
      {
        if (!/PNL/.test(card.textContent) || !/Balance/.test(card.textContent)) continue;
        const icons = [
          ...card.querySelectorAll("i.ri-refresh-line,i.ri-restart-line,i.ri-reset-left-line"),
        ]
          .filter((icon) => !icon.closest("[data-scanpnl-owned]"))
          .map(
            (icon) => icon.closest('button,[role="button"],.cursor-pointer') || icon.parentElement,
          );
        if (icons.length)
        {
          icons.forEach((button) => resetButtons.add(button));
          break;
        }
      }
    }
    for (const button of resetButtons)
    {
      const copy = clone(button);
      copy.dataset.scanpnlAction = "resetPnl";
      copy.setAttribute("role", "button");
      copy.tabIndex = 0;
      copy.setAttribute("aria-label", "Reset paper PNL (click twice)");
    }
    if (Date.now() - lastSampleAt >= 15000)
    {
      lastSampleAt = Date.now();
      send({
        type: "sample",
        solUsd,
      }).catch(() => {});
    }
  }

  // shows paper positions in the ticker bar while its active positions view is open
  function tickerPositions(quote)
  {
    const strip = native("[data-ticker-strip]")[0];
    if (!strip) return;
    // the ticker bar shows watchlist (star), active positions (line chart) or recent pairs (history),
    // the selected one marked text-textSecondary; paper positions replace only active positions
    const view = strip.parentElement?.parentElement?.querySelector(
      "button > i.ri-line-chart-line",
    )?.parentElement;
    if (!view?.classList.contains("text-textSecondary"))
    {
      clonePairs.get(strip)?.remove();
      clonePairs.delete(strip);
      strip.removeAttribute("data-scanpnl-hidden");
      return;
    }
    const nativeChip = strip.querySelector("a[data-ticker-chip]");
    const paperStrip = clone(strip),
      held = Object.values(account.positions).filter((position) => position.qty > 0);
    if (!paperStrip.dataset.scanpnlTickerReady)
    {
      paperStrip.replaceChildren();
      paperStrip.dataset.scanpnlTickerReady = "true";
    }
    const heldMints = new Set(held.map((position) => position.mint));
    for (const chip of paperStrip.querySelectorAll("[data-scanpnl-mint]"))
    {
      if (!heldMints.has(chip.dataset.scanpnlMint)) chip.remove();
    }
    for (const position of held)
    {
      let chip = [...paperStrip.querySelectorAll("[data-scanpnl-mint]")].find(
        (chip) => chip.dataset.scanpnlMint === position.mint,
      );
      if (!chip)
      {
        chip = document.createElement("a");
        chip.dataset.tickerChip = "true";
        chip.dataset.scanpnlOwned = "";
        chip.dataset.scanpnlMint = position.mint;
        chip.className =
          nativeChip?.className ||
          "group relative inline-flex h-full shrink-0 cursor-pointer items-center justify-center gap-[4px] rounded px-[8px] transition-colors duration-150 ease-out hover:rounded-[4px] hover:bg-primaryStroke/40 select-none no-underline";
        chip.style.cssText =
          "display:inline-flex!important;align-items:center;gap:4px;white-space:nowrap;flex:none;font-size:12px;line-height:16px";
        const image = document.createElement("img");
        image.dataset.part = "image";
        image.width = 15;
        image.height = 15;
        image.style.cssText = "width:15px;height:15px;flex:none;border-radius:4px";
        const fallback = document.createElement("span");
        fallback.dataset.part = "fallback";
        fallback.textContent = (position.ticker || position.name || "?").slice(0, 1);
        fallback.style.cssText =
          "display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center;background:#444;border-radius:3px;font-size:10px";
        image.onerror = () =>
        {
          image.style.display = "none";
          fallback.style.display = "inline-flex";
        };
        for (const part of ["name", "amount", "pct"])
        {
          const span = document.createElement("span");
          span.dataset.part = part;
          span.className =
            "text-[12px] font-medium leading-[16px] " +
            (part === "amount" ? "text-textTertiary" : "text-textSecondary");
          if (part === "name")
          {
            span.style.maxWidth = "68px";
            span.style.overflow = "hidden";
            span.style.textOverflow = "ellipsis";
          }
          chip.append(span);
        }
        chip.prepend(image, fallback);
        const railSlot = document.createElement("div");
        railSlot.dataset.tickerRailSlot = "true";
        railSlot.className = "scanpnl-ticker-rail relative h-full shrink-0";
        const sellButton = document.createElement("button");
        sellButton.type = "button";
        sellButton.dataset.scanpnlAction = "tickerSell";
        sellButton.dataset.scanpnlMint = position.mint;
        sellButton.setAttribute("aria-label", "Paper sell 100% " + position.name);
        sellButton.title = "Sell 100%";
        const nativeRailButton = nativeChip?.querySelector("[data-ticker-rail] button");
        sellButton.className =
          nativeRailButton?.className ||
          "flex h-full items-center justify-center rounded-[4px] px-[4px] text-decrease hover:bg-primaryStroke/40";
        if (nativeRailButton)
        {
          for (const node of nativeRailButton.childNodes) sellButton.append(node.cloneNode(true));
        }
        else
        {
          const icon = document.createElement("i");
          icon.className = "ri-arrow-up-line flex items-center text-[14px] leading-[18px]";
          sellButton.append(icon);
        }
        const railClip = document.createElement("div");
        railClip.dataset.tickerRailClip = "true";
        railClip.className = "absolute inset-y-0 left-0 z-10 overflow-clip";
        const rail = document.createElement("div");
        rail.dataset.tickerRail = "true";
        rail.className = "flex h-full flex-row items-center gap-[4px]";
        rail.append(sellButton);
        railClip.append(rail);
        railSlot.append(railClip);
        chip.append(railSlot);
        paperStrip.append(chip);
      }
      chip.href = ScanPNLAccount.safeUrl(position.url, position.mint);
      const image = chip.querySelector('[data-part="image"]'),
        fallback = chip.querySelector('[data-part="fallback"]');
      if (position.image && image.getAttribute("src") !== position.image)
      {
        image.src = position.image;
        image.style.display = "";
        fallback.style.display = "none";
      }
      else if (!position.image)
      {
        image.style.display = "none";
        fallback.style.display = "inline-flex";
      }
      chip.querySelector('[data-part="name"]').textContent =
        position.name.length > 8 ? position.name.slice(0, 5) + "\u2026" : position.name;
      const solUsd = quote?.solUsd || account.solUsd || position.solUsd,
        stats = shownMetrics(position, solUsd),
        usd = currencyMode === "USD";
      const amountSpan = chip.querySelector('[data-part="amount"]');
      let solIcon = chip.querySelector('[data-part="sol"]');
      if (!solIcon)
      {
        const solImage = native('img[alt="SOL"]')[0];
        if (solImage?.tagName === "IMG")
        {
          solIcon = solImage.cloneNode(true);
          solIcon.dataset.part = "sol";
          solIcon.width = 12;
          solIcon.height = 12;
          chip.insertBefore(solIcon, amountSpan);
        }
      }
      if (solIcon) solIcon.style.display = usd ? "none" : "";
      formatted(
        amountSpan,
        (usd ? "$" : "") + (usd ? compact : fmt)(stats.holding * (usd ? solUsd : 1)),
      );
      const pctSpan = chip.querySelector('[data-part="pct"]');
      pctSpan.textContent = percent(stats.pct) + "%";
      pctSpan.style.cssText =
        "display:inline!important;visibility:visible!important;opacity:1!important;color:" +
        pnlColor(stats.pnl);
      chip.title = position.name + " \xb7 " + (position.quoteStatus || "last observed");
    }
  }

  // replaces axiom's positions table on the token page with the paper positions
  function positions(quote)
  {
    if (!ScanPNLCore.tokenRoute(location.pathname)) return;
    for (const [original, copy] of clonePairs)
    {
      if (
        original.closest(
          '.global-modal-overlay,[role="dialog"],[class*="bg-scannerModalBackground"]',
        ) &&
        copy.querySelector?.(".scanpnl-position,.scanpnl-empty")
      )
      {
        copy.remove();
        original.removeAttribute("data-scanpnl-hidden");
        clonePairs.delete(original);
      }
    }
    const external = (element) =>
      element?.closest(
        '.global-modal-overlay,[role="dialog"],[class*="bg-scannerModalBackground"]',
      );
    const labels = (row) =>
      [...row.children]
        .filter((cell) => !cell.hasAttribute("data-scanpnl-owned"))
        .map((cell) => cell.textContent.trim());
    let header = positionsScroll?.header;
    if (!header?.isConnected || !header.getClientRects().length || external(header))
    {
      header = native('div,[role="row"],tr').find((row) =>
      {
        // cheap checks first: a header row has 6-9 cells
        if (row.childElementCount < 6) return false;
        const cellLabels = labels(row),
          text = cellLabels.join(" ").toLowerCase();
        return (
          cellLabels.length >= 6 &&
          cellLabels.length <= 9 &&
          text.length < 180 &&
          ["token", "bought", "sold", "remaining", "pnl", "action"].every((word) =>
            text.includes(word),
          ) &&
          !external(row) &&
          row.getClientRects().length > 0
        );
      });
    }
    if (!header)
    {
      document.documentElement.dataset.scanpnlPositions = "native header not found";
      return;
    }
    let node = header.parentElement,
      body =
        positionsScroll?.header === header && positionsScroll.scroll?.isConnected
          ? positionsScroll.scroll
          : undefined;
    for (let depth = 0; !body && node && depth < 3; depth++, node = node.parentElement)
    {
      body = [...node.querySelectorAll('div.overflow-y-auto,[role="rowgroup"],tbody')].find(
        (candidate) => !candidate.contains(header) && !candidate.closest("[data-scanpnl-owned]"),
      );
      if (body) break;
    }
    if (!body)
    {
      document.documentElement.dataset.scanpnlPositions = "native body not found";
      return;
    }
    positionsScroll = {
      header,
      scroll: body,
    };
    const table = clone(body),
      columnLabels = labels(header),
      solUsd = quote?.solUsd || account.solUsd;
    table.style.minHeight = "72px";
    table.style.position = "relative";
    if (Date.now() < positionsClickUntil) return;
    const signature = JSON.stringify([
      Object.values(account.positions)
        .filter((position) => position.qty > 0)
        .map((position) =>
        {
          const stats = shownMetrics(position, solUsd),
            convert = (amount) =>
              currencyMode === "USD" ? compact(amount * (solUsd || position.solUsd)) : fmt(amount);
          return [
            position.mint,
            position.name,
            position.image,
            compact(position.qty),
            ...[stats.bought, stats.sold, stats.holding, stats.pnl].map(convert),
            percent(stats.pct),
            position.quoteStatus,
          ];
        }),
      account.trades.length,
      currencyMode,
      columnLabels,
    ]);
    if (table.dataset.signature === signature) return;
    table.dataset.signature = signature;
    table.replaceChildren();
    const open = Object.values(account.positions).filter((position) => position.qty > 0);
    if (!open.length)
    {
      const empty = document.createElement("div");
      empty.className = "scanpnl-empty";
      empty.textContent = "No open paper positions";
      table.append(empty);
      return;
    }
    const widths = [...header.children]
      .filter((cell) => !cell.hasAttribute("data-scanpnl-owned"))
      .map((cell) => cell.getBoundingClientRect().width);
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    for (const position of open)
    {
      const stats = shownMetrics(position, solUsd),
        row = document.createElement("div");
      row.className = "scanpnl-position";
      row.dataset.scanpnlPosition = position.mint;
      if (typeof getComputedStyle === "function")
      {
        typography(header, row);
        row.style.fontSize = "14px";
        row.style.lineHeight = "20px";
      }
      row.style.gridTemplateColumns =
        totalWidth > 0
          ? widths.map((width) => `${(Math.max(1, width) / totalWidth) * 100}%`).join(" ")
          : `repeat(${columnLabels.length},minmax(0,1fr))`;
      const fills = account.trades.filter((fill) => fill.mint === position.mint),
        tokensBought = fills
          .filter((fill) => fill.side === "buy")
          .reduce((sum, fill) => sum + fill.qty, 0),
        tokensSold = fills
          .filter((fill) => fill.side === "sell")
          .reduce((sum, fill) => sum + fill.qty, 0);
      const usd = currencyMode === "USD",
        value = (amount) => (usd ? "$" : "") + fmt(amount * (usd ? solUsd || position.solUsd : 1));
      for (const column of columnLabels)
      {
        const cell = document.createElement("div");
        cell.className = "scanpnl-cell";
        const name = column.toLowerCase();
        if (name.includes("token"))
        {
          const link = document.createElement("a");
          link.href = ScanPNLAccount.safeUrl(position.url, position.mint);
          link.className = "scanpnl-token";
          const avatar = document.createElement("span");
          avatar.textContent = (position.ticker || position.name || "?").slice(0, 1);
          avatar.className = "scanpnl-avatar";
          link.append(avatar);
          if (position.image)
          {
            const image = document.createElement("img");
            image.src = position.image;
            image.alt = "";
            image.width = 28;
            image.height = 28;
            image.onload = () =>
            {
              avatar.style.display = "none";
            };
            image.onerror = () =>
            {
              image.style.display = "none";
              avatar.style.display = "inline-flex";
            };
            link.append(image);
          }
          const names = document.createElement("span"),
            ticker = document.createElement("span"),
            mintText = document.createElement("small");
          ticker.textContent = position.ticker || position.name;
          mintText.textContent = position.mint.slice(0, 5) + "\u2026" + position.mint.slice(-4);
          names.append(ticker, mintText);
          link.append(names);
          cell.append(link);
        }
        else if (name.includes("action"))
        {
          const link = document.createElement("a");
          link.href = ScanPNLAccount.safeUrl(position.url, position.mint);
          link.textContent = "Open token";
          cell.append(link);
        }
        else if (name.includes("opened"))
        {
          cell.textContent = fills[0] ? new Date(fills[0].at).toLocaleTimeString() : "\u2014";
        }
        else
        {
          const valueBox = document.createElement("span"),
            note = document.createElement("small");
          valueBox.className = "scanpnl-value";
          let amount = name.includes("bought")
            ? stats.bought
            : name.includes("sold")
              ? stats.sold
              : name.includes("remaining")
                ? stats.holding
                : stats.pnl;
          if (!usd)
          {
            const solImage = native('img[alt="SOL"]')[0];
            if (solImage) valueBox.append(solImage.cloneNode(true));
          }
          const text = document.createElement("span");
          formatted(
            text,
            value(amount) + (name.includes("pnl") ? " (" + percent(stats.pct) + "%)" : ""),
          );
          valueBox.append(text);
          cell.append(valueBox);
          if (name.includes("pnl"))
          {
            tone(valueBox, amount);
            note.textContent = position.quoteStatus === "fresh" ? "" : "Stale / unavailable quote";
          }
          else if (name.includes("remaining"))
          {
            note.textContent = compact(position.qty) + " " + (position.ticker || position.name);
            cell.title =
              "Average remaining cost: " +
              ScanPNLCore.displayNumber(position.basis / position.qty) +
              " SOL/token";
          }
          else
          {
            note.textContent =
              compact(name.includes("bought") ? tokensBought : tokensSold) +
              " " +
              (position.ticker || position.name);
          }
          cell.append(note);
        }
        row.append(cell);
      }
      table.append(row);
    }
    document.documentElement.dataset.scanpnlPositions = "open positions rendered";
  }

  // hooks axiom's share pnl button to the paper position
  function nativeShare(quote)
  {
    document
      .querySelectorAll("[data-scanpnl-card-trigger],[data-scanpnl-position-card]")
      .forEach((trigger) => trigger.remove());
    if (!quote || !account.positions[quote.mint]) return;
    const shareButton = native("button").find((button) => button.textContent.includes("Share PnL"));
    if (shareButton)
    {
      document.querySelector("[data-scanpnl-share-trigger]")?.remove();
      const copy = clone(shareButton);
      copy.dataset.scanpnlAction = "share";
    }
    else if (!document.querySelector("[data-scanpnl-share-trigger]"))
    {
      const alertButton = native("button").find(
        (button) => button.getAttribute("aria-label") === "Send Alert To Lobby",
      );
      if (alertButton)
      {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.dataset.scanpnlOwned = "";
        trigger.dataset.scanpnlShareTrigger = "";
        trigger.dataset.scanpnlAction = "share";
        trigger.className =
          "flex flex-row items-center justify-center gap-[4px] text-increase transition-colors duration-[125ms] hover:text-increaseHover";
        const icon = document.createElement("i");
        icon.className = "ri-share-2-line text-[16px]";
        const label = document.createElement("span");
        label.className = "hidden text-nowrap text-[12px] font-medium leading-[16px] 2xl:block";
        label.textContent = "Share PnL";
        trigger.append(icon, label);
        alertButton.before(trigger);
      }
    }

    // the share card shows the same round as the panel
    const [sharePosition, shareTrades] = shown(account.positions[quote.mint]);
    window.postMessage(
      {
        type: "scanpnl-position-v1",
        mint: quote.mint,
        position: sharePosition,
        shareRank: account.preferences.shareRank,
        trades: shareTrades,
        solUsd: quote.solUsd || account.solUsd,
        restoreShare: shareMint === quote.mint,
      },
      location.origin,
    );
  }

  // "ScanPNL" chip on Axiom's instant-trade panel, so it is clear the extension is running
  // it. page.css anchors it to the panel (CSS anchor positioning), so it follows drags with
  // no script work; here it is only created and shown while a panel is on screen.
  const LOGO =
    '<svg viewBox="0 0 512 512" aria-hidden="true"><rect x="44" y="44" width="424" height="424" rx="116" fill="#4c535d" stroke="#090b0e" stroke-width="16"/><path d="M118 314L220 202L293 272L397 170" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="square"/></svg>';
  // the scanpnl chip on axiom's instant-trade panel
  function indicator()
  {
    let chip = document.getElementById("scanpnl-chip");
    if (!chip)
    {
      chip = document.createElement("div");
      chip.id = "scanpnl-chip";
      chip.dataset.scanpnlOwned = "";
      chip.setAttribute("role", "status");
      chip.setAttribute("aria-label", "ScanPNL is running this trade panel");
      chip.innerHTML = LOGO + "<span>ScanPNL</span>";
      document.documentElement.append(chip);
    }
    chip.hidden = !native(".buy-click-container").some((panel) => panel.getClientRects().length);
  }

  // renders once, 100 ms after the last request
  function scheduleRender()
  {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() =>
    {
      renderScheduled = false;
      render();
      if (nativeQuote)
      {
        document.documentElement.dataset.scanpnlRenderLatency = String(Date.now() - nativeQuote.at);
      }
    }, 100);
  }

  // messages from the page scripts: prices, share state, quotes, formatted numbers, errors
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    if (
      event.data?.type === "scanpnl-sol-price-v1" &&
      Number.isFinite(event.data.usd) &&
      event.data.usd > 0
    )
    {
      streamSolUsd = event.data.usd;
    }
    if (event.data?.type === "scanpnl-portfolio-tick-v1" && account?.preferences.paperEnabled)
    {
      const tick = event.data,
        position = account.positions[tick.mint];
      let pageQuote;
      try
      {
        pageQuote = getQuote();
      }
      catch {}
      const solUsd = pageQuote?.solUsd || account.solUsd || position?.solUsd;
      if (
        pageQuote?.mint === tick.mint &&
        Number.isFinite(tick.usd) &&
        tick.usd > 0 &&
        solUsd > 0 &&
        Math.abs(Date.now() - tick.at) < 5000
      )
      {
        nativeQuote = {
          ...pageQuote,
          usd: tick.usd,
          solUsd,
          at: tick.at,
          source: "axiom-stream",
        };
        scheduleRender();
      }
      if (Number.isFinite(tick.usd) && tick.usd > 0 && Math.abs(Date.now() - tick.at) < 5000)
      {
        streamPrices.set(tick.mint, {
          usd: tick.usd,
          at: tick.at,
        });
        if (streamPrices.size > 200) streamPrices.delete(streamPrices.keys().next().value);
      }
      if (
        position?.qty > 0 &&
        !(position.quoteSource === "axiom-chart" && Date.now() - position.at < 5000) &&
        tick.at > (position.at || 0) &&
        Number.isFinite(tick.usd) &&
        tick.usd > 0 &&
        solUsd > 0 &&
        Math.abs(Date.now() - tick.at) < 5000
      )
      {
        const mark = {
          mint: position.mint,
          name: position.name,
          usd: tick.usd,
          solUsd,
          at: tick.at,
          url: position.url,
          image: position.image,
        };
        Object.assign(position, mark, {
          quoteStatus: "fresh",
          quoteSource: "axiom-stream",
        });
        scheduleRender();
        pendingMarks.set(position.mint, mark);
        if (!marksTimer)
        {
          marksTimer = setTimeout(() =>
          {
            marksTimer = undefined;
            const marks = [...pendingMarks.values()];
            pendingMarks.clear();
            chrome.runtime
              .sendMessage({
                type: "marks",
                quotes: marks,
              })
              .catch(() => {});
          }, 250);
        }
      }
    }
    if (event.data?.type === "scanpnl-share-state-v1" && account?.preferences.paperEnabled)
    {
      const state = event.data;
      if (typeof state.mint === "string" && account.positions[state.mint])
      {
        shareMint = state.open ? state.mint : undefined;
        chrome.storage.local
          .set({
            paperUi: {
              accountId: account.accountId,
              shareOpen: !!state.open,
              shareMint: state.mint,
            },
          })
          .catch(() => {});
      }
    }
    if (event.data?.type === "scanpnl-quote-v1")
    {
      try
      {
        const quote = event.data.quote;
        ScanPNLCore.quote(quote);
        if (!nativeQuote || quote.mint !== nativeQuote.mint || quote.at >= nativeQuote.at)
        {
          // a heartbeat with an unchanged price only refreshes freshness, without a re-render
          const moved =
            !nativeQuote ||
            quote.mint !== nativeQuote.mint ||
            quote.usd !== nativeQuote.usd ||
            quote.solUsd !== nativeQuote.solUsd;
          nativeQuote = quote;
          if (moved) scheduleRender();
        }
      }
      catch {}
    }
    if (event.data?.type === "scanpnl-formatted-v1" && Array.isArray(event.data.results))
    {
      let changed = false;
      for (const result of event.data.results.slice(0, 200))
      {
        if (!Array.isArray(result)) continue;
        const [value, text] = result;
        if (
          !Number.isFinite(value) ||
          typeof text !== "string" ||
          !/^[+-]?[0-9.,]+[KMBT]$/i.test(text)
        )
        {
          continue;
        }
        if (nativeFormats.get(value) === text) continue;
        nativeFormats.set(value, text);
        changed = true;
        if (nativeFormats.size > 256) nativeFormats.delete(nativeFormats.keys().next().value);
      }
      if (changed) scheduleRender();
    }
    if (event.data?.type === "scanpnl-error-v1") notice(event.data.error);
    if (event.data?.type === "scanpnl-guard-blocked-v1" && Date.now() > blockedNoticeAt)
    {
      blockedNoticeAt = Date.now() + 4000;
      notice("ScanPNL blocked a real Axiom transaction. No funds moved.");
    }
  });

  // when the next blocked-request notice may show, and the price last sent to the background
  let blockedNoticeAt = 0,
    markedUsd;
  // portfolio page: paper wallet selected, axiom's wallet button and the chosen period
  let portfolioPaper = true,
    walletButton,
    portfolioPeriod = "allTime";
  // axiom's period buttons (1d, 7d, 30d, max) choose the paper portfolio period
  document.addEventListener(
    "click",
    (event) =>
    {
      if (location.pathname !== "/portfolio" || !portfolioPaper) return;
      const period = {
        "1d": "oneDay",
        "7d": "sevenDay",
        "30d": "thirtyDay",
        Max: "allTime",
      }[event.target.closest?.("button")?.textContent.trim()];
      if (period)
      {
        portfolioPeriod = period;
        scheduleRender();
      }
    },
    true,
  );
  // axiom elements copied on the portfolio page
  const portfolioOriginals = new Set();
  // the portfolio wallet choice is remembered
  chrome.storage.local.get("scanpnlPortfolioSelected").then((stored) =>
  {
    portfolioPaper = stored.scanpnlPortfolioSelected !== false;
    scheduleRender();
  });

  // a paper copy made on the portfolio page (removed when leaving it)
  function portfolioClone(element)
  {
    if (!element) return;
    portfolioOriginals.add(element);
    return clone(element);
  }

  // removes every paper copy made on the portfolio page
  function clearPortfolio()
  {
    for (const original of portfolioOriginals)
    {
      const copy = clonePairs.get(original);
      copy?.remove();
      original.removeAttribute("data-scanpnl-hidden");
      clonePairs.delete(original);
    }
    portfolioOriginals.clear();
  }

  // chooses the paper wallet (or axiom's real one) on the portfolio page
  function selectPortfolio(paper)
  {
    portfolioPaper = paper;
    chrome.storage.local.set({
      scanpnlPortfolioSelected: paper,
    });
    clearPortfolio();
    if (positionsScroll?.scroll)
    {
      const body = positionsScroll.scroll;
      clonePairs.get(body)?.remove();
      clonePairs.delete(body);
      body.removeAttribute("data-scanpnl-hidden");
    }
    render();
  }

  // adds the scanpnl wallet to axiom's portfolio page and sends the paper portfolio to the page script
  function portfolioView(quote)
  {
    if (location.pathname !== "/portfolio")
    {
      clearPortfolio();
      window.postMessage(
        {
          type: "scanpnl-portfolio-v1",
          enabled: false,
          revision: "off",
        },
        location.origin,
      );
      return;
    }

    // axiom's wallet selector, found by structure (wallets can have any name): a dropdown button
    // whose row shows a sol balance
    const walletSelector = (button) =>
    {
      if (!button.querySelector("i.ri-arrow-down-s-line")) return false;
      const row = button.parentElement?.parentElement?.parentElement?.parentElement;
      return (
        !!row &&
        [...row.querySelectorAll("span")].some(
          (span) =>
            span.classList.contains("text-[16px]") &&
            span.parentElement?.querySelector('img[alt="Solana"],img[alt="SOL"]'),
        )
      );
    };
    const selector =
      (walletButton?.isConnected ? walletButton : undefined) ||
      native("button").find(walletSelector) ||
      native("button").find((button) => button.textContent.trim().startsWith("All Wallets"));
    if (selector)
    {
      walletButton = selector;
      // its label is the first text span in the button
      const labelSpan = [...selector.querySelectorAll("span")].find(
        (span) => !span.children.length && span.textContent.trim(),
      );
      if (labelSpan && portfolioPaper) formatted(portfolioClone(labelSpan), "scanpnl.");
      const selectAll = native("button").find(
        (button) =>
          button.textContent.trim() === "Unselect All" ||
          button.textContent.trim() === "Select All",
      );
      if (selectAll)
      {
        const header = selectAll.parentElement?.parentElement,
          menu = header?.parentElement,
          list = menu?.querySelector(".overflow-y-auto");
        let choice = list?.querySelector("[data-scanpnl-wallet-choice]");
        if (list && !choice)
        {
          const template = [...list.children].find(
            (row) => row.getAttribute("role") === "presentation",
          );
          if (template)
          {
            choice = template.cloneNode(true);
            choice.dataset.scanpnlOwned = "";
            choice.dataset.scanpnlWalletChoice = "";
            choice.dataset.scanpnlAction = "portfolioWallet";
            choice.setAttribute("role", "option");
            choice.tabIndex = 0;
            const nameSpan = choice.querySelector("span.text-nowrap");
            if (nameSpan)
            {
              nameSpan.textContent = "scanpnl.";
              const next = nameSpan.nextElementSibling;
              if (next) next.replaceChildren();
            }
            choice.querySelectorAll("button").forEach((button) => button.remove());
            const choose = (event) =>
            {
              event.preventDefault();
              event.stopImmediatePropagation();
              selectPortfolio(!portfolioPaper);
            };
            choice.addEventListener("click", choose);
            choice.addEventListener("keydown", (event) =>
            {
              if (event.key === "Enter" || event.key === " ") choose(event);
            });
            list.prepend(choice);
          }
        }
        if (choice)
        {
          choice.setAttribute("aria-selected", String(portfolioPaper));
          const ring = choice.querySelector(".toggle-ring"),
            dot = ring?.firstElementChild;
          if (ring)
          {
            ring.classList.toggle("border-primaryBlue", portfolioPaper);
            ring.classList.toggle("border-secondaryStroke", !portfolioPaper);
          }
          if (dot)
          {
            dot.style.removeProperty("opacity");
            dot.classList.toggle("bg-primaryBlue", portfolioPaper);
            dot.classList.toggle("bg-transparent", !portfolioPaper);
          }

          // paper balance and open positions in the scanpnl row
          for (const span of valueSpans(choice))
          {
            formatted(
              span,
              span.parentElement.querySelector('img[alt="SOL"],img[alt="Solana"]')
                ? fmt(account.balance)
                : String(
                  Object.values(account.positions).filter((position) => position.qty > 0).length,
                ),
            );
          }
        }

        // while the scanpnl wallet is selected, axiom's wallets show as unselected (page styles)
        list?.toggleAttribute("data-scanpnl-paper-on", portfolioPaper);
        if (menu && !menu.dataset.scanpnlSelectionListener)
        {
          menu.dataset.scanpnlSelectionListener = "true";
          menu.addEventListener(
            "click",
            (event) =>
            {
              if (event.target.closest("[data-scanpnl-wallet-choice]")) return;
              const row = event.target.closest('[role="presentation"]');
              // picking a real wallet axiom already has selected only leaves paper mode; letting the click
              // through would unselect it in axiom
              if (portfolioPaper && row?.querySelector(".toggle-ring > div:not(.bg-transparent)"))
              {
                event.preventDefault();
                event.stopImmediatePropagation();
              }
              selectPortfolio(false);
            },
            true,
          );
        }
      }
    }
    if (!portfolioPaper)
    {
      clearPortfolio();
      window.postMessage(
        {
          type: "scanpnl-portfolio-v1",
          enabled: false,
          revision: "off",
        },
        location.origin,
      );
      return;
    }
    const walletRow = selector?.parentElement?.parentElement?.parentElement?.parentElement;
    if (walletRow)
    {
      for (const span of [...walletRow.querySelectorAll("span")].filter(
        (span) =>
          // value spans: small balances render as "0.0<sub>2</sub>4", so formatting children are fine,
          // icons and controls are not
          !span.querySelector("img,svg,i,div,button") &&
          span.classList.contains("text-[16px]") &&
          !span.closest('[aria-hidden="true"],[data-scanpnl-owned]'),
      ))
      {
        const box = span.parentElement,
          image = box?.querySelector("img"),
          badge = box?.querySelector("div.relative");
        if (image && ["Solana", "SOL"].includes(image.alt))
        {
          formatted(portfolioClone(span), fmt(account.balance));
        }
        else if (badge)
        {
          formatted(
            portfolioClone(span),
            String(Object.values(account.positions).filter((position) => position.qty > 0).length),
          );
        }
      }
    }
    const solUsd =
      quote?.solUsd ||
      account.solUsd ||
      Object.values(account.positions).find((position) => position.solUsd > 0)?.solUsd;
    const revision = JSON.stringify([
      portfolioPaper,
      account.accountId,
      account.trades.length,
      account.balance,
      account.pnlResetAt,
      account.pnlResets,
      portfolioPeriod,
      Object.values(account.positions).map((position) => [
        position.mint,
        position.qty,
        position.usd,
        position.solUsd,
      ]),
    ]);
    if (
      portfolioView.lastRevision === revision &&
      document.documentElement.dataset.scanpnlPortfolio === "paper"
    )
    {
      return;
    }
    portfolioView.lastRevision = revision;
    const bundle = ScanPNLPortfolio.nativeBundle(account, solUsd, Date.now(), portfolioPeriod);
    window.postMessage(
      {
        type: "scanpnl-portfolio-v1",
        enabled: true,
        bundle,
        shareRank: account.preferences.shareRank,
        revision,
      },
      location.origin,
    );
  }

  // updates every paper element on the page from the account
  function render()
  {
    if (!account || !document.body || document.visibilityState === "hidden") return;
    renderCache = new Map();
    try
    {
      if (publishedMode !== account.preferences.paperEnabled)
      {
        publishedMode = account.preferences.paperEnabled;
        window.postMessage(
          {
            type: "scanpnl-mode-v2",
            enabled: publishedMode,
          },
          location.origin,
        );
      }
      let pageQuote;
      try
      {
        pageQuote = getQuote()?.mint;
      }
      catch {}
      const watched = account.preferences.paperEnabled
        ? [
          ...new Set([
            ...Object.values(account.positions)
              .filter((position) => position.qty > 0)
              .map((position) => position.mint),
            ...quickBuys.keys(),
            ...(pageQuote ? [pageQuote] : []),
          ]),
        ].sort()
        : [];
      const watchedKey = JSON.stringify(watched);
      if (watchedKey !== subscribedKey)
      {
        subscribedKey = watchedKey;
        window.postMessage(
          {
            type: "scanpnl-portfolio-subscribe-v1",
            mints: watched,
          },
          location.origin,
        );
      }
      if (!account.preferences.paperEnabled)
      {
        document.querySelectorAll("[data-scanpnl-picker-hidden]").forEach((element) =>
        {
          delete element.dataset.scanpnlHidden;
          delete element.dataset.scanpnlPickerHidden;
        });
        for (const [original, copy] of clonePairs)
        {
          copy.remove();
          original.removeAttribute("data-scanpnl-hidden");
        }
        clonePairs.clear();
        document.querySelectorAll("[data-scanpnl-owned]").forEach((element) => element.remove());
        return;
      }
      indicator();
      for (const [original, copy] of clonePairs)
      {
        if (!original.isConnected)
        {
          copy.remove();
          clonePairs.delete(original);
        }
      }
      let quote, quoteError;
      try
      {
        quote = getQuote();
      }
      catch (error)
      {
        quoteError = error.message;
      }
      quote = displayQuote(quote);
      if (quote)
      {
        quote.image ||= native("img").find((image) => image.alt === quote.name)?.src;
        if (!quote.image)
        {
          let node = native('a[href*="solscan.io/token/"]')[0]?.parentElement;
          for (let depth = 0; node && depth < 6; depth++, node = node.parentElement)
          {
            const image = [...node.querySelectorAll("img")].find(
              (image) =>
                image.alt && !["SOL", "USDC", "Pump", "Pump AMM", "Raydium"].includes(image.alt),
            );
            if (image)
            {
              quote.image = image.src;
              break;
            }
          }
        }
      }
      if (
        quote &&
        account.positions[quote.mint] &&
        Number.isFinite(quote.usd) &&
        quote.usd > 0 &&
        Number.isFinite(quote.solUsd) &&
        quote.solUsd > 0 &&
        quote.at >= (account.positions[quote.mint].at || 0) &&
        Date.now() - quote.at < 5000
      )
      {
        Object.assign(account.positions[quote.mint], {
          usd: quote.usd,
          solUsd: quote.solUsd,
          at: quote.at,
          image: quote.image,
          quoteSource: quote.source || quote.quoteSource,
        });
      }
      const position = activePaperPosition(quote);
      const stats = shownMetrics(position, quote?.solUsd || account.solUsd || position?.solUsd);
      document.documentElement.dataset.scanpnlStatus = quoteError || "ready";
      accountBalances();
      accountDropdown();
      pnlCard(quote);
      paperWalletPicker();
      if (ScanPNLCore.tokenRoute(location.pathname))
      {
        quickPanel(quote, stats);
        relayNativeSettings();
        marketPanel(stats, quote);
        positions(quote);
        nativeShare(quote);
      }
      portfolioView(quote);
      tickerPositions(quote);
      const supply = quote?.supply || account.positions[quote?.mint]?.supply || 0;
      // axiom's "keep average entry after full close": off, the chart's average lines use only the
      // current round
      const keepEntry = axiomSetting("keepAverageEntryAfterFullClose") === true;
      // off the token page the chart scripts drop the token, so coming back must send the trades again
      if (!ScanPNLCore.tokenRoute(location.pathname)) chartKey = "";
      const chartKeyNext = JSON.stringify([
        quote?.mint,
        location.pathname,
        account.trades.length,
        account.trades.at(-1)?.at,
        supply,
        keepEntry,
      ]);
      if (quote && chartKeyNext !== chartKey)
      {
        chartKey = chartKeyNext;
        window.postMessage(
          {
            type: "scanpnl-chart-trades-v1",
            mint: quote.mint,
            route: location.pathname.split("/")[2],
            supply,
            solUsd: quote.solUsd || account.solUsd,
            trades: (keepEntry
              ? account.trades.filter((fill) => fill.mint === quote.mint)
              : ScanPNLCore.roundTrades(account.trades, quote.mint)
            ).map((fill) => ({
              mint: fill.mint,
              side: fill.side,
              at: fill.at,
              cash: fill.cash,
              fee: fill.fee,
              qty: fill.qty,
              usd: fill.usd,
              solUsd: fill.solUsd,
              supply: fill.supply,
            })),
          },
          location.origin,
        );
      }

      // the price goes to the background only when it moved, or every 10 s
      if (
        quote &&
        account.positions[quote.mint] &&
        !executing &&
        Date.now() - lastMarkAt > 1500 &&
        (quote.usd !== markedUsd || Date.now() - lastMarkAt > 10000)
      )
      {
        lastMarkAt = Date.now();
        markedUsd = quote.usd;
        chrome.runtime
          .sendMessage({
            type: "mark",
            quote,
          })
          .catch(() => {});
      }
    }
    finally
    {
      renderCache = undefined;
    }
  }

  // switches pnl between sol and usd
  function currency(mode)
  {
    currencyMode = mode === "USD" ? "USD" : "SOL";
    if (account?.preferences.paperEnabled)
    {
      window.postMessage(
        {
          type: "scanpnl-currency-v1",
          currency: currencyMode,
        },
        location.origin,
      );
    }
    render();
  }

  // account changes refresh at once; price-only changes at most every 3 s, since each refresh
  // copies the whole account into the page
  let marketRefresh;
  // reloads the account from the background and renders
  const refreshState = () =>
    send({
      type: "state",
    })
      .then(() =>
      {
        currencyMode = account.preferences.pnlCurrency;
        render();
      })
      .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) =>
  {
    if (area === "local" && changes.ledger) refreshState();
    else if (area === "session" && changes.market && !marketRefresh)
    {
      marketRefresh = setTimeout(() =>
      {
        marketRefresh = undefined;
        refreshState();
      }, 3000);
    }
  });

  // first load: the account, an open share card to restore, and the pnl currency
  send({
    type: "state",
  })
    .then(async () =>
    {
      const { paperUi: saved } = await chrome.storage.local.get("paperUi");
      if (
        saved?.accountId === account.accountId &&
        saved.shareOpen &&
        account.positions[saved.shareMint]
      )
      {
        shareMint = saved.shareMint;
      }
      else if (!saved)
      {
        const openMint = sessionStorage.getItem("scanpnlShareOpen");
        if (openMint && account.positions[openMint])
        {
          shareMint = openMint;
          await chrome.storage.local.set({
            paperUi: {
              accountId: account.accountId,
              shareOpen: true,
              shareMint: openMint,
            },
          });
        }
      }
      currency(account.preferences.pnlCurrency);
      render();
    })
    .catch((error) =>
    {
      if (document.body) notice("Paper account unavailable: " + error.message);
    });
  // renders twice a second, and refreshes the account every 30 s while the tab is visible
  setInterval(scheduleRender, 500);
  setInterval(() =>
  {
    if (document.visibilityState === "visible")
    {
      chrome.runtime
        .sendMessage({
          type: "refresh",
        })
        .then((reply) =>
        {
          if (reply.state)
          {
            adoptState(reply.state);
            render();
          }
        })
        .catch(() => {});
    }
  }, 30000);
  // a tab coming back refreshes prices
  document.addEventListener("visibilitychange", () =>
  {
    if (document.visibilityState === "visible")
    {
      chrome.runtime
        .sendMessage({
          type: "refresh",
        })
        .catch(() => {});
    }
  });

  // re-renders when axiom adds or removes elements (not on text changes)
  const observe = () =>
    new MutationObserver((mutations) =>
    {
      const relevant = mutations.some((mutation) =>
      {
        const target =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (target?.closest("[data-scanpnl-owned]")) return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) => !(node instanceof Element && node.hasAttribute("data-scanpnl-owned")),
        );
      });
      if (relevant) scheduleRender();
    }).observe(document.body, {
      // structure only: axiom's live text updates would render up to 10 times a second, and the
      // 500 ms render tick still catches text axiom rewrites
      childList: true,
      subtree: true,
    });
  // starts watching the page once it has a body
  if (document.body) observe();
  else
  {
    document.addEventListener("DOMContentLoaded", observe, {
      once: true,
    });
  }
})();
