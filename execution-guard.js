// blocks real transactions in paper mode: runs in every axiom frame at document_start, before axiom
// can keep its own copy of fetch; starts on and turns off only when paper mode is switched off
(() =>
{
  "use strict";
  const rules = globalThis.ScanPNLGuardRules;
  const isTop = window === window.top;
  let paperOn = true;

  // true while paper mode is on; frames follow the top frame and stay guarded if it is unreadable
  const enabled = () =>
  {
    if (isTop) return paperOn;
    try
    {
      return window.top.document.documentElement.dataset.scanpnlPaper !== "off";
    }
    catch
    {
      return true;
    }
  };

  // tells the top frame that a real write was stopped, so it can show a notice
  const report = (url) =>
  {
    try
    {
      window.top.postMessage(
        { type: "scanpnl-guard-blocked-v1", url: url.origin + url.pathname },
        location.origin,
      );
    }
    catch {}
  };

  // wallet methods that sign or send a transaction
  const signingMethods = [
    "signTransaction",
    "signAllTransactions",
    "signAndSendTransaction",
    "signAndSendAllTransactions",
    "sendTransaction",
    "sendRawTransaction",
  ];
  const wrapped = new WeakMap();

  // makes a wallet's signing methods refuse while paper mode is on; true when a connected wallet
  // has a method that cannot be replaced
  function protect(provider)
  {
    let unprotected = false;
    if (!provider || !["object", "function"].includes(typeof provider)) return;
    let done = wrapped.get(provider);
    if (!done)
    {
      done = new Map();
      wrapped.set(provider, done);
    }
    for (const name of [...signingMethods, "request"])
    {
      const original = provider[name];
      if (typeof original !== "function" || done.get(name) === original) continue;
      const wrapper = function (...args)
      {
        if (
          enabled() &&
          (name !== "request" || /sign.*transaction|send.*transaction/i.test(args[0]?.method || ""))
        )
        {
          return Promise.reject(
            Error("ScanPNL: real transaction signing is blocked in paper mode"),
          );
        }
        return original.apply(this, args);
      };
      try
      {
        provider[name] = wrapper;
      }
      catch {}
      if (provider[name] !== wrapper)
      {
        try
        {
          const descriptor = Object.getOwnPropertyDescriptor(provider, name);
          if (!descriptor || descriptor.configurable)
          {
            Object.defineProperty(provider, name, {
              value: wrapper,
              writable: true,
              configurable: true,
            });
          }
        }
        catch {}
      }
      if (provider[name] === wrapper) done.set(name, wrapper);
      else unprotected = true;
    }
    return unprotected && (provider.isConnected === true || !!provider.publicKey);
  }

  // protects every known wallet and flags the page when one cannot be protected
  function scan()
  {
    let unprotected = false;
    for (const provider of new Set([
      window.solana,
      window.phantom?.solana,
      window.backpack,
      window.solflare,
    ]))
    {
      try
      {
        unprotected = protect(provider) || unprotected;
      }
      catch
      {
        if (provider?.isConnected === true || provider?.publicKey) unprotected = true;
      }
    }
    if (!isTop) return;
    if (unprotected)
    {
      document.documentElement.dataset.scanpnlWalletGuard =
        "Connected provider cannot be protected";
    }
    else delete document.documentElement.dataset.scanpnlWalletGuard;
  }

  // request bodies are read as text (up to 512 kb) to spot rpc broadcasts on any host
  const LIMIT = 512 * 1024;
  const decode = (bytes) => (bytes.byteLength <= LIMIT ? new TextDecoder().decode(bytes) : "");
  // the text of a body available right away
  function syncBody(body)
  {
    if (typeof body === "string") return body.slice(0, LIMIT);
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return decode(body);
    return "";
  }

  // the text of a fetch request's body
  async function fetchBody(input, init)
  {
    if (init && "body" in init)
    {
      const body = init.body;
      if (body instanceof Blob) return body.size <= LIMIT ? body.text() : "";
      return syncBody(body);
    }
    if (input instanceof Request && input.body)
    {
      return input
        .clone()
        .text()
        .catch(() => "");
    }
    return "";
  }

  // fetch: writes that could move funds are rejected
  const nativeFetch = window.fetch;
  window.fetch = function (input, init)
  {
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    let url;
    try
    {
      url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
        location.href,
      );
    }
    catch {}
    if (!enabled() || !url || ["GET", "HEAD", "OPTIONS"].includes(method))
    {
      return nativeFetch.apply(this, arguments);
    }
    const args = arguments;
    return fetchBody(input, init).then((body) =>
    {
      if (enabled() && rules.blocks(method, url, body))
      {
        console.warn("[ScanPNL] blocked real write request", url.href);
        report(url);
        throw Error("ScanPNL: real write request blocked in paper mode");
      }
      return nativeFetch.apply(this, args);
    });
  };

  // xhr: the same check when the request is sent
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const pending = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest)
  {
    try
    {
      pending.set(this, { method: String(method).toUpperCase(), url: new URL(url, location.href) });
    }
    catch {}
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body)
  {
    const request = pending.get(this);
    if (enabled() && request && rules.blocks(request.method, request.url, syncBody(body)))
    {
      console.warn("[ScanPNL] blocked real write request", request.url.href);
      report(request.url);
      throw Error("ScanPNL: real write request blocked in paper mode");
    }
    return nativeSend.apply(this, arguments);
  };

  // shows paper mode on the page so frames and styles can follow it
  const publishMode = () =>
  {
    if (isTop) document.documentElement.dataset.scanpnlPaper = paperOn ? "on" : "off";
  };

  // paper mode switch from the content script (top frame only)
  window.addEventListener("message", (event) =>
  {
    if (
      isTop &&
      event.source === window &&
      event.origin === location.origin &&
      event.data?.type === "scanpnl-mode-v2"
    )
    {
      paperOn = event.data.enabled !== false;
      publishMode();
      scan();
    }
  });

  // wallets can appear later, so keep checking
  publishMode();
  scan();
  setInterval(scan, 500);
  window.addEventListener("solana#initialized", scan);
})();
