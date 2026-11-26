// live usd prices for held tokens, from axiom's own price stream (runs in the page)
(() =>
{
  "use strict";

  // open price subscriptions by mint, and the sol price subscription
  const subscriptions = new Map();
  const runtimeSources = new Map();
  let wanted = new Set();
  let enabled = true;
  let client;
  let connecting;
  let solSubscription;

  // shows the stream state on the page for diagnosis
  const status = (text) => (document.documentElement.dataset.scanpnlStream = text);

  // the module and export a local binding of the runtime was imported from
  function importedAs(code, local, base)
  {
    const found = window.ScanPNLNativeRuntime.imports(code, base).get(local);
    if (!found) throw Error("Native stream binding changed: " + local);
    return found;
  }

  // the price client class and its transport in axiom's runtime module
  function bindings(code, base)
  {
    const at = code.indexOf(".subscribePriceUsd(");
    if (at < 0) throw Error("Native token quote client unavailable");
    const before = code.slice(Math.max(0, at - 1800), at);
    const creation = [...before.matchAll(/\b([\w$]+)=new\s+([\w$]+)\(([\w$]+)\(\)\)/g)].at(-1);
    if (!creation) throw Error("Native quote transport unavailable");
    return {
      client: importedAs(code, creation[2], base),
      transport: importedAs(code, creation[3], base),
    };
  }

  // creates axiom's price client from its sol runtime
  async function connect()
  {
    if (client || connecting || !enabled || !wanted.size) return connecting;
    const runtime = window.ScanPNLNativeRuntime;
    connecting = runtime
      .attempt("stream", async () =>
      {
        const assets = performance.getEntriesByType("resource").map((entry) => entry.name);
        let runtimeUrl = assets.find(
          (url) =>
            url.startsWith(location.origin + "/assets/sol-v2-runtime-") &&
            !url.includes("runtime-graph-") &&
            new URL(url).pathname.endsWith(".js"),
        );
        if (!runtimeUrl)
        {
          const bootUrl = assets.find(
            (url) =>
              url.startsWith(location.origin + "/assets/boot-app-") &&
              new URL(url).pathname.endsWith(".js"),
          );
          if (!bootUrl) throw Error("Waiting for native Solana runtime");
          runtimeUrl = (await runtime.ready(bootUrl, "sol-v2")).runtimeUrl;
        }
        if (!runtimeSources.has(runtimeUrl))
        {
          runtimeSources.set(
            runtimeUrl,
            runtime.source(runtimeUrl).catch((error) =>
            {
              runtimeSources.delete(runtimeUrl);
              throw error;
            }),
          );
        }
        const code = await runtimeSources.get(runtimeUrl);
        await runtime.fromSource(code, runtimeUrl);
        const found = bindings(code, runtimeUrl);
        const [clientModule, transportModule] = await Promise.all([
          import(runtime.resolve(found.client.url)),
          import(runtime.resolve(found.transport.url)),
        ]);
        client = new clientModule[found.client.key](transportModule[found.transport.key]());
        status("connected");
        sync();
      })
      .catch((error) => status(error.message))
      .finally(() => (connecting = undefined));
    return connecting;
  }

  // matches subscriptions to the wanted mints and forwards each price to the content script
  function sync()
  {
    for (const [mint, subscription] of subscriptions)
    {
      if (!enabled || !wanted.has(mint))
      {
        subscription.unsubscribe();
        subscriptions.delete(mint);
      }
    }
    if (!enabled || !wanted.size)
    {
      solSubscription?.unsubscribe();
      solSubscription = undefined;
      if (!enabled) return;
    }
    if (!client)
    {
      connect();
      return;
    }
    if (wanted.size && !solSubscription && typeof client.subscribeSolPriceUsd === "function")
    {
      solSubscription = client.subscribeSolPriceUsd(
        (price) =>
        {
          const usd = Number(price);
          if (enabled && usd > 0)
          {
            window.postMessage(
              { type: "scanpnl-sol-price-v1", usd, at: Date.now() },
              location.origin,
            );
          }
        },
        () => {},
      );
    }
    for (const mint of wanted)
    {
      if (subscriptions.has(mint)) continue;
      const subscription = client.subscribePriceUsd(
        mint,
        (price) =>
        {
          const usd = Number(price);
          if (!enabled || !wanted.has(mint) || !Number.isFinite(usd) || usd <= 0) return;
          status("live");
          window.postMessage(
            { type: "scanpnl-portfolio-tick-v1", mint, usd, at: Date.now() },
            location.origin,
          );
        },
        () => status("Invalid native quote frame"),
      );
      subscriptions.set(mint, subscription);
    }
  }

  if (typeof module !== "undefined") module.exports = { bindings };

  // paper mode on/off and the mints to follow, from the content script
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "scanpnl-mode-v2")
    {
      enabled = event.data.enabled !== false;
      sync();
    }
    if (event.data?.type === "scanpnl-portfolio-subscribe-v1")
    {
      wanted = new Set(
        (event.data.mints || [])
          .filter((mint) => typeof mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))
          .slice(0, 100),
      );
      sync();
    }
  });

  // retries the connection while prices are wanted
  setInterval(() =>
  {
    if (enabled && wanted.size && !client) connect();
  }, 1000);

  // closes subscriptions when the page goes away
  window.addEventListener("pagehide", () =>
  {
    solSubscription?.unsubscribe();
    for (const subscription of subscriptions.values()) subscription.unsubscribe();
    subscriptions.clear();
  });
})();
