// checks where each message comes from and sets up axiom pages: injects the page and content scripts
const ScanPNLRouter = (() =>
{
  // scripts that run in the page itself (execution-guard.js is registered separately at document_start)
  const MAIN_INJECT = [
    "native-runtime.js",
    "quick-buy.js",
    "pulse-quote.js",
    "portfolio-stream.js",
    "portfolio-native.js",
    "chart.js",
    "avg.js",
    "native-token.js",
    "native.js",
    "numbers.js",
    "transactions.js",
  ];

  // content scripts, in load order
  const ISOLATED_INJECT = [
    "core.js",
    "account.js",
    "safety-policy.js",
    "portfolio-model.js",
    "pnl-chart.js",
    "content.js",
  ];

  // requests the background answers
  const ALLOWED_TYPES = new Set([
    "state",
    "refresh",
    "prepare",
    "trade",
    "cancel",
    "mark",
    "marks",
    "sample",
    "nativePanelSettings",
    "createPaperWallet",
    "selectPaperWallets",
    "preferences",
    "balance",
    "resetPnl",
    "reset",
    "export",
    "import",
  ]);

  // true for the top frame of an axiom tab
  const page = (sender) =>
  {
    try
    {
      return !!(
        sender &&
        sender.id === chrome.runtime.id &&
        sender.frameId === 0 &&
        typeof sender.documentId === "string" &&
        Number.isInteger(sender.tab?.id) &&
        new URL(sender.url).origin === "https://axiom.trade" &&
        new URL(sender.tab.url).origin === "https://axiom.trade"
      );
    }
    catch
    {
      return false;
    }
  };

  // true for the extension popup
  const popup = (sender) =>
    sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");

  // injected documents by tab and document id, and one setup queue per document
  const documentKey = (sender) => `${sender.tab.id}:${sender.documentId}`;
  const documents = new Map();
  const queues = new Map();

  // runs setup steps for one document one at a time
  const queue = (sender, run) =>
  {
    const key = documentKey(sender);
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(run, run);
    queues.set(key, next);
    next
      .finally(() =>
      {
        if (queues.get(key) === next) queues.delete(key);
      })
      .catch(() => {});
    return next;
  };

  // forgets a document so the next bootstrap injects again
  const forgetDocument = async (sender) =>
  {
    documents.delete(documentKey(sender));
    const stored = await chrome.storage.session.get("scanpnl.documents");
    const all = stored["scanpnl.documents"] || {};
    if (all[documentKey(sender)] === sender.documentId)
    {
      delete all[documentKey(sender)];
      await chrome.storage.session.set({ "scanpnl.documents": all });
    }
  };

  // injects the scripts and styles into an axiom document once; reloads the tab if setup fails
  const inject = (sender) =>
    queue(sender, async () =>
    {
      if (!page(sender)) throw new Error("Invalid bootstrap source");
      const stored = await chrome.storage.session.get("scanpnl.documents");
      if (stored["scanpnl.documents"]?.[documentKey(sender)] === sender.documentId)
      {
        documents.set(documentKey(sender), sender.documentId);
        return { allowed: true };
      }
      const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
      try
      {
        // already set up (the worker restarted and lost its memory)
        const [probe] = await chrome.scripting.executeScript({
          target,
          world: "ISOLATED",
          injectImmediately: true,
          func: () => globalThis.__scanpnlFeatureDocument || null,
        });
        if (probe?.result === "ready")
        {
          documents.set(documentKey(sender), sender.documentId);
          return { allowed: true };
        }
        documents.set(documentKey(sender), sender.documentId);
        await chrome.scripting.executeScript({
          target,
          world: "MAIN",
          files: MAIN_INJECT,
          injectImmediately: true,
        });
        await chrome.scripting.insertCSS({ target, files: ["page.css"] });
        await chrome.scripting.executeScript({
          target,
          world: "ISOLATED",
          files: ISOLATED_INJECT,
          injectImmediately: true,
        });
        await chrome.scripting.executeScript({
          target,
          world: "ISOLATED",
          injectImmediately: true,
          func: () =>
          {
            globalThis.__scanpnlFeatureDocument = "ready";
          },
        });
        const latest = await chrome.storage.session.get("scanpnl.documents");
        const all = {
          ...(latest["scanpnl.documents"] || {}),
          [documentKey(sender)]: sender.documentId,
        };
        await chrome.storage.session.set({ "scanpnl.documents": all });
        return { allowed: true };
      }
      catch (error)
      {
        await forgetDocument(sender);
        await chrome.storage.local.set({
          "scanpnl.bootstrapError": "Axiom setup did not finish. Refresh the Axiom page to retry.",
        });
        await chrome.tabs.reload(sender.tab.id, { bypassCache: true });
        throw new Error("Axiom setup failed. Refresh Axiom to retry.");
      }
    });

  // accepts messages from axiom pages and the popup; bootstraps pages; rejects unknown requests
  const authorize = async (message, sender) =>
  {
    if (!message || typeof message.type !== "string" || (!popup(sender) && !page(sender)))
    {
      throw new Error("Invalid source");
    }
    if (message.type === "scanpnl.bootstrap")
    {
      if (!page(sender)) throw new Error("Bootstrap requires an Axiom page");
      return { handled: true, result: await inject(sender) };
    }
    if (!ALLOWED_TYPES.has(message.type)) throw new Error("Unknown request");
    return { handled: false };
  };

  return { authorize, page, popup };
})();
