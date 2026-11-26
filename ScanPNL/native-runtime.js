// shared helpers for reading axiom's own modules from the page: import map, sources, runtime loader
(() =>
{
  "use strict";

  // fetched module sources and loaded runtimes, by url
  const sources = new Map();
  const runtimes = new Map();

  // parsed import maps (axiom's is about 200 kb, so each is parsed once)
  const parsedMaps = new WeakMap();

  // the imports of one import map script
  function importsOf(script)
  {
    if (!parsedMaps.has(script))
    {
      let imports = {};
      try
      {
        imports = JSON.parse(script.textContent).imports || {};
      }
      catch {}
      parsedMaps.set(script, imports);
    }
    return parsedMaps.get(script);
  }

  // the url a module specifier loads from, after the page's import maps
  function resolve(specifier)
  {
    const url = new URL(specifier, location.href).href;
    for (const script of document.querySelectorAll('script[type="importmap"]'))
    {
      const imports = importsOf(script);
      const mapped = imports[url] || imports[new URL(url).pathname];
      if (mapped) return new URL(mapped, location.href).href;
    }
    return url;
  }

  // a module's source text, fetched once from the browser cache
  function source(specifier)
  {
    const url = resolve(specifier);
    if (!sources.has(url))
    {
      sources.set(
        url,
        fetch(url, { cache: "force-cache" })
          .then((response) =>
          {
            if (!response.ok) throw Error("Native asset HTTP " + response.status);
            return response.text();
          })
          .catch((error) =>
          {
            sources.delete(url);
            throw error;
          }),
      );
    }
    return sources.get(url);
  }

  // every named import in a module: local name -> { key: exported name, url }
  function imports(code, base)
  {
    const found = new Map();
    for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g))
    {
      for (const entry of match[1].split(","))
      {
        const parts = entry.trim().split(/\s+as\s+/);
        found.set(parts.at(-1), {
          key: parts[0],
          url: base ? new URL(match[2], base).href : match[2],
        });
      }
    }
    return found;
  }

  // the name a module exports a local binding as, read from its last export clause
  function exportName(code, local)
  {
    const escaped = local.replace(/[$]/g, "\\$");
    return code
      .slice(code.lastIndexOf("export{"))
      .match(new RegExp("[{,]" + escaped + " as ([\\w$]+)"))?.[1];
  }

  // finds the exported loader in axiom's boot module that imports a chain's runtime
  function discover(code, bootUrl, family = "sol-v2")
  {
    if (!["sol-v1", "sol-v2"].includes(family)) throw Error("Unsupported native runtime family");
    const functions = [...code.matchAll(/function\s+([\w$]+)\(\)\{/g)];
    for (let index = 0; index < functions.length; index++)
    {
      const declaration = functions[index];
      const body = code.slice(declaration.index, functions[index + 1]?.index);
      const runtimeImport = body.match(
        new RegExp(
          "import\\([`\"']([^`\"']*\\/" + family + "-runtime-(?!graph-)[^`\"']+\\.js)[`\"']\\)",
        ),
      );
      if (!runtimeImport) continue;
      const local = declaration[1].replace(/[$]/g, "\\$");
      const key = code.match(new RegExp("(?:\\{|,)\\s*" + local + "\\s+as\\s+([\\w$]+)"))?.[1];
      if (key)
      {
        return {
          key,
          runtimeUrl: new URL(runtimeImport[1], bootUrl).href,
          bootUrl: resolve(bootUrl),
          bootName: new URL(bootUrl).pathname.split("/").at(-1),
        };
      }
    }
  }

  // loads a chain runtime through axiom's own loader
  async function connect(bootUrl, family)
  {
    const found = discover(await source(bootUrl), bootUrl, family);
    if (!found) throw Error("Waiting for native " + family + " runtime loader");
    const boot = await import(found.bootUrl);
    const runtime = await boot[found.key]();
    document.documentElement.dataset.scanpnlRuntime = "ready";
    return { ...found, runtimeUrl: resolve(found.runtimeUrl), runtime };
  }

  // the runtime for a boot module and chain family, loaded once
  function ready(bootUrl, family = "sol-v2")
  {
    if (!bootUrl) throw Error("Native binding must specify its owning runtime");
    const url = resolve(new URL(bootUrl, location.href).href);
    const key = family + "|" + url;
    if (!runtimes.has(key))
    {
      runtimes.set(
        key,
        connect(url, family).catch((error) =>
        {
          runtimes.delete(key);
          throw error;
        }),
      );
    }
    return runtimes.get(key);
  }

  // the runtime of the boot module a module's source imports from
  async function fromSource(code, url, family = "sol-v2")
  {
    const boot = code.match(/from\s*["']([^"']*boot-app-[^"']+\.js)["']/);
    if (!boot) throw Error("Native module runtime binding unavailable");
    return ready(new URL(boot[1], url).href, family);
  }

  // binding attempts back off when they fail for good (1 s doubling up to 5 min), because a
  // failed bind scans axiom's bundles; "not loaded yet" errors retry at the next tick
  const gates = new Map();
  const transient = (error) => /^Waiting for|still loading|not ready/i.test(error?.message || "");

  // runs a binding attempt unless its key is backing off
  function attempt(key, run)
  {
    const gate = gates.get(key);
    if (gate && Date.now() < gate.until) return Promise.reject(Error(gate.reason));
    return Promise.resolve()
      .then(run)
      .then(
        (value) =>
        {
          gates.delete(key);
          return value;
        },
        (error) =>
        {
          if (!transient(error))
          {
            const wait = gate ? Math.min(gate.wait * 2, 300000) : 1000;
            gates.set(key, {
              until: Date.now() + wait,
              wait,
              reason: error?.message || String(error),
            });
          }
          throw error;
        },
      );
  }

  window.ScanPNLNativeRuntime = {
    ready,
    source,
    imports,
    exportName,
    discover,
    fromSource,
    resolve,
    attempt,
  };
})();
