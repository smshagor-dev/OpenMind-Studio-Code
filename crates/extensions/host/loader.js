'use strict';
// How extension code is loaded in the host: require('vscode') and Node builtins through the permission guard, and ES
// modules through Node's synchronous module hooks (the same guarded objects). Split out of host.js.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const { permissionError, modulePermission } = require('./guard.js');

/** `state` and `als` are the host's; `guardOf(id)` gives an extension's permission guard. */
function createLoader({ state, als, guardOf }) {
  // Which extension's `require('vscode')` is this? Decided by the requiring file's location.
  const originalLoad = Module._load;
  let moduleGeneration = 0;
  let bridgeSerial = 0;
  const moduleBridges = new Map();
  const bridgeOwners = new Map();
  const bridgeSources = new Map();
  // Values the ESM bridge modules export, keyed by bridge file (see esmBridge).
  const BRIDGE_VALUES = 'openmind.extensionHost.bridgeValues';
  const bridgeValues = new Map();
  Object.defineProperty(globalThis, Symbol.for(BRIDGE_VALUES), { value: bridgeValues });
  const esmOwners = new Map();
  function ownerOf(parent) {
    const file = parent && parent.filename ? path.resolve(parent.filename) : '';
    const bridge = bridgeOwners.get(file);
    if (bridge && state.running.get(bridge.id)?.generation === bridge.generation) return bridge.id;
    for (const [id] of state.running) {
      const root = state.running.get(id).root || path.resolve(state.extensions.get(id).path);
      if (file === root || file.startsWith(root + path.sep)) return id;
    }
    return null;
  }
  Module._load = function (requested, parent, isMain) {
    if (requested === 'vscode') {
      const owner = ownerOf(parent);
      if (owner) return state.running.get(owner).api;
      throw new Error("The 'vscode' module can only be used by an activated extension.");
    }
    const owner = ownerOf(parent);
    if (owner) {
      const args = arguments;
      return guardOf(owner).moduleFor(requested, () => originalLoad.apply(Module, args));
    }
    return originalLoad.apply(this, arguments);
  };

  // Synchronous native hooks cover ESM imports while the CJS shim above continues
  // to own require(). Bridge modules expose the same guarded objects, never raw fs
  // or process/network modules. Their virtual CommonJS source lives only in host memory.
  // https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions
  function esmBridge(id, requested) {
    const run = state.running.get(id);
    const key = `${id}:${run.generation}:${requested}`;
    if (moduleBridges.has(key)) return moduleBridges.get(key);
    const file = `${__filename}.bridge-${++bridgeSerial}.cjs`;
    // The value is the extension's own `vscode` API or the guarded builtin (the same object its require() gets).
    // The bridge reads it from a host-private registry instead of calling require(): since Node 24 a require() inside a
    // CommonJS module loaded through these hooks is resolved by the ESM resolver and never reaches Module._load, so
    // `vscode` wasn't found and builtins would have skipped the guard.
    const value = requested === 'vscode' ? run.api : guardOf(id).moduleFor(requested, () => originalLoad.call(Module, requested, module, false));
    bridgeValues.set(file, value);
    const names = Object.keys(value).filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
    // An ES module (its source is used however Node reaches it, also under require(esm)): the default export is the value
    // itself, every own name a named export (`export { _0 as delete }` is valid for any name).
    const source = `const value = globalThis[Symbol.for(${JSON.stringify(BRIDGE_VALUES)})].get(${JSON.stringify(file)});\nexport default value;\n`
      + names.map((name, index) => `const _${index} = value[${JSON.stringify(name)}];\nexport { _${index} as ${name} };`).join('\n') + '\n';
    bridgeSources.set(pathToFileURL(file).href, source);
    bridgeOwners.set(file, { id, generation: run.generation });
    moduleBridges.set(key, file);
    return file;
  }
  if (typeof Module.registerHooks === 'function') Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      // require() already passes through Module._load. Rewriting it here would
      // recursively wrap the bridge's own require() of the guarded builtin.
      if (!context.conditions.includes('import')) return nextResolve(specifier, context);
      const parentOwner = esmOwners.get(context.parentURL);
      let owner = parentOwner && state.running.get(parentOwner.id)?.generation === parentOwner.generation ? parentOwner.id : null;
      if (!owner && context.parentURL?.startsWith('file:')) {
        try { owner = ownerOf({ filename: fileURLToPath(context.parentURL) }); } catch { /* Not a file parent. */ }
      }
      if (!owner) return nextResolve(specifier, context);
      const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      if (specifier === 'vscode' || bare === 'fs' || bare === 'fs/promises' || modulePermission(specifier)) {
        // Refuse before loading a forbidden process/network builtin at all.
        if (specifier !== 'vscode') guardOf(owner).moduleFor(specifier, () => originalLoad.call(Module, specifier, module, false));
        return { url: pathToFileURL(esmBridge(owner, specifier)).href, shortCircuit: true };
      }
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith('file:')) {
        const url = new URL(resolved.url);
        url.searchParams.set('__openmind_generation', String(state.running.get(owner).generation));
        esmOwners.set(url.href, { id: owner, generation: state.running.get(owner).generation });
        return { ...resolved, url: url.href };
      }
      return resolved;
    },
    load(url, context, nextLoad) {
      const source = bridgeSources.get(url);
      return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
    },
  });

  async function extensionModule(file, run) {
    let esm = path.extname(file) === '.mjs';
    if (path.extname(file) === '.js') {
      for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        const packageFile = path.join(dir, 'package.json');
        if (fs.existsSync(packageFile)) { esm = JSON.parse(fs.readFileSync(packageFile, 'utf8')).type === 'module'; break; }
        if (path.dirname(dir) === dir) break;
      }
    }
    if (!esm) {
      try { return require(file); }
      catch (error) { if (error.code !== 'ERR_REQUIRE_ESM' && error.code !== 'ERR_REQUIRE_ASYNC_MODULE' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
    }
    if (typeof Module.registerHooks !== 'function') throw new Error('This ES module extension requires a newer Node.js runtime. Update Node.js in Runtime Manager and restart the extension host.');
    const url = pathToFileURL(file); url.searchParams.set('__openmind_generation', String(run.generation));
    esmOwners.set(url.href, { id: run.context.extension.id, generation: run.generation });
    const value = await import(url.href);
    return Object.hasOwn(value, 'module.exports') ? value.default : value;
  }

  // fetch and WebSocket are globals: whoever is running (see `als`) needs the 'network' permission.
  function guardGlobals() {
    const allowed = () => {
      const id = als.getStore();
      const descriptor = id && state.extensions.get(id);
      return !descriptor || (descriptor.permissions || []).includes('network');
    };
    if (typeof globalThis.fetch === 'function') {
      const realFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (...args) => (allowed() ? realFetch(...args) : Promise.reject(permissionError('network', als.getStore())));
    }
    if (typeof globalThis.WebSocket === 'function') {
      globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
        construct(target, args) {
          if (!allowed()) throw permissionError('network', als.getStore());
          return Reflect.construct(target, args);
        },
      });
    }
  }
  guardGlobals();

  function purgeExtensionModules(descriptor) {
    for (const [url, owner] of esmOwners) if (owner.id === descriptor.id) esmOwners.delete(url);
    for (const [file, owner] of bridgeOwners) if (owner.id === descriptor.id) {
      delete require.cache[file]; bridgeOwners.delete(file); bridgeValues.delete(file);
      bridgeSources.delete(pathToFileURL(file).href);
    }
    for (const key of moduleBridges.keys()) if (key.startsWith(descriptor.id + ':')) moduleBridges.delete(key);

    // Node caches both the entry module and its local dependencies. Without
    // clearing them, a VSIX update keeps executing the old implementation.
    const root = fs.realpathSync(descriptor.path);
    for (const file of Object.keys(require.cache)) {
      let real;
      try { real = fs.realpathSync(file); } catch { real = path.resolve(file); }
      const relative = path.relative(root, real);
      if (relative === '' || (relative !== '..' &&
          !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
        delete require.cache[file];
      }
    }
  }

  return {
    extensionModule,
    purgeExtensionModules,
    /** A new module generation for an extension's next activation (its ES modules load afresh). */
    nextGeneration: () => ++moduleGeneration,
  };
}

module.exports = { createLoader };
