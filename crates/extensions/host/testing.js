'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const { registry, changed, owned, key, text, failure, limit } = require('./workbench.js');
const execution = new AsyncLocalStorage();
const requestSources = new WeakMap();
const TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 };
class TestRunRequest {
  constructor(include, exclude, profile, continuous = false) {
    this.include = include; this.exclude = exclude; this.profile = profile; this.continuous = continuous;
  }
}
class TestMessage {
  constructor(message) { this.message = message; }
  static diff(message, expected, actual) {
    const result = new TestMessage(message); result.expectedOutput = expected; result.actualOutput = actual; return result;
  }
}
class TestTag { constructor(id) { this.id = id; } }

function create(parts) {
  const { host, ext, need, track, Disposable, CancellationTokenSource } = parts;
  const state = registry(host);
  state.continuousTests ||= new Map();
  const stop = handle => { for (const [id, value] of state.continuousTests) if (value.controller === handle) { state.continuousTests.delete(id); owned(host, ext.id, () => value.source.cancel()); value.source.dispose(); } };
  return {
    createTestController(id, label) {
      need('commands');
      const handle = key(ext, id);
      if (!id || state.tests.has(handle)) failure('A test controller needs a unique non-empty id.');
      const items = new WeakSet();
      const containers = new WeakMap();
      let disposed = false;
      const alive = () => { if (disposed) failure('The test controller was disposed.'); };
      const update = () => changed(host, 'tests');
      const collection = (parent) => {
        const map = new Map();
        const result = {
          get size() { return map.size; },
          get: id => map.get(id),
          add(item) {
            alive();
            if (!items.has(item)) failure('The test item belongs to a different controller.');
            for (let ancestor = parent; ancestor; ancestor = ancestor.parent) if (ancestor === item) failure('A test item cannot contain itself.');
            if (containers.has(item) && containers.get(item).collection !== result) failure('Remove the item from its parent before moving it.');
            const old = map.get(item.id);
            if (old && old !== item) containers.delete(old);
            containers.set(item, { collection: result, parent }); map.set(item.id, item); update();
          },
          delete(id) { const item = map.get(id); if (item) containers.delete(item); const removed = map.delete(id); update(); return removed; },
          replace(values) {
            const ids = new Set();
            for (const item of values) {
              if (!items.has(item)) failure('The test item belongs to a different controller.');
              if (ids.has(item.id)) failure('Duplicate test item id.'); ids.add(item.id);
              if (containers.has(item) && containers.get(item).collection !== result) failure('Remove the item from its parent before moving it.');
              for (let ancestor = parent; ancestor; ancestor = ancestor.parent) if (ancestor === item) failure('A test item cannot contain itself.');
            }
            for (const item of map.values()) containers.delete(item);
            map.clear(); for (const item of values) result.add(item); update();
          },
          forEach: (callback, thisArg) => map.forEach(item => callback.call(thisArg, item, result)),
          [Symbol.iterator]: () => map[Symbol.iterator](),
        };
        return result;
      };
      const controller = {
        id, label, items: collection(undefined), profiles: new Map(), resolveHandler: undefined, refreshHandler: undefined,
        createTestItem(itemId, itemLabel, uri) {
          alive(); if (!itemId) failure('A test item needs an id.');
          const item = new Proxy({ id: itemId, label: itemLabel, uri, parent: undefined, range: undefined,
            tags: [], canResolveChildren: false, busy: false, error: undefined, description: undefined, children: undefined }, {
            set(target, property, value) { target[property] = value; update(); return true; },
          });
          Object.defineProperties(item, { id: { value: itemId, writable: false },
            parent: { get: () => containers.get(item)?.parent }, children: { value: collection(item), writable: false } });
          items.add(item); return item;
        },
        createRunProfile(profileLabel, kind, runHandler, isDefault = false, tag, supportsContinuousRun = false) {
          alive();
          if (![1, 2, 3].includes(kind) || typeof runHandler !== 'function') failure('Invalid test run profile.');
          const profileId = String(++state.counter);
          const profile = { id: profileId, label: profileLabel, kind, runHandler, isDefault, tag,
            supportsContinuousRun, dispose() { const id = `${handle}/${profileId}`; const active = state.continuousTests.get(id); if (active) { state.continuousTests.delete(id); active.source.cancel(); active.source.dispose(); } controller.profiles.delete(profileId); update(); } };
          controller.profiles.set(profileId, profile); update(); return profile;
        },
        createTestRun(request, name, persist = true) {
          alive();
          const inherited = execution.getStore() || requestSources.get(request);
          const source = inherited || new CancellationTokenSource();
          const run = { id: String(++state.counter), controller: handle, extension: ext.id, name: name || label, persist,
            token: source.token, source, ended: false, results: new Map(), output: '',
            end() {
              if (run.ended) return; run.ended = true;
              if (!inherited || (!source.continuous && source.handlerDone && ![...state.runs.values()].some(other => other.source === source && !other.ended))) source.dispose();
              update();
            },
            appendOutput(value) { run.output = (run.output + String(value)).slice(-65536); update(); },
          };
          for (const status of ['enqueued', 'started', 'skipped', 'passed', 'failed', 'errored']) run[status] = (item, messages, duration) => {
            if (run.ended) failure('This test run has ended.');
            if (!items.has(item)) failure('The test item belongs to a different controller.');
            run.results.set(item.id, { id: item.id, label: item.label, status,
              messages: (['failed', 'errored'].includes(status) ? (Array.isArray(messages) ? messages : [messages]) : [])
                .filter(Boolean).map(message => ({ message: text(message.message), expected: message.expectedOutput, actual: message.actualOutput })),
              duration: typeof messages === 'number' ? messages : duration }); update();
          };
          state.runs.set(run.id, run);
          // Keep active runs; bound retained completed history.
          const completed = [...state.runs.values()].filter(item => item.ended);
          for (const old of completed.slice(0, Math.max(0, completed.length - 100))) state.runs.delete(old.id);
          update(); return run;
        },
        dispose() {
          if (disposed) return; disposed = true;
          stop(handle);
          state.tests.delete(handle);
          for (const run of state.runs.values()) if (run.controller === handle && !run.ended) { owned(host, ext.id, () => run.source.cancel()); run.end(); }
          update();
        },
      };
      track(host.events.on('workspaceFolders')(() => stop(handle)));
      state.tests.set(handle, { extension: ext.id, controller });
      track(new Disposable(() => controller.dispose())); update(); return controller;
    },
  };
}
function snapshot(host) {
  const state = registry(host);
  const item = (value, depth = 0) => ({ id: value.id, label: value.label, description: value.description,
    uri: value.uri?.toString(), range: value.range, error: text(value.error), busy: value.busy,
    children: depth < 30 ? limit([...value.children].map(([, child]) => child)).map(child => item(child, depth + 1)) : [] });
  return { controllers: [...state.tests].map(([handle, { controller }]) => ({ handle, id: controller.id, label: controller.label,
    items: limit([...controller.items].map(([, value]) => value)).map(value => item(value)),
    profiles: [...controller.profiles.values()].map(p => ({ id: p.id, label: p.label, kind: p.kind, supportsContinuousRun: !!p.supportsContinuousRun, continuous: !!state.continuousTests?.has(`${handle}/${p.id}`) })) })),
  runs: limit([...state.runs.values()], 100).map(run => ({ id: run.id, controller: run.controller, name: run.name, ended: run.ended,
    results: limit([...run.results.values()]), output: run.output })) };
}
async function invoke(host, params) {
  const state = registry(host);
  if (params.op === 'cancel') {
    const run = state.runs.get(params.run); if (!run) failure('Test run not found.');
    return owned(host, state.tests.get(run.controller)?.extension || 'host', () => { run.source.cancel(); return true; });
  }
  const entry = state.tests.get(params.controller); if (!entry) failure('Test controller not found.');
  const c = entry.controller;
  if (params.op === 'stopContinuous') {
    const id = `${params.controller}/${params.profile}`, active = state.continuousTests?.get(id);
    if (!active) return false;
    state.continuousTests.delete(id); owned(host, entry.extension, () => active.source.cancel()); active.source.dispose(); changed(host, 'tests'); return true;
  }
  if (params.op === 'discover') return owned(host, entry.extension, async () => {
    if (c.resolveHandler) await c.resolveHandler(undefined);
    if (c.refreshHandler) { const source = new (require('./vscode.js').CancellationTokenSource)(); try { await c.refreshHandler(source.token); } finally { source.dispose(); } }
    changed(host, 'tests'); return true;
  });
  if (params.op !== 'run') failure('Unsupported test operation.');
  require('./workbench.js').requireTrust(host);
  const profile = c.profiles.get(params.profile); if (!profile) failure('Test profile not found.');
  const all = new Map(); const walk = collection => { for (const [, item] of collection) { all.set(item.id, item); walk(item.children); } }; walk(c.items);
  const include = params.include?.map(id => all.get(id) || failure(`Test '${id}' not found.`));
  const continuous = params.continuous === true;
  if (continuous && !profile.supportsContinuousRun) failure('This profile does not support continuous testing.');
  const id = `${params.controller}/${params.profile}`;
  state.continuousTests ||= new Map();
  if (continuous && state.continuousTests.has(id)) failure('Continuous testing is already active for this profile.');
  const source = new (require('./vscode.js').CancellationTokenSource)(); source.continuous = continuous;
  const request = new TestRunRequest(include, undefined, profile, continuous); requestSources.set(request, source);
  if (continuous) { state.continuousTests.set(id, { source, controller: params.controller }); changed(host, 'tests'); }
  try {
    await owned(host, entry.extension, () => execution.run(source, () => profile.runHandler(request, source.token)));
    return true;
  } catch (error) {
    if (continuous) { state.continuousTests.delete(id); owned(host, entry.extension, () => source.cancel()); source.dispose(); changed(host, 'tests'); }
    throw error;
  } finally {
    source.handlerDone = true;
    if (!continuous && ![...state.runs.values()].some(run => run.source === source && !run.ended)) source.dispose();
  }
}
module.exports = { create, snapshot, invoke, TestRunRequest, TestRunProfileKind, TestMessage, TestTag };
