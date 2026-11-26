// reads the open token's live price, supply and chart settings from axiom's own stores (runs in the page)
(() =>
{
  "use strict";

  // last sol price sent by the page scripts
  let broadcastSolUsd = 0;
  window.addEventListener("message", (event) =>
  {
    if (
      event.source === window &&
      event.origin === location.origin &&
      event.data?.type === "scanpnl-sol-price-v1" &&
      event.data.usd > 0
    )
    {
      broadcastSolUsd = event.data.usd;
    }
  });

  // sol price: the last broadcast, else axiom's footer ("$70.27" next to the sol icon)
  function solRate()
  {
    if (broadcastSolUsd > 0) return broadcastSolUsd;
    for (const image of document.querySelectorAll('img[alt="SOL"]'))
    {
      const button = image.closest("button");
      if (button && /^\s*\$[0-9,.]+\s*$/.test(button.textContent))
      {
        const price = Number(button.textContent.replace(/[^0-9.]/g, ""));
        if (price > 0) return price;
      }
    }
    return 0;
  }

  // loaded modules, the bindings for each token runtime, and the last published quote
  const modules = new Map();
  let v1;
  let v2;
  let connectingV1;
  let connectingV2;
  let quoteChangedAt = 0;
  let quoteKey = "";
  let lastTransaction;
  let context;
  let publishedKey = "";
  const chartModes = new Map();
  let heartbeat = 0;
  let averagesBusy = false;

  // shows the adapter state on the page for diagnosis
  const status = (text) => (document.documentElement.dataset.scanpnlTokenRuntime = text);
  const source = (url) => window.ScanPNLNativeRuntime.source(url);

  // every named import of a module: local name -> { key, url }
  const refs = (code, base) => window.ScanPNLNativeRuntime.imports(code, base);

  // the value an import points to, each module loaded once
  async function bind(found)
  {
    if (!found) throw Error("Native token binding changed");
    const url = window.ScanPNLNativeRuntime.resolve(found.url);
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

  // the atom a hook variable reads: `local=useAtom(atom)`
  function atomLocal(code, local)
  {
    const escaped = local.replace(/[$]/g, "\\$");
    return code.match(new RegExp("\\b" + escaped + "=[\\w$]+\\(([\\w$]+)\\)"))?.[1];
  }

  // the atom a getter function reads: `name=()=>get(atom)`
  function getterAtom(code, name)
  {
    const at = code.indexOf(name + "=");
    return at < 0 ? undefined : code.slice(at, at + 220).match(/=>[\w$]+\(([\w$]+)\)/)?.[1];
  }

  // the getter behind a chart preference such as `isMarketCap:getter()`
  function modeGetter(code, name)
  {
    const direct = code.match(new RegExp(name + ":([\\w$]+)\\(\\)"));
    if (direct) return direct[1];
    for (const match of code.matchAll(new RegExp(name + ":([\\w$]+)(?=[,}])", "g")))
    {
      const escaped = match[1].replace(/[$]/g, "\\$");
      const getter = [
        ...code
          .slice(0, match.index)
          .matchAll(new RegExp("\\b" + escaped + "=([\\w$]+)\\(\\)", "g")),
      ].at(-1)?.[1];
      if (getter) return getter;
    }
  }

  // binds to the older sol token page: its pair, transaction and price atoms and its price function
  async function connectV1()
  {
    const assets = performance.getEntriesByType("resource").map((entry) => entry.name);
    const pageUrl = assets.find(
      (url) =>
        url.startsWith(location.origin + "/assets/page-sol-") &&
        new URL(url).pathname.endsWith(".js"),
    );
    const datafeedUrl = assets.find(
      (url) => url.includes("/useTradingViewDatafeedSol-") && new URL(url).pathname.endsWith(".js"),
    );
    if (!pageUrl || !datafeedUrl) return;
    const pageCode = await source(pageUrl);
    const datafeedCode = await source(datafeedUrl);
    const pageImports = refs(pageCode, pageUrl);
    const datafeedImports = refs(datafeedCode, datafeedUrl);
    const snapshot = [
      ...pageCode.matchAll(
        /userTransactions:([\w$]+),pair:([\w$]+),lastTransaction:([\w$]+),tokenBalance:([\w$]+),usdPerNative:([\w$]+),currency:/g,
      ),
    ].find((match) =>
    {
      const before = pageCode.slice(Math.max(0, match.index - 3500), match.index);
      return [match[2], match[3], match[5]].every((local) =>
        pageImports.has(atomLocal(before, local)),
      );
    });
    if (!snapshot) throw Error("Native Sol token snapshot changed");
    const before = pageCode.slice(Math.max(0, snapshot.index - 3500), snapshot.index);
    const [pairAtom, txAtom, rateAtom] = await Promise.all(
      [snapshot[2], snapshot[3], snapshot[5]].map((local) =>
        bind(pageImports.get(atomLocal(before, local))),
      ),
    );
    let store;
    for (const match of pageCode.matchAll(/(?:var|let|const)\s+([\w$]+)=([\w$]+)\(\),/g))
    {
      if (!pageImports.has(match[2]) || !pageCode.includes(match[1] + ".get(")) continue;
      const factory = await bind(pageImports.get(match[2]));
      if (typeof factory !== "function") continue;
      const candidate = factory();
      if (candidate?.get && candidate?.sub && candidate?.set)
      {
        store = candidate;
        break;
      }
    }
    if (!store) throw Error("Native Sol store unavailable");
    const priceLocal = datafeedCode.match(
      /([\w$]+)\(\{pair:[\w$]+,lastTransaction:[\w$]+,usdPerSol:[\w$]+,supplementalData:/,
    )?.[1];
    const supplementalGetter = datafeedCode.match(/supplementalData:([\w$]+)\(\)/)?.[1];
    const price = await bind(datafeedImports.get(priceLocal));
    const supplemental = await bind(
      datafeedImports.get(getterAtom(datafeedCode, supplementalGetter)),
    );
    const capGetter = datafeedCode.match(/isMarketCap:([\w$]+)\(\)/)?.[1];
    const currencyGetter = datafeedCode.match(/currency:([\w$]+)\(\)/)?.[1];
    const capAtom = await bind(datafeedImports.get(getterAtom(datafeedCode, capGetter)));
    const currencyAtom = await bind(datafeedImports.get(getterAtom(datafeedCode, currencyGetter)));
    v1 = { store, pairAtom, txAtom, rateAtom, price, supplemental, capAtom, currencyAtom };
    modeFor("sol", store);
    for (const atom of [pairAtom, txAtom, rateAtom, supplemental, capAtom, currencyAtom])
    {
      store.sub(atom, () => read());
    }
    read();
  }

  // binds to the sol-v2 token page atoms in axiom's sol runtime
  async function connectV2()
  {
    const runtimeUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (url) =>
          url.startsWith(location.origin + "/assets/sol-v2-runtime-") &&
          !url.includes("runtime-graph-") &&
          new URL(url).pathname.endsWith(".js"),
      );
    if (!runtimeUrl) return;
    const code = await source(runtimeUrl);
    const imports = refs(code, runtimeUrl);
    await window.ScanPNLNativeRuntime.fromSource(code, runtimeUrl);
    const resolved = window.ScanPNLNativeRuntime.resolve(runtimeUrl);
    if (!modules.has(resolved)) modules.set(resolved, import(resolved));
    const sol = await modules.get(resolved);
    let store;
    for (const match of code.matchAll(/(?:var|let|const)\s+([\w$]+)=([\w$]+)\(\),/g))
    {
      if (!imports.has(match[2]) || !code.includes(match[1] + ".get(")) continue;
      const factory = await bind(imports.get(match[2]));
      if (typeof factory !== "function") continue;
      const candidate = factory();
      if (candidate?.get && candidate?.sub && candidate?.set)
      {
        store = candidate;
        break;
      }
    }
    if (!store) throw Error("Native Sol-V2 quote store unavailable");
    const atoms = [
      "tokenPageInfoAtomSolV2",
      "tokenPageCurrentPriceUsdAtomSolV2",
      "tokenPageCurrentPriceNativeAtomSolV2",
      "tokenPageCurrentSupplyAtomSolV2",
      "tokenPageLastBestPairTransactionAtomSolV2",
    ].map((name) => sol[name]);
    if (atoms.some((atom) => !atom)) throw Error("Native Sol-V2 quote bindings changed");
    v2 = { store, sol };
    for (const atom of atoms) store.sub(atom, readV2);
    modeFor("sol-v2", store);
    readV2();
  }

  // publishes the sol-v2 token page's price
  function readV2()
  {
    try
    {
      if (!v2) return;
      const { store, sol } = v2;
      const info = store.get(sol.tokenPageInfoAtomSolV2);
      if (!info || info.token?.tokenAddress !== routeMint()) return;
      // the older runtime owns pages whose pair it has loaded
      const pair = v1?.store.get(v1.pairAtom);
      if (pair?.pairAddress === location.pathname.split("/")[2]) return;
      const usd = Number(store.get(sol.tokenPageCurrentPriceUsdAtomSolV2));
      const native = Number(store.get(sol.tokenPageCurrentPriceNativeAtomSolV2));
      const supply = Number(store.get(sol.tokenPageCurrentSupplyAtomSolV2));
      const transaction = store.get(sol.tokenPageLastBestPairTransactionAtomSolV2);
      if (!(usd > 0 && native > 0)) return;
      publish(
        {
          runtime: "sol-v2",
          mint: info.token.tokenAddress,
          pair: sol.toMemePairSolV2(info),
          lastTransaction: transaction
            ? sol.toMemeTransactionSolV2(transaction, undefined, undefined)
            : null,
          quote: {
            mint: info.token.tokenAddress,
            name: info.token.tokenTicker,
            usd,
            solUsd: solRate(),
            supply: Number.isFinite(supply) && supply > 0 ? supply : 0,
          },
        },
        transaction,
      );
    }
    catch (error)
    {
      status(error.message);
    }
  }

  // axiom's average line settings (fees, colors) and its average price calculation
  async function averageSettings(runtime, store)
  {
    const prefix = runtime === "sol-v2" ? "ChartLinesManagerSolV2-" : "ChartLinesManagerSol-";
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("/" + prefix));
    if (!url || context?.runtime !== runtime) return;
    if (window.ScanPNLNativeAverages?.runtime === runtime) return;
    if (averagesBusy) return;
    averagesBusy = true;
    await window.ScanPNLNativeRuntime.attempt("averages:" + url, async () =>
    {
      const code = await source(url);
      const imports = refs(code, url);
      const atoms = {};
      for (const name of ["showFees", "averageBuyLineColor", "averageSellLineColor"])
      {
        const local = code.match(new RegExp(name + ":[a-zA-Z0-9_$]+\\(([a-zA-Z0-9_$]+)\\)"))?.[1];
        if (local && imports.has(local)) atoms[name] = await bind(imports.get(local));
      }
      const calculateLocal = code.match(
        /\{averageBuyPrice:[\w$]+,averageSellPrice:[\w$]+\}=([\w$]+)\(/,
      )?.[1];
      const calculate =
        runtime === "sol-v2" && calculateLocal && imports.has(calculateLocal)
          ? await bind(imports.get(calculateLocal))
          : undefined;
      window.ScanPNLNativeAverages = {
        runtime,
        calculate,
        read: () =>
          Object.fromEntries(Object.entries(atoms).map(([name, atom]) => [name, store.get(atom)])),
      };
    })
      .catch(() => {})
      .finally(() => (averagesBusy = false));
  }

  // reads the chart's currency and market-cap mode and axiom's trade marker style
  async function modeFor(runtime, store)
  {
    const prefix =
      runtime === "sol" ? "useTradingViewDatafeedSol-" : "useTradingViewDatafeedSolV2-";
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("/" + prefix) && new URL(name).pathname.endsWith(".js"));
    if (!url) return;
    averageSettings(runtime, store);
    const known = chartModes.get(url);
    if (known)
    {
      known.update();
      return;
    }
    if (chartModes.has(url)) return;
    chartModes.set(url, null);
    try
    {
      await window.ScanPNLNativeRuntime.attempt("mode:" + url, async () =>
      {
        const code = await source(url);
        const imports = refs(code, url);

        // a function returning the current value of one chart preference
        async function reader(name)
        {
          const getter = modeGetter(code, name);
          if (!getter) throw Error("Native chart preference unavailable: " + name);
          if (imports.has(getter))
          {
            const imported = await bind(imports.get(getter));
            if (typeof imported === "function") return () => imported();
          }
          const atomName = getterAtom(code, getter);
          if (!atomName || !imports.has(atomName))
          {
            throw Error("Native chart preference changed: " + name);
          }
          const atom = await bind(imports.get(atomName));
          return () => store.get(atom);
        }

        const [isMarketCap, currency] = await Promise.all([
          reader("isMarketCap"),
          reader("currency"),
        ]);
        const markerStyle = {};
        for (const [key, name] of Object.entries({
          buyColor: "userBuyColor",
          sellColor: "userSellColor",
          buyBorder: "userBuyBorder",
          sellBorder: "userSellBorder",
          size: "userBubbleSize",
        }))
        {
          markerStyle[key] = await reader(name);
        }
        const mode = () => ({ currency: currency(), marketCap: isMarketCap() === true });
        let styleKey;

        // republishes the quote with the current mode, and the marker style when it changed
        const update = () =>
        {
          if (context?.runtime === runtime)
          {
            context.mode = mode();
            publish(context, lastTransaction);
          }
          const style = Object.fromEntries(
            Object.entries(markerStyle).map(([key, read]) => [key, read()]),
          );
          const text = JSON.stringify(style);
          if (text !== styleKey)
          {
            styleKey = text;
            document.documentElement.dataset.scanpnlMarkerStyle = text;
            window.postMessage({ type: "scanpnl-marker-style-v1", style }, location.origin);
          }
        };
        chartModes.set(url, { runtime, mode, update });
        update();
      });
    }
    catch (error)
    {
      chartModes.delete(url);
      status(error.message);
    }
  }

  // the mint of the open token page, from its solscan link
  function routeMint()
  {
    return document
      .querySelector('a[href*="solscan.io/token/"]')
      ?.href.match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
  }

  // sends the open token's quote (and chart mode on change) to the other scripts
  function publish(next, transaction)
  {
    const mint = routeMint();
    if (!mint || next.mint !== mint) return false;
    const quote = next.quote;
    if (
      !Number.isFinite(quote.usd) ||
      quote.usd <= 0 ||
      !Number.isFinite(quote.solUsd) ||
      quote.solUsd <= 0
    )
    {
      return false;
    }
    const key = [next.runtime, mint, quote.usd, quote.solUsd].join("|");
    if (key !== quoteKey || transaction !== lastTransaction)
    {
      quoteChangedAt = Date.now();
      quoteKey = key;
      lastTransaction = transaction;
    }

    // stamped with the read time: a quiet token's unchanged price is still current
    quote.at = Date.now();
    quote.url = location.pathname + location.search;
    quote.source = "axiom-chart";
    quote.pairAddress = next.pair.pairAddress;
    // the launchpad name (e.g. "Pump AMM") lets the token tax be estimated
    quote.protocol ||= next.pair.protocol;
    const known = [...chartModes.values()].find((item) => item?.runtime === next.runtime);
    if (!next.mode && known) next.mode = known.mode();
    context = next;
    status(next.runtime);
    document.documentElement.dataset.scanpnlSupply = String(quote.supply || 0);
    const published = JSON.stringify([key, quoteChangedAt, quote.supply, quote.url, next.mode]);
    // an unchanged quote is re-sent once a second as a heartbeat; the chart mode only on change,
    // because it makes the chart lines redraw
    if (published === publishedKey && quote.at - heartbeat < 1000) return true;
    const changed = published !== publishedKey;
    publishedKey = published;
    heartbeat = quote.at;
    window.postMessage({ type: "scanpnl-quote-v1", quote }, location.origin);
    if (changed && next.mode)
    {
      window.postMessage({ type: "scanpnl-chart-mode-v1", mint, ...next.mode }, location.origin);
    }
    return true;
  }

  // publishes the older sol token page's price
  function read()
  {
    try
    {
      if (!v1) return;
      const binding = v1;
      const pair = binding.store.get(binding.pairAtom);
      const transaction = binding.store.get(binding.txAtom);
      const rate = Number(binding.store.get(binding.rateAtom));
      if (
        !pair ||
        pair.tokenAddress !== routeMint() ||
        pair.pairAddress !== location.pathname.split("/")[2]
      )
      {
        return;
      }
      const priceSol = Number(
        binding.price({
          pair,
          lastTransaction: transaction,
          usdPerSol: rate,
          supplementalData: binding.store.get(binding.supplemental),
        }),
      );
      publish(
        {
          runtime: "sol",
          mint: pair.tokenAddress,
          pair,
          lastTransaction: transaction,
          riseCurveSupplemental: binding.store.get(binding.supplemental),
          quote: {
            mint: pair.tokenAddress,
            name: pair.tokenTicker,
            usd: priceSol * rate,
            solUsd: rate,
            supply: Number(pair.supply),
          },
          mode: {
            currency: binding.store.get(binding.currencyAtom),
            marketCap: binding.store.get(binding.capAtom) === true,
          },
        },
        transaction,
      );
    }
    catch (error)
    {
      status(error.message);
    }
  }

  // the open token's latest context, for the share card and other page scripts
  window.ScanPNLTokenContext = {
    read: () =>
    {
      read();
      readV2();
      return context?.mint === routeMint() && context.quote.url?.split("?")[0] === location.pathname
        ? context
        : undefined;
    },
  };

  // paper mode switched on: publish right away
  window.addEventListener("message", (event) =>
  {
    if (
      event.source === window &&
      event.origin === location.origin &&
      event.data?.type === "scanpnl-mode-v2" &&
      event.data.enabled !== false
    )
    {
      read();
      readV2();
    }
  });

  // every second: re-read the stores (heartbeat for quiet tokens) and bind when not yet bound
  setInterval(() =>
  {
    read();
    readV2();
    if (v1) modeFor("sol", v1.store);
    if (v2) modeFor("sol-v2", v2.store);
    if (!v1 && !connectingV1)
    {
      connectingV1 = window.ScanPNLNativeRuntime.attempt("token-v1", connectV1)
        .catch((error) => status(error.message))
        .finally(() => (connectingV1 = undefined));
    }
    if (!v2 && !connectingV2)
    {
      connectingV2 = window.ScanPNLNativeRuntime.attempt("token-v2", connectV2)
        .catch((error) => status(error.message))
        .finally(() => (connectingV2 = undefined));
    }
  }, 1000);
})();
