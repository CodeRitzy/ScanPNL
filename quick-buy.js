// reads the user's axiom quick-buy presets (fees and slippage) from axiom's settings store (runs in the page)
(() =>
{
  "use strict";

  // the connection to axiom's settings module, made once
  let connection;

  // the name a module exports a local binding as
  function exported(code, local)
  {
    const name = window.ScanPNLNativeRuntime.exportName(code, local);
    if (!name) throw Error("Native quick-buy settings binding changed");
    return name;
  }

  // the module and export a local binding was imported from (unresolved url)
  const storeBinding = (code, local) => window.ScanPNLNativeRuntime.imports(code).get(local);

  // bindings in builds where presets live in the synced settings document
  function documentBindings(code)
  {
    const presets = code.match(
      /function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\{\},\2\(([\w$]+)\)\.presets\)\}var [\w$]+=[\w$]+\(([\w$]+)=>([\w$]+)\(\1\(\5\)\)\)/,
    );
    if (!presets) return;
    const [, , , merge, synced, , validate] = presets;
    const syncedName = synced.replace(/[$]/g, "\\$");
    const storeFactory = code.match(
      new RegExp(
        "(?:,|var )([\\w$]+)=([\\w$]+)\\(\\);function [\\w$]+\\(\\)\\{return \\1\\.get\\(" +
          syncedName +
          "\\)\\}",
      ),
    )?.[2];
    const storeRef = storeBinding(code, storeFactory);
    if (!storeRef) throw Error("Native settings store unavailable");
    const autoFee = code.match(
      /([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\2\(([\w$]+)\);return\(0,[\w$]+\.useMemo\)\(\(\)=>\{let [\w$]+=[^;]{0,100}?,[\w$]+=([\w$]+)\(\4,\1,[\w$]+\([\w$]+\.buy\.maxFeeSol/,
    );
    return {
      document: true,
      synced: exported(code, synced),
      merge: exported(code, merge),
      validate: exported(code, validate),
      calculate: autoFee && exported(code, autoFee[6]),
      priority: autoFee && exported(code, autoFee[5]),
      bribe: autoFee && exported(code, autoFee[3]),
      storeRef,
    };
  }

  // bindings to the settings atoms, the preset merge and the automatic fee calculation
  function bindings(code)
  {
    const fromDocument = documentBindings(code);
    if (fromDocument) return fromDocument;
    const modern = code.match(
      /function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\)\?([\w$]+)\(\{\},\2\(([\w$]+)\)\.presets\):\2\(([\w$]+)\)\}/,
    );
    const legacy = modern?.[6] || code.match(/var ([\w$]+)=[\w$]+\(`settings`,/)?.[1];
    const synced = modern?.[5] || code.match(/var ([\w$]+)=[\w$]+\(`solV2Settings`,/)?.[1];
    const older = modern
      ? null
      : code.match(
        new RegExp(
          "function [\\w$]+\\(([\\w$]+)\\)\\{let ([\\w$]+)=\\1\\(" +
              legacy +
              "\\);return ([\\w$]+)\\(\\)\\?([\\w$]+)\\(\\2,\\1\\(" +
              synced +
              "\\)\\.presets\\):\\2",
        ),
      );
    const feeStart = code.indexOf("unoptimizedPriorityFeeSol:");
    const feeCode = code.slice(Math.max(0, feeStart - 2200), feeStart);
    const feeAtoms = feeCode.match(
      /([\w$]+)=[\w$]+\(([\w$]+)\),([\w$]+)=[\w$]+\(([\w$]+)\);return/,
    );
    const calculate = modern
      ? feeCode.match(/([\w$]+)\(([\w$]+),([\w$]+),[\w$]+\(e\.buy\.maxFeeSol/)
      : feeCode.match(/([\w$]+)\([\w$]+,[\w$]+,[\w$]+\([\w$]+\.buy\.maxFeeSol/);
    const store = code.match(/var [\w$]+=([\w$]+)\(\),[\w$]+=\[`0\.01`/);
    if (!legacy || !synced || (!modern && !older) || !store)
    {
      throw Error("Native quick-buy settings unavailable");
    }
    const storeRef = storeBinding(code, store[1]);
    if (!storeRef) throw Error("Native settings store unavailable");
    return {
      legacy: exported(code, legacy),
      synced: exported(code, synced),
      useSync: exported(code, modern?.[3] || older[3]),
      merge: exported(code, modern?.[4] || older[4]),
      bribe: feeAtoms && exported(code, feeAtoms[2]),
      priority: feeAtoms && exported(code, feeAtoms[4]),
      calculate: calculate && exported(code, calculate[1]),
      modern: !!modern,
      storeRef,
    };
  }

  if (typeof module !== "undefined") module.exports = { bindings };
  if (typeof window === "undefined") return;

  // loads axiom's boot module and settings store once
  async function connect()
  {
    connection ||= (async () =>
    {
      const runtime = window.ScanPNLNativeRuntime;
      const assets = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => url.startsWith(location.origin + "/assets/"));
      const bootUrl = assets.find(
        (url) =>
          new URL(url).pathname.startsWith("/assets/boot-app-") &&
          new URL(url).pathname.endsWith(".js"),
      );
      if (!bootUrl) throw Error("Native quick-buy is still loading");
      const found = bindings(await runtime.source(bootUrl));
      const boot = await import(runtime.resolve(bootUrl));
      const storeUrl = runtime.resolve(new URL(found.storeRef.url, bootUrl).href);
      const storeModule = await import(
        assets.find((url) => new URL(url).pathname === new URL(storeUrl).pathname) || storeUrl
      );
      return { b: found, boot, store: storeModule[found.storeRef.key]() };
    })().catch((error) =>
    {
      connection = undefined;
      throw error;
    });
    return connection;
  }

  // priority + bribe and slippage of the preset axiom uses for a quick-buy table
  async function settings(table, side = "buy")
  {
    // pulse tables and the wallet tracker each have their own preset (<table>PresetKey)
    if (!["default", "newPairs", "finalStretch", "migrated", "walletTracker"].includes(table))
    {
      throw Error("Unknown native Pulse table");
    }
    const { b: found, boot, store } = await connect();
    let current;
    if (found.document)
    {
      current = boot[found.validate](boot[found.merge]({}, store.get(boot[found.synced])?.presets));
    }
    else
    {
      current = store.get(boot[found.legacy]);
      if (boot[found.useSync]())
      {
        current = boot[found.merge](
          found.modern ? {} : current,
          store.get(boot[found.synced]).presets,
        );
      }
    }
    if (!["buy", "sell"].includes(side)) throw Error("Unknown native side");
    const presetKey =
      (table === "default" ? current.currentSolPresetKey : current[table + "PresetKey"]) ||
      current.currentSolPresetKey;
    const preset = current.solPresets?.[presetKey]?.[side];
    if (!preset) throw Error("Choose a native quick-buy preset");
    let fixed;
    if (preset.autoFee)
    {
      // automatic fees: axiom's own calculation from the live priority and bribe levels
      if (!found.calculate || !found.priority || !found.bribe)
      {
        throw Error("Native automatic fees are still loading");
      }
      const fees = boot[found.calculate](
        store.get(boot[found.priority]),
        store.get(boot[found.bribe]),
        found.modern
          ? Number(preset.maxFeeSol ?? "0.1")
          : Math.round(Number(preset.maxFeeSol ?? "0.1") * 1e9),
      );
      fixed = (fees.priorityFee + fees.bribeFee) / (found.modern ? 1 : 1e9);
    }
    else fixed = Number(preset.priorityFeeSol) + Number(preset.bribeFeeSol);
    const tolerance = Number(preset.slippage) / 100;
    if (
      !Number.isFinite(fixed) ||
      fixed < 0 ||
      fixed > 1 ||
      !Number.isFinite(tolerance) ||
      tolerance < 0 ||
      tolerance > 1
    )
    {
      throw Error("Invalid native quick-buy preset");
    }
    return { fixed, tolerance, preset: presetKey };
  }

  // answers preset requests from the content script
  window.addEventListener("message", async (event) =>
  {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.type !== "scanpnl-quick-settings-request-v1"
    )
    {
      return;
    }
    const { id, table, side } = event.data;
    try
    {
      window.postMessage(
        { type: "scanpnl-quick-settings-response-v1", id, settings: await settings(table, side) },
        location.origin,
      );
    }
    catch (error)
    {
      window.postMessage(
        { type: "scanpnl-quick-settings-response-v1", id, error: error.message },
        location.origin,
      );
    }
  });
})();
