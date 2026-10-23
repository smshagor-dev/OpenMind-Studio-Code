'use strict';

// Extension-owned workbench state. Snapshots contain data only; callbacks stay in Node.
function registry(host) {
  if (!host.state.extensionWorkbench) host.state.extensionWorkbench = {
    tests: new Map(), runs: new Map(), scm: new Map(), serializers: new Map(),
    controllers: new Map(), notebooks: new Map(), factories: new Map(), configurations: new Map(),
    sessions: new Map(), debugClients: new Map(), trackers: new Map(), breakpoints: [], pending: new Set(), counter: 0,
  };
  return host.state.extensionWorkbench;
}

function changed(host, domain) {
  const state = registry(host);
  if (state.pending.has(domain)) return;
  state.pending.add(domain);
  queueMicrotask(() => {
    state.pending.delete(domain);
    try { host.notify('workbench/changed', { domain, ...snapshot(host, domain) }); }
    catch (error) { host.log('host', 'error', `Workbench update failed: ${error.message}`); }
  });
}

function snapshot(host, domain) {
  return { ...require(`./${moduleFor(domain)}.js`).snapshot(host), isTrusted: host.state.isTrusted === true,
    folders: host.state.workspaceFolders.map(folder => folder.path) };
}
function moduleFor(domain) {
  const names = { tests: 'testing', scm: 'scm', notebooks: 'notebooks', debug: 'debug' };
  if (!Object.hasOwn(names, domain)) throw new Error(`Unknown extension workbench domain '${domain}'.`);
  return names[domain];
}
async function handle(host, params) {
  const module = require(`./${moduleFor(params.domain)}.js`);
  if (params.op === 'snapshot') {
    if (params.domain === 'debug') await host.activateByEvent?.('onDebugInitialConfigurations');
    if (params.domain === 'scm') await host.activateByEvent?.('onView:workbench.scm');
    return snapshot(host, params.domain);
  }
  if (params.op === 'trust') {
    const expected = host.state.workspaceFolders.map(folder => folder.path).sort();
    if (!expected.length || !Array.isArray(params.folders) || JSON.stringify([...params.folders].sort()) !== JSON.stringify(expected)) failure('The workspace changed; refresh before granting trust.');
    host.state.isTrusted = true; host.events.fire('workspaceTrusted', undefined);
    for (const domain of ['tests', 'scm', 'notebooks', 'debug']) changed(host, domain);
    return true;
  }
  return module.invoke(host, params);
}
function owned(host, extension, fn) { return host.als.run(extension, fn); }
function key(ext, id) { return `${ext.id}/${id}`; }
function text(value) { return typeof value === 'string' ? value : value?.value || ''; }
function failure(message) { throw new Error(message); }
function limit(list, count = 1000) { return list.slice(-count); }
function requireTrust(host) {
  if (host.state.workspaceFolders.length && host.state.isTrusted !== true) failure('Trust this workspace before running extension code against its files.');
}

module.exports = { registry, changed, snapshot, handle, owned, key, text, failure, limit, requireTrust };
