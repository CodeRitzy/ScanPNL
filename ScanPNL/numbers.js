// formats numbers with axiom's own number formatter, so paper values look like axiom's (runs in the page)
(() =>
{
  "use strict";

  // subscript digits for the hidden zero count
  const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

  // the formatter, loaded once
  let formatter;

  // finds axiom's formatter and its decimals preference in the boot module
  async function connect()
  {
    const runtime = window.ScanPNLNativeRuntime;
    const bootUrls = [
      ...new Set(performance.getEntriesByType("resource").map((entry) => entry.name)),
    ].filter((url) => url.startsWith(location.origin + "/assets/boot-app-") && url.includes(".js"));
    for (const bootUrl of bootUrls)
    {
      const code = await runtime.source(bootUrl);
      const marker = code.indexOf("Allowed digits must be greater than or equal to 4");
      if (marker < 0) continue;
      const local = code
        .slice(code.lastIndexOf("function ", marker), marker)
        .match(/^function\s+([\w$]+)\(/)?.[1];
      const key = local && runtime.exportName(code, local);
      if (!key) continue;
      const boot = await import(runtime.resolve(bootUrl));
      const format = boot[key];
      if (typeof format !== "function") continue;

      // the user's "fixed decimals" preference, read from axiom's settings store
      let preference = () => undefined;
      const at = code.indexOf("fixedDecimals:");
      const reference = code.slice(at, at + 500).match(/\?\?([\w$]+)\.get\(([\w$]+)\)/);
      if (reference)
      {
        const atom = boot[runtime.exportName(code, reference[2])];
        const storeLocal = code.match(new RegExp("\\b" + reference[1] + "=([\\w$]+)\\(\\)"))?.[1];
        const storeImport = runtime.imports(code, bootUrl).get(storeLocal);
        if (atom && storeImport)
        {
          const store = (await import(runtime.resolve(storeImport.url)))[storeImport.key]();
          preference = () => store.get(atom);
        }
      }
      document.documentElement.dataset.scanpnlNumbers = "ready";
      return (value) => format(value, 4, undefined, preference());
    }
    throw Error("Native number formatter is still loading");
  }

  // formats a batch of values for the content script
  window.addEventListener("message", (event) =>
  {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.type !== "scanpnl-format-v1"
    )
    {
      return;
    }
    const values = event.data.values;
    if (!Array.isArray(values) || values.length > 200) return;
    (formatter ||= connect().catch((error) =>
    {
      formatter = undefined;
      throw error;
    }))
      .then((format) =>
      {
        const results = values.filter(Number.isFinite).map((value) =>
        {
          const parts = format(value);
          const zeros = String(parts.leadingZeroCount).replace(/\d/g, (digit) => SUBSCRIPTS[digit]);
          return [
            value,
            parts.hasSubscript
              ? `${parts.sign || ""}${parts.beforeDec}.0${zeros}${parts.rounded}`
              : parts.text,
          ];
        });
        window.postMessage({ type: "scanpnl-formatted-v1", results }, location.origin);
      })
      .catch((error) =>
      {
        document.documentElement.dataset.scanpnlNumbers = error.message;
      });
  });
})();
