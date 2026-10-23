'use strict';
const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');
const { registry, changed, owned, failure, limit } = require('./workbench.js');

class DebugAdapterExecutable { constructor(command, args = [], options) { this.command = command; this.args = args; this.options = options; } }
class DebugAdapterServer { constructor(port, host = '127.0.0.1') { this.port = port; this.host = host; } }
class DebugAdapterInlineImplementation { constructor(implementation) { this.implementation = implementation; } }
class SourceBreakpoint {
  constructor(location, enabled = true, condition, hitCondition, logMessage) {
    this.id = randomUUID(); this.location = location; this.enabled = enabled; this.condition = condition; this.hitCondition = hitCondition; this.logMessage = logMessage;
  }
}
class FunctionBreakpoint {
  constructor(functionName, enabled = true, condition, hitCondition) {
    this.id = randomUUID(); this.functionName = functionName; this.enabled = enabled; this.condition = condition; this.hitCondition = hitCondition;
  }
}

class DapClient {
  constructor(descriptor, event, log, observe = () => {}, runAdapter = fn => fn(), reverse = async command => { throw new Error(`Unsupported debug reverse request: ${command}`); }, cleanup = () => {}) {
    this.pending = new Map(); this.waiters = new Map(); this.sequence = 0; this.closed = false; this.buffer = Buffer.alloc(0);
    this.onEvent = event; this.log = log; this.observe = observe; this.runAdapter = runAdapter; this.reverse = reverse; this.cleanup = cleanup;
    if (descriptor instanceof DebugAdapterInlineImplementation) {
      this.inline = descriptor.implementation;
      this.subscription = this.runAdapter(() => this.inline.onDidSendMessage(message => this.receive(message)));
    } else {
      if (descriptor instanceof DebugAdapterExecutable) {
        this.child = spawn(descriptor.command, descriptor.args, {
          cwd: descriptor.options?.cwd, env: { ...process.env, ...descriptor.options?.env },
          stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
        });
        this.writer = this.child.stdin;
        this.child.stdout.on('data', data => this.read(data));
        this.child.stderr.on('data', data => log(String(data).slice(0, 16384)));
        this.child.once('error', error => this.close(error, true));
        this.child.once('exit', (code, signal) => { this.close(new Error('Debug adapter exited.')); this.reportExit(code ?? undefined, signal ?? undefined); });
      } else if (descriptor instanceof DebugAdapterServer) {
        this.socket = net.connect(descriptor.port, descriptor.host); this.writer = this.socket;
        this.socket.on('data', data => this.read(data)); this.socket.once('error', error => this.close(error, true));
        this.socket.once('close', () => this.close(new Error('Debug adapter disconnected.')));
      } else failure('Unsupported debug adapter descriptor.');
    }
  }
  send(message) {
    if (this.closed) failure('The debug adapter is closed.');
    this.observe('onWillReceiveMessage', message);
    if (this.inline) { this.runAdapter(() => this.inline.handleMessage(message)); return; }
    const body = Buffer.from(JSON.stringify(message));
    this.writer.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  request(command, args = {}, timeout = 10000) {
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`Debug adapter request '${command}' timed out.`)); }, timeout);
      this.pending.set(seq, { resolve, reject, timer });
      try { this.send({ seq, type: 'request', command, arguments: args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(seq); reject(error); }
    });
  }
  wait(event, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.waiters.get(event)?.delete(waiter); reject(new Error(`Debug adapter event '${event}' timed out.`)); }, timeout) };
      if (!this.waiters.has(event)) this.waiters.set(event, new Set()); this.waiters.get(event).add(waiter);
    });
  }
  read(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    try {
      for (;;) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) { if (this.buffer.length > 8192) failure('Invalid debug adapter header.'); return; }
        if (end > 8192) failure('Invalid debug adapter header.');
        const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString('ascii'));
        if (!match || Number(match[1]) > 16 * 1024 * 1024) failure('Invalid debug adapter message length.');
        const length = Number(match[1]); if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length)); this.buffer = this.buffer.subarray(end + 4 + length);
        this.receive(message);
      }
    } catch (error) { this.close(error, true); }
  }
  receive(message) {
    if (this.closed) return;
    this.observe('onDidSendMessage', message);
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.request_seq);
      if (message.success) pending.resolve(message.body || {}); else pending.reject(new Error(message.message || `Debug adapter rejected ${message.command}.`));
    } else if (message.type === 'event') {
      for (const waiter of this.waiters.get(message.event) || []) { clearTimeout(waiter.timer); waiter.resolve(message.body); }
      this.waiters.delete(message.event); this.onEvent(message.event, message.body || {});
    } else if (message.type === 'request') {
      Promise.resolve().then(() => this.runAdapter(() => this.reverse(message.command, message.arguments || {}))).then(
        body => { if (!this.closed) this.send({ seq: ++this.sequence, type: 'response', request_seq: message.seq, command: message.command, success: true, body: body || {} }); },
        error => { if (!this.closed) this.send({ seq: ++this.sequence, type: 'response', request_seq: message.seq, command: message.command, success: false, message: String(error.message || error) }); },
      ).catch(error => this.log(`Debug reverse response failed: ${error.message}`));
    }
  }
  reportExit(code, signal) {
    if (this.exited) return; this.exited = true; this.observe('onExit', code, signal);
  }
  close(reason = new Error('Debug adapter stopped.'), isError = false) {
    if (this.closed) return; this.closed = true;
    try { this.cleanup(); } catch (error) { this.log(`Debug terminal cleanup failed: ${error.message}`); }
    if (isError) this.observe('onError', reason);
    this.observe('onWillStopSession');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); } this.pending.clear();
    for (const waiters of this.waiters.values()) for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(reason); } this.waiters.clear();
    for (const dispose of [() => this.runAdapter(() => this.subscription?.dispose()), () => this.runAdapter(() => this.inline?.dispose?.()), () => this.socket?.destroy()]) {
      try { dispose(); } catch (error) { this.log(`Debug adapter cleanup failed: ${error.message}`); }
    }
    if (!this.child) this.reportExit();
    if (this.child?.pid) {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill(); } }
    }
    this.onEvent('clientClosed', { message: reason.message });
  }
}

function create({ host, ext, need, track, Disposable, EventEmitter, CancellationTokenSource, Uri }) {
  const state = registry(host); const events = state.debugEvents || (state.debugEvents = new Map());
  const emitter = name => { if (!events.has(name)) events.set(name, new EventEmitter()); return events.get(name); };
  const on = name => (listener, thisArg, disposables) => track(emitter(name).event(value => owned(host, ext.id, () => listener.call(thisArg, value)), undefined, disposables));
  const fire = (name, value) => emitter(name).fire(value);
  const update = () => changed(host, 'debug');
  const register = (map, type, value) => {
    if (!type || map.has(type)) failure('A debug adapter type may only be registered once.');
    map.set(type, { extension: ext.id, value }); update();
    return track(new Disposable(() => { map.delete(type); update(); }));
  };
  function synchronize(entry) {
    const next = (entry.breakpointSync || Promise.resolve()).catch(() => {}).then(() => synchronizeNow(entry));
    entry.breakpointSync = next; return next;
  }
  async function synchronizeNow(entry) {
    const groups = new Map(); const protocolBreakpoints = new Map();
    for (const breakpoint of state.breakpoints) if (breakpoint instanceof SourceBreakpoint) {
      const file = breakpoint.location.uri.fsPath;
      if (!groups.has(file)) groups.set(file, []);
      if (breakpoint.enabled) groups.get(file).push({ id: breakpoint.id, line: breakpoint.location.range.start.line + 1, column: breakpoint.location.range.start.character + 1,
        condition: breakpoint.condition, hitCondition: breakpoint.hitCondition, logMessage: breakpoint.logMessage });
    }
    for (const file of new Set([...(entry.breakpointFiles || []), ...groups.keys()])) {
      const sourceBreakpoints = groups.get(file) || [];
      const result = await entry.client.request('setBreakpoints', { source: { path: file }, breakpoints: sourceBreakpoints.map(({ id, ...value }) => value) });
      sourceBreakpoints.forEach((value, index) => { if (result.breakpoints?.[index]) protocolBreakpoints.set(value.id, result.breakpoints[index]); });
    }
    entry.breakpointFiles = new Set(groups.keys());
    if (entry.capabilities.supportsFunctionBreakpoints) {
      const functions = state.breakpoints.filter(b => b instanceof FunctionBreakpoint && b.enabled);
      const result = await entry.client.request('setFunctionBreakpoints', {
        breakpoints: functions.map(b => ({ name: b.functionName, condition: b.condition, hitCondition: b.hitCondition })),
      });
      functions.forEach((value, index) => { if (result.breakpoints?.[index]) protocolBreakpoints.set(value.id, result.breakpoints[index]); });
    }
    entry.protocolBreakpoints = protocolBreakpoints;
  }
  async function stopDebugging(session) {
    const entries = session ? [state.sessions.get(session.id)] : [...state.sessions.values()];
    for (const entry of entries.filter(Boolean)) {
      entry.stopping = true;
      try { await entry.client.request('disconnect', { terminateDebuggee: true }, 2000); }
      finally { entry.client.close(); }
    }
  }
  const debug = {
    get activeDebugSession() { return state.activeDebugSession?.session; },
    get breakpoints() { return [...state.breakpoints]; },
    activeDebugConsole: { append: value => host.log(ext.id, 'Debug', String(value)), appendLine: value => host.log(ext.id, 'Debug', String(value) + '\n') },
    onDidStartDebugSession: on('start'), onDidTerminateDebugSession: on('terminate'), onDidChangeActiveDebugSession: on('active'), onDidReceiveDebugSessionCustomEvent: on('custom'), onDidChangeBreakpoints: on('breakpoints'),
    registerDebugAdapterTrackerFactory(type, factory) {
      need('workspaceRead');
      if (typeof type !== 'string' || !type || typeof factory?.createDebugAdapterTracker !== 'function') failure('A debug tracker factory requires a type and createDebugAdapterTracker implementation.');
      const id = randomUUID(); const registration = { extension: ext.id, type, factory, enabled: true };
      state.trackers.set(id, registration);
      return track(new Disposable(() => { registration.enabled = false; state.trackers.delete(id); }));
    },
    registerDebugConfigurationProvider(type, provider) { return register(state.configurations, type, provider); },
    registerDebugAdapterDescriptorFactory(type, factory) { need('processExecution'); return register(state.factories, type, factory); },
    addBreakpoints(values) {
      for (const b of values) if (!(b instanceof SourceBreakpoint) && !(b instanceof FunctionBreakpoint)) failure('Unsupported breakpoint type.');
      const added = values.filter(b => !state.breakpoints.some(old => old.id === b.id)); state.breakpoints.push(...added);
      fire('breakpoints', { added, removed: [], changed: [] });
      for (const session of state.sessions.values()) void synchronize(session).catch(error => host.log(ext.id, 'Debug', error.message)); update();
    },
    removeBreakpoints(values) {
      const ids = new Set(values.map(b => b.id)); const removed = state.breakpoints.filter(b => ids.has(b.id));
      state.breakpoints = state.breakpoints.filter(b => !ids.has(b.id)); fire('breakpoints', { added: [], removed, changed: [] });
      for (const session of state.sessions.values()) void synchronize(session).catch(error => host.log(ext.id, 'Debug', error.message)); update();
    },
    async startDebugging(folder, config) {
      need('processExecution');
      require('./workbench.js').requireTrust(host);
      if (typeof config === 'string') {
        config = (host.state.configuration['launch.configurations'] || []).find(value => value.name === config);
        if (!config) failure('The named debug configuration was not found.');
      }
      if (!config || !['launch', 'attach'].includes(config.request)) failure('A launch or attach debug configuration is required.');
      await host.activateByEvent?.('onDebug');
      await host.activateByEvent?.('onDebugAdapterProtocolTracker');
      await host.activateByEvent?.(`onDebugResolve:${config.type}`);
      const configuration = state.configurations.get(config.type); const source = new CancellationTokenSource();
      try {
        if (configuration?.value.resolveDebugConfiguration) config = await owned(host, configuration.extension, () => configuration.value.resolveDebugConfiguration(folder, config, source.token));
        if (!config) return false;
        const base = folder?.uri?.fsPath || host.state.workspaceFolders[0]?.path;
        const substitute = value => typeof value === 'string' ? value.replace(/\$\{workspaceFolder\}/g, base || '')
          : Array.isArray(value) ? value.map(substitute) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)])) : value;
        config = substitute(config);
        if (configuration?.value.resolveDebugConfigurationWithSubstitutedVariables) config = await owned(host, configuration.extension, () => configuration.value.resolveDebugConfigurationWithSubstitutedVariables(folder, config, source.token));
        if (!config) return false;
        const factory = state.factories.get(config.type); if (!factory) failure(`No debug adapter factory for '${config.type}'.`);
        const id = randomUUID(); const entry = { extension: factory.extension, session: null, client: null, status: 'starting', output: [], capabilities: {}, breakpointFiles: new Set() };
        const session = { id, type: config.type, name: config.name || config.type, workspaceFolder: folder, configuration: config,
          customRequest: (command, args) => entry.client.request(command, args),
          getDebugProtocolBreakpoint: async breakpoint => { const value = entry.protocolBreakpoints?.get(breakpoint.id); return value ? structuredClone(value) : undefined; } };
        entry.session = session;
        const descriptor = await owned(host, factory.extension, () => factory.value.createDebugAdapterDescriptor(session, undefined));
        const owner = host.state.extensions.get(factory.extension);
        if (!owner?.permissions?.includes('processExecution')) failure('The debug adapter extension needs processExecution permission.');
        if (typeof config.program === 'string' && config.program) require('./guard.js').createGuard(owner, () => host.state.workspaceFolders)
          .checkPath(path.resolve(base || owner.path, config.program), false);
        if (descriptor instanceof DebugAdapterServer && !owner.permissions.includes('network')) failure('The debug adapter extension needs network permission.');
        const finish = () => {
          if (!state.sessions.has(id)) return; state.sessions.delete(id);
          if (state.activeDebugSession === entry) { state.activeDebugSession = [...state.sessions.values()].at(-1); fire('active', state.activeDebugSession?.session); }
          fire('terminate', session); update();
        };
        if (![DebugAdapterExecutable, DebugAdapterServer, DebugAdapterInlineImplementation].some(type => descriptor instanceof type)) failure('Unsupported debug adapter descriptor.');
        const debugTerminals = new Set();
        const trackers = [];
        for (const registration of state.trackers.values()) {
          if (registration.type !== '*' && registration.type !== config.type) continue;
          try {
            const tracker = await owned(host, registration.extension, () => registration.factory.createDebugAdapterTracker(session));
            if (tracker && registration.enabled) trackers.push({ registration, tracker });
          } catch (error) { host.log(registration.extension, 'error', `Debug tracker creation failed: ${error.message}`); }
        }
        const observe = (method, ...args) => {
          for (const { registration, tracker } of trackers) {
            if (!registration.enabled || typeof tracker[method] !== 'function') continue;
            try {
              const values = args.map(value => value instanceof Error ? new Error(value.message) : structuredClone(value));
              const result = owned(host, registration.extension, () => tracker[method](...values));
              if (result && typeof result.then === 'function') result.catch(error => host.log(registration.extension, 'error', `Debug tracker ${method} failed: ${error.message}`));
            } catch (error) { host.log(registration.extension, 'error', `Debug tracker ${method} failed: ${error.message}`); }
          }
        };
        observe('onWillStartSession');
        entry.client = new DapClient(descriptor, (event, body) => owned(host, factory.extension, () => {
          if (event === 'output') entry.output = limit([...entry.output, String(body.output || '').slice(0, 16384)], 200);
          if (event === 'stopped') { entry.status = 'paused'; entry.threadId = body.threadId; }
          if (event === 'continued') entry.status = 'running';
          if (event === 'breakpoint' && body.breakpoint?.id !== undefined) {
            for (const [key, value] of entry.protocolBreakpoints || []) if (value.id === body.breakpoint.id) {
              if (body.reason === 'removed') entry.protocolBreakpoints.delete(key);
              else entry.protocolBreakpoints.set(key, { ...value, ...body.breakpoint });
            }
          }
          if (event === 'clientClosed') state.debugClients.delete(id);
          if (event === 'terminated' || event === 'clientClosed') {
            finish();
            if (event === 'terminated' && !entry.stopping) {
              entry.stopping = true;
              void entry.client.request('disconnect', { terminateDebuggee: false }, 2000).catch(() => {}).finally(() => entry.client.close());
            }
          }
          else if (!['initialized', 'output', 'stopped', 'continued', 'breakpoint', 'thread', 'exited', 'process', 'module', 'loadedSource', 'capabilities', 'progressStart', 'progressUpdate', 'progressEnd', 'invalidated', 'memory'].includes(event)) fire('custom', { session, event, body }); update();
        }), value => { entry.output = limit([...entry.output, value], 200); update(); }, observe, fn => owned(host, factory.extension, fn), async (command, args) => {
          require('./workbench.js').requireTrust(host);
          if (command === 'startDebugging') {
            if (!args.configuration || !['launch', 'attach'].includes(args.request)) failure('Invalid child debug configuration.');
            const api = host.state.running.get(factory.extension)?.api;
            if (!api) failure('The debug extension is no longer active.');
            const started = await api.debug.startDebugging(folder, { ...args.configuration, request: args.request });
            if (!started) failure('Child debug session was cancelled.');
            return {};
          }
          if (command !== 'runInTerminal') failure(`Unsupported debug reverse request: ${command}`);
          if (!owner.permissions.includes('terminal')) failure('The debug adapter extension needs terminal permission.');
          if (args.kind === 'external') failure('External debug terminals are not available; select integrated.');
          if (args.argsCanBeInterpretedByShell) failure('Shell-interpreted debugger arguments are not supported.');
          if (!Array.isArray(args.args) || !args.args.length || args.args.some(value => typeof value !== 'string' || value.includes('\0'))) failure('Invalid debug terminal arguments.');
          const cwd = args.cwd || base || owner.path;
          require('./guard.js').createGuard(owner, () => host.state.workspaceFolders).checkPath(cwd, false);
          const terminalId = `${factory.extension}#debug-${id}-${debugTerminals.size}`; debugTerminals.add(terminalId);
          const result = await host.request('terminal/runDebuggee', { extension: factory.extension, id: terminalId, name: args.title || session.name, cwd, args: args.args, env: args.env || {} });
          if (entry.client.closed) host.notify('terminal/dispose', { extension: factory.extension, id: terminalId });
          return result || {};
        }, () => { for (const terminal of debugTerminals) host.notify('terminal/dispose', { extension: factory.extension, id: terminal }); debugTerminals.clear(); });
        if (!entry.client.closed) state.debugClients.set(id, entry);
        state.sessions.set(id, entry); state.activeDebugSession = entry; update();
        const initialized = entry.client.wait('initialized'); initialized.catch(() => {});
        try {
          entry.capabilities = await entry.client.request('initialize', { clientID: 'openmind-studio', adapterID: config.type,
            pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: owner.permissions.includes('terminal'), supportsStartDebuggingRequest: true });
          const launch = entry.client.request(config.request, config, 30000); launch.catch(() => {});
          await initialized; await synchronize(entry);
          if (entry.capabilities.supportsConfigurationDoneRequest) await entry.client.request('configurationDone');
          await launch; if (entry.status === 'starting') entry.status = 'running';
          fire('start', session); fire('active', session); host.notify('workbench/show', { domain: 'debug' }); update(); return true;
        } catch (error) { entry.client.close(error, true); finish(); throw error; }
      } finally { source.dispose(); }
    },
    stopDebugging,
  };
  track(new Disposable(() => {
    for (const entry of [...state.debugClients.values()]) if (entry.extension === ext.id) entry.client.close();
    for (const [type, value] of state.configurations) if (value.extension === ext.id) state.configurations.delete(type);
    for (const [type, value] of state.factories) if (value.extension === ext.id) state.factories.delete(type);
    update();
  }));
  return debug;
}
function snapshot(host) {
  const state = registry(host);
  return { types: [...new Set([...state.factories.keys(), ...(host.contributions?.('debuggers') || []).map(value => value.type).filter(value => typeof value === 'string' && value)])], breakpoints: state.breakpoints.filter(b => b.location).map(b => ({ id: b.id, path: b.location.uri.fsPath, line: b.location.range.start.line + 1, enabled: b.enabled })),
    sessions: [...state.sessions.values()].map(e => ({ id: e.session.id, name: e.session.name, type: e.session.type, state: e.status, threadId: e.threadId, output: e.output })) };
}
async function invoke(host, params) {
  const state = registry(host);
  if (params.op === 'start') {
    require('./workbench.js').requireTrust(host);
    await host.activateByEvent?.('onDebug');
    await host.activateByEvent?.('onDebugAdapterProtocolTracker');
    await host.activateByEvent?.(`onDebugResolve:${params.configuration?.type}`);
    const factory = state.factories.get(params.configuration?.type); if (!factory) failure('Choose a registered debug adapter type.');
    const api = host.state.running.get(factory.extension)?.api; if (!api) failure('The debug extension is not active.');
    return owned(host, factory.extension, () => api.debug.startDebugging(api.workspace.workspaceFolders?.[0], params.configuration));
  }
  const entry = state.sessions.get(params.session); if (!entry) failure('Debug session not found.');
  return owned(host, entry.extension, async () => {
    if (params.op === 'stop') {
      entry.stopping = true;
      try { await entry.client.request('disconnect', { terminateDebuggee: true }, 2000); } finally { entry.client.close(); } return true;
    }
    const allowed = ['threads', 'stackTrace', 'scopes', 'variables', 'evaluate', 'continue', 'pause', 'next', 'stepIn', 'stepOut', 'restart', 'setBreakpoints'];
    if (!allowed.includes(params.op)) failure('Unsupported debug workbench operation.');
    return entry.client.request(params.op, params.arguments || {});
  });
}
module.exports = { create, snapshot, invoke, DapClient, DebugAdapterExecutable, DebugAdapterServer, DebugAdapterInlineImplementation, SourceBreakpoint, FunctionBreakpoint };
