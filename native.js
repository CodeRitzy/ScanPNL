// opens axiom's own share pnl card with the paper position (runs in the page)
(() =>
{
  "use strict";

  // the share-card binding (connected on first use), the paper position and the card shown
  let connection;
  let paper;
  let images;
  let summary;
  let showingPaper = false;
  let restoring = false;
  const modules = new Map();

  // posts a message to the content script
  const post = (type, data) => window.postMessage({ type, ...data }, location.origin);

  // binds to axiom's share modal state and its share-image generator
  async function connect()
  {
    const importMap = {};
    for (const script of document.querySelectorAll('script[type="importmap"]'))
    {
      try
      {
        Object.assign(importMap, JSON.parse(script.textContent).imports);
      }
      catch {}
    }
    const runtime = window.ScanPNLNativeRuntime;
    const assets = [
      ...new Set(performance.getEntriesByType("resource").map((entry) => entry.name)),
    ].filter(
      (url) =>
        url.startsWith(location.origin + "/assets/") && new URL(url).pathname.endsWith(".js"),
    );
    // loaded scripts by path (the first url per path wins)
    const byPath = new Map();
    for (const url of assets)
    {
      const path = new URL(url).pathname;
      if (!byPath.has(path)) byPath.set(path, url);
    }

    // the loaded url of a module, so it is not imported twice under another name
    const canonical = (url) =>
    {
      const resolved = runtime.resolve(url);
      return byPath.get(new URL(resolved).pathname) || resolved;
    };

    // modules whose path matches, the preferred ones first
    const candidates = (pattern, preferred) =>
      [
        ...new Set([
          ...assets.filter((url) => pattern.test(new URL(url).pathname)),
          ...Object.keys(importMap)
            .filter((key) => pattern.test(new URL(key, location.origin).pathname))
            .map((key) => canonical(new URL(key, location.origin).href)),
        ]),
      ].sort(
        (a, b) =>
          Number(preferred.test(new URL(b).pathname)) - Number(preferred.test(new URL(a).pathname)),
      );

    // every named import of a module: local name -> { key, url }
    const refs = (code, base) => runtime.imports(code, base);

    // the value an import points to, each module loaded once
    async function binding(found)
    {
      if (!found) throw Error("Native share binding changed");
      const url = canonical(found.url);
      if (!modules.has(url))
      {
        modules.set(
          url,
          import(url).catch((error) =>
          {
            modules.delete(url);
            throw error;
          }),
        );
      }
      return (await modules.get(url))[found.key];
    }

    const modalPattern =
      /case`position`:return\{isOpenAtom:([\w$]+),isLoadingAtom:[\w$]+,imageAtom:([\w$]+)\}/;
    // axiom's share-image call: `generatePnlImagesSolV2({position, pair, ...})` in current
    // builds, `({userTransactions, pair, ...})` in older ones
    const generatorPattern =
      /([\w$]+)\(\{(?:userTransactions|position):([\w$]+),pair:([\w$]+),lastTransaction:([\w$]+),tokenBalance:([\w$]+),usdPerSol:([\w$]+),([\s\S]{0,1800}?)onSuccess:/;

    // the first module whose source matches, checked 5 at a time
    async function findSource(urls, pattern, failure)
    {
      for (let start = 0; start < urls.length; start += 5)
      {
        const results = await Promise.all(
          urls.slice(start, start + 5).map(async (url) =>
          {
            try
            {
              const code = await runtime.source(url);
              return { url, code, match: code.match(pattern) };
            }
            catch
            {
              return null;
            }
          }),
        );
        const found = results.find((result) => result?.match);
        if (found) return found;
      }
      throw Error(failure);
    }

    const solV2 = window.ScanPNLTokenContext?.read()?.runtime !== "sol";
    const [modal, generator] = await Promise.all([
      findSource(
        candidates(/\/(?:ShareModal|shared)-/, /\/(?:ShareModal|shared-4)-/),
        modalPattern,
        "Native share modal source unavailable",
      ),
      findSource(
        candidates(/\/page-/, solV2 ? /\/page-(?!sol-)/ : /\/page-sol-/),
        generatorPattern,
        "Native share generator source unavailable",
      ),
    ]);

    // the share modal's store and atoms: open, image, summary (paper data) and currency
    const { url: modalUrl, code: modalCode } = modal;
    const modalImports = refs(modalCode, modalUrl);
    const atoms = modal.match;
    const summaryLocal = modalCode.match(/[\w$]+\(([\w$]+)\)\?\.currencyOverride/)?.[1];
    const currencyLocal = modalCode.match(
      /currencyOverride[\s\S]{0,160}?\?\?[\w$]+\(([\w$]+)\)/,
    )?.[1];
    if (!atoms || !summaryLocal || !currencyLocal) throw Error("Native share modal state changed");
    let store;
    for (const match of modalCode.matchAll(/(?:var|let|const)\s+([\w$]+)=([\w$]+)\(\),/g))
    {
      if (!modalImports.has(match[2]) || !modalCode.includes(match[1] + ".get(")) continue;
      const factory = await binding(modalImports.get(match[2]));
      if (typeof factory !== "function") continue;
      const candidate = factory();
      if (candidate?.get && candidate?.set && candidate?.sub)
      {
        store = candidate;
        break;
      }
    }
    if (!store) throw Error("Native share store unavailable");
    const [openAtom, imageAtom, summaryAtom, currencyAtom] = await Promise.all(
      [atoms[1], atoms[2], summaryLocal, currencyLocal].map((local) =>
        binding(modalImports.get(local)),
      ),
    );
    if (
      ![openAtom, imageAtom, summaryAtom, currencyAtom].every(
        (atom) => atom && typeof atom.read === "function",
      )
    )
    {
      throw Error("Native share atoms unavailable");
    }

    // the generator and the user's card preferences (template, colors, name, picture)
    const { url: pageUrl, code: pageCode, match: call } = generator;
    const pageImports = refs(pageCode, pageUrl);
    const generate = await binding(pageImports.get(call[1]));
    const before = pageCode.slice(Math.max(0, call.index - 6000), call.index);
    const prefs = {};
    if (typeof generate !== "function") throw Error("Native share generator binding changed");
    for (const name of [
      "username",
      "profilePicture",
      "template",
      "customTemplateUrl",
      "customTextColor",
      "customPositiveColor",
      "customNegativeColor",
      "showPnlRectangle",
      "pnlRectangleTextColor",
      "useBoldFont",
      "useHeavyTextShadows",
      "showTokenImage",
    ])
    {
      const local = call[7].match(new RegExp("(?:^|,)" + name + ":([\\w$]+)(?:,|$)"))?.[1];
      const escaped = local?.replace(/[$]/g, "\\$");
      const atomLocal =
        local && before.match(new RegExp("\\b" + escaped + "=[\\w$]+\\(([\\w$]+)\\)"))?.[1];
      if (atomLocal && pageImports.has(atomLocal))
      {
        prefs[name] = await binding(pageImports.get(atomLocal));
      }
    }

    // the rewards level shown on the card
    let rewards;
    const rewardsCall = call[7].match(/(?:^|,)rewardsLevel:([\w$]+)\(([\w$]+)\)(?:,|$)/);
    if (rewardsCall)
    {
      const escaped = rewardsCall[2].replace(/[$]/g, "\\$");
      const atomLocal = before.match(new RegExp("\\b" + escaped + "=[\\w$]+\\(([\\w$]+)\\)"))?.[1];
      if (atomLocal && pageImports.has(atomLocal) && pageImports.has(rewardsCall[1]))
      {
        rewards = {
          atom: await binding(pageImports.get(atomLocal)),
          format: await binding(pageImports.get(rewardsCall[1])),
        };
      }
    }

    // a rewards level from the store, else the one axiom cached
    function nativeRewards(value, format)
    {
      if (value != null) return format(value);
      try
      {
        const level = JSON.parse(localStorage.getItem("cached-rewards-level-sol"));
        if (Number.isInteger(level) && level >= 0 && level <= 8) return level;
      }
      catch {}
      return undefined;
    }

    // reads the rewards level; on sol-v2 its atom is found in the sol-v2 page module
    let solV2Rewards;
    async function readRewards(runtimeName)
    {
      if (rewards || runtimeName !== "sol-v2")
      {
        return rewards
          ? nativeRewards(store.get(rewards.atom), rewards.format)
          : nativeRewards(null, null);
      }
      if (!solV2Rewards)
      {
        const pages = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter(
            (url) =>
              url.startsWith(location.origin + "/assets/page-") && !url.includes("/page-sol-"),
          );
        for (const url of pages)
        {
          const code = await window.ScanPNLNativeRuntime.source(url);
          const rewardsMatch = code.match(/rewardsLevel:([\w$]+)\(([\w$]+)\)/);
          if (!rewardsMatch || !code.includes("generateSolV2TokenPnl")) continue;
          const imports = refs(code, url);
          const nearby = code.slice(Math.max(0, rewardsMatch.index - 6000), rewardsMatch.index);
          const escaped = rewardsMatch[2].replace(/[$]/g, "\\$");
          const assignments = [
            ...nearby.matchAll(new RegExp("\\b" + escaped + "=[\\w$]+\\(([\\w$]+)\\)", "g")),
          ];
          const atomLocal = assignments.at(-1)?.[1];
          if (atomLocal && imports.has(atomLocal) && imports.has(rewardsMatch[1]))
          {
            solV2Rewards = {
              atom: await binding(imports.get(atomLocal)),
              format: await binding(imports.get(rewardsMatch[1])),
            };
          }
          if (solV2Rewards) break;
        }
      }
      if (!solV2Rewards) return nativeRewards(null, null);
      return nativeRewards(store.get(solV2Rewards.atom), solV2Rewards.format);
    }

    // keeps the paper card in place while axiom's modal is open (currency switches re-render it)
    let pinning = false;
    function pinPaperShare()
    {
      if (pinning || !showingPaper || !images) return;
      pinning = true;
      try
      {
        const image = store.get(currencyAtom) === "USD" ? images.USD : images.NATIVE;
        if (image && store.get(imageAtom) !== image) store.set(imageAtom, image);
        if (summary && store.get(summaryAtom) !== summary) store.set(summaryAtom, summary);
      }
      finally
      {
        pinning = false;
      }
    }
    store.sub(currencyAtom, pinPaperShare);
    store.sub(imageAtom, pinPaperShare);
    store.sub(summaryAtom, pinPaperShare);

    // the modal closed: forget the paper card
    store.sub(openAtom, () =>
    {
      if (!store.get(openAtom))
      {
        const wasShowing = showingPaper;
        showingPaper = false;
        sessionStorage.removeItem("scanpnlShareOpen");
        if (wasShowing && paper) post("scanpnl-share-state-v1", { mint: paper.mint, open: false });
      }
    });
    document.documentElement.dataset.scanpnlShareBridge = "native share modal connected";
    return {
      store,
      generator: generate,
      prefs,
      rewards,
      readRewards,
      open: openAtom,
      image: imageAtom,
      summary: summaryAtom,
      currency: currencyAtom,
    };
  }

  // binding is expensive, so it happens only when the card is used, never on a timer;
  // `bound` is set once it has succeeded
  let bound;
  let shareCurrency;
  function api()
  {
    if (!connection)
    {
      connection = window.ScanPNLNativeRuntime.attempt("native", connect)
        .then((result) =>
        {
          bound = result;
          if (shareCurrency) result.store.set(result.currency, shareCurrency);
          return result;
        })
        .catch((error) =>
        {
          connection = null;
          document.documentElement.dataset.scanpnlShareBridge = error.message;
          throw error;
        });
    }
    return connection;
  }

  // generates the card images for the paper position and opens axiom's share modal with them
  async function share()
  {
    const token = window.ScanPNLTokenContext?.read();
    if (!token) throw Error("Waiting for the active token page quote");
    if (!paper?.position || paper.mint !== token.mint)
    {
      throw Error("Waiting for this token’s paper position");
    }
    const current = paper;
    const pair = token.pair;
    const transaction = token.lastTransaction;
    if (!transaction) throw Error("Waiting for the native token transaction snapshot");
    const card = await api();
    const rank = current.shareRank;
    let rewardsLevel = Number.isInteger(rank) && rank >= 1 && rank <= 8 ? rank : undefined;
    if (rewardsLevel === undefined)
    {
      try
      {
        rewardsLevel = await card.readRewards(token.runtime);
      }
      catch
      {
        try
        {
          const cached = JSON.parse(localStorage.getItem("cached-rewards-level-sol"));
          if (Number.isInteger(cached) && cached >= 0 && cached <= 8) rewardsLevel = cached;
        }
        catch {}
      }
    }

    // the token changed while loading
    if (paper?.mint !== current.mint || window.ScanPNLTokenContext?.read()?.mint !== current.mint)
    {
      return;
    }
    const preferences = Object.fromEntries(
      Object.entries(card.prefs).map(([name, atom]) => [name, card.store.get(atom)]),
    );
    const transactions = current.trades
      .filter((fill) => fill.mint === current.mint)
      .map((fill, index) => ({
        type: fill.side,
        total_sol: fill.cash,
        total_usd: fill.cash * fill.solUsd,
        token_amount: fill.qty,
        f: 0,
        created_at: new Date(fill.at).toISOString(),
        signature: "paper:" + (fill.id || index),
        totalSol: fill.cash,
        totalUsd: fill.cash * fill.solUsd,
        feesSol: 0,
      }));
    const position = current.position;
    const holding = (position.qty * token.quote.usd) / token.quote.solUsd;
    const pnl = position.sold + holding - position.bought;
    const pct = position.bought ? (pnl / position.bought) * 100 : 0;
    const cardSummary = {
      ticker: pair.tokenTicker,
      pnlAmountNative: `${pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toPrecision(4)} SOL`,
      pnlAmountUSD: `${pnl >= 0 ? "+" : "-"}$${(Math.abs(pnl) * token.quote.solUsd).toFixed(2)}`,
      isPositive: pnl >= 0,
      isPositiveNative: pnl >= 0,
      nativeToken: "sol",
      tokenImage: pair.tokenImage,
      statsNative: [
        { label: "PNL", value: pct.toFixed(2) + "%" },
        { label: "Invested", value: position.bought + " SOL" },
        { label: "Position", value: position.sold + holding + " SOL" },
      ],
      statsUSD: [
        { label: "PNL", value: pct.toFixed(2) + "%" },
        { label: "Invested", value: "$" + (position.bought * token.quote.solUsd).toFixed(2) },
        {
          label: "Position",
          value: "$" + ((position.sold + holding) * token.quote.solUsd).toFixed(2),
        },
      ],
    };

    // current generators read these totals; older ones read userTransactions, so both are sent
    const usdTotal = (side) =>
      transactions
        .filter((fill) => fill.type === side)
        .reduce((sum, fill) => sum + fill.total_usd, 0);
    await card.generator({
      ...preferences,
      rewardsLevel,
      pair,
      lastTransaction: transaction,
      riseCurveSupplemental: token.riseCurveSupplemental,
      position: {
        solSpent: position.bought,
        solReceived: position.sold,
        usdSpent: usdTotal("buy"),
        usdReceived: usdTotal("sell"),
      },
      userTransactions: transactions,
      tokenBalance: position.qty,
      usdPerSol: token.quote.solUsd,
      setShareIsLoading: () => {},
      generateSolV2TokenPnlToLobby: () => {},
      generateSolTokenPnlToLobby: () => {},
      onSuccess: (result) =>
      {
        if (window.ScanPNLTokenContext?.read()?.mint !== current.mint) return;
        images = result;
        summary = cardSummary;
        showingPaper = true;
        card.store.set(card.summary, summary);
        card.store.set(
          card.image,
          card.store.get(card.currency) === "USD" ? result.USD : result.NATIVE,
        );
        sessionStorage.setItem("scanpnlShareOpen", current.mint);
        post("scanpnl-share-state-v1", { mint: current.mint, open: true });
        card.store.set(card.open, true);
      },
      onError: (error) =>
      {
        throw error;
      },
    });
  }

  // account switches, currency, the paper position and share requests from the content script
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "scanpnl-account-changed-v1")
    {
      showingPaper = false;
      paper = undefined;
      images = undefined;
      summary = undefined;
      sessionStorage.removeItem("scanpnlShareOpen");
      bound?.store.set(bound.open, false);
    }
    if (event.data?.type === "scanpnl-currency-v1")
    {
      // remembered for the card; applied now only if already bound
      shareCurrency = event.data.currency === "USD" ? "USD" : "NATIVE";
      bound?.store.set(bound.currency, shareCurrency);
    }
    if (event.data?.type === "scanpnl-position-v1")
    {
      paper = event.data;
      // a card that was open before a reload opens again once
      if (!restoring && paper.restoreShare === true)
      {
        restoring = true;
        share().catch((error) =>
        {
          restoring = false;
          post("scanpnl-error-v1", { error: error.message });
        });
      }
    }
    if (event.data?.type === "scanpnl-share-v1")
    {
      share().catch((error) => post("scanpnl-error-v1", { error: error.message }));
    }
  });

  // axiom's template switch re-renders the paper card instead of the real one
  window.addEventListener(
    "pnl-template-changed",
    (event) =>
    {
      if (showingPaper)
      {
        event.stopImmediatePropagation();
        share().catch((error) => post("scanpnl-error-v1", { error: error.message }));
      }
    },
    true,
  );
})();
