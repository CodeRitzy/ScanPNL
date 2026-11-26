// shows paper orders with axiom's own transaction toasts (runs in the page)
(() =>
{
  "use strict";

  // axiom's toast service, loaded once, and the toast of each pending order
  let service;
  const toasts = new Map();

  // finds axiom's transaction toast service in the sol runtime graph module
  async function connect()
  {
    const runtime = window.ScanPNLNativeRuntime;
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (name) =>
          name.startsWith(location.origin + "/assets/sol-v2-runtime-graph-") &&
          new URL(name).pathname.endsWith(".js"),
      );
    if (!url) throw Error("Native transaction module is still loading");
    const code = await runtime.source(url);
    await runtime.fromSource(code, url);
    const local = code.match(/([\w$]+)\.txSuccess\(/)?.[1];
    const found = runtime.imports(code, url).get(local);
    if (found)
    {
      const toast = (await import(runtime.resolve(found.url)))[found.key];
      if (
        ["loadingWithTimer", "txSuccess", "txSellSuccess", "error"].every(
          (name) => typeof toast?.[name] === "function",
        )
      )
      {
        document.documentElement.dataset.scanpnlTransactions = "ready";
        return toast;
      }
    }
    throw Error("Native transaction notifications changed");
  }

  // the toast service, connecting on first use
  const toastService = () =>
    (service ||= window.ScanPNLNativeRuntime.attempt("transactions", connect).catch((error) =>
    {
      service = undefined;
      throw error;
    }));

  // notices and order progress from the content script
  window.addEventListener("message", (event) =>
  {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;

    // a plain error notice
    if (data?.type === "scanpnl-notice-v1")
    {
      if (typeof data.message !== "string" || !data.message.trim()) return;
      toastService()
        .then((toast) => toast.error(data.message.slice(0, 1000)))
        .catch((error) =>
        {
          document.documentElement.dataset.scanpnlTransactions = error.message;
        });
      return;
    }
    if (data?.type !== "scanpnl-transaction-v1") return;

    // an order's loading toast, then success or error on the same toast
    const { id, phase, side, error } = data;
    const wallets = Number.isInteger(data.count) ? Math.max(1, Math.min(20, data.count)) : 1;
    if (typeof id !== "string" || !["buy", "sell"].includes(side)) return;
    if (phase === "loading")
    {
      const text =
        wallets > 1
          ? `${side === "buy" ? "Buying" : "Selling"} tokens across ${wallets} wallets...`
          : side === "buy"
            ? "Buying tokens..."
            : "Selling tokens...";
      const pending = toastService().then((toast) => ({
        api: toast,
        toastId: toast.loadingWithTimer(text),
      }));
      toasts.set(id, pending);
      pending.catch((failure) =>
      {
        toasts.delete(id);
        document.documentElement.dataset.scanpnlTransactions = failure.message;
      });
    }
    else if (["confirmed", "error"].includes(phase) && toasts.has(id))
    {
      const pending = toasts.get(id);
      toasts.delete(id);
      pending
        .then(({ api, toastId }) =>
        {
          if (phase === "error") api.error(String(error || "Transaction failed"), { toastId });
          else
          {
            api[side === "buy" ? "txSuccess" : "txSellSuccess"](
              wallets > 1 ? `All ${wallets} transactions succeeded` : "Transaction Confirmed",
              { toastId },
            );
          }
        })
        .catch(() => {});
    }
  });

  // connects early so the first toast is quick
  const warmUp = setInterval(
    () =>
      toastService()
        .then(() => clearInterval(warmUp))
        .catch(() => {}),
    1000,
  );
})();
