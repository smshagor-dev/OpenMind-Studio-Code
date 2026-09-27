'use strict';
// Tasks for OpenMind Studio's extension host (Milestone 18): `tasks.registerTaskProvider`, `tasks.fetchTasks`,
// `tasks.executeTask`, `tasks.taskExecutions`, `onDidStartTask` / `onDidEndTask`, and the `Task`, `ShellExecution`,
// `ProcessExecution`, `TaskGroup`, `TaskScope`, `TaskRevealKind`, `TaskPanelKind` types — a VS Code API subset,
// written for this app. A task only ever runs because the user chose it (Terminal > Run Task...) or confirmed an
// extension's `executeTask` in a dialog that shows its label, command, folder and environment; it runs in a new
// integrated terminal. Providers are asked for their tasks only when the user opens the task list. Everything needs
// the `terminal` permission. Not supported: `CustomExecution` (it throws the "not supported" message); problem
// matchers are recorded and shown as not supported (their output is not parsed); a task ends when its terminal is
// closed (the command inside a shell has no separate end).

const path = require('path');
const { within } = require('./guard.js');

let counter = 0;

const { unsupportedError } = require('./unsupported.js');

const TaskScope = { Global: 1, Workspace: 2 };
const TaskRevealKind = { Always: 1, Silent: 2, Never: 3 };
const TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 };

class TaskGroup {
  constructor(id, label) {
    this.id = id;
    this.label = label;
  }
}
TaskGroup.Clean = new TaskGroup('clean', 'Clean');
TaskGroup.Build = new TaskGroup('build', 'Build');
TaskGroup.Rebuild = new TaskGroup('rebuild', 'Rebuild');
TaskGroup.Test = new TaskGroup('test', 'Test');

class ShellExecution {
  constructor(commandOrLine, argsOrOptions, maybeOptions) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrLine;
      this.args = argsOrOptions;
      this.options = maybeOptions;
    } else {
      this.commandLine = commandOrLine;
      this.options = argsOrOptions;
    }
  }
}

class ProcessExecution {
  constructor(process, argsOrOptions, maybeOptions) {
    this.process = process;
    this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    this.options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;
  }
}

class CustomExecution {
  constructor() {
    throw unsupportedError('CustomExecution');
  }
}

class Task {
  constructor(definition, scopeOrName, nameOrSource, sourceOrExecution, executionOrMatchers, maybeMatchers) {
    // Both the old (definition, name, source, execution, matchers) and the new (definition, scope, name, ...) forms.
    const legacy = typeof scopeOrName === 'string';
    this.definition = definition || {};
    this.scope = legacy ? TaskScope.Workspace : scopeOrName;
    this.name = legacy ? scopeOrName : nameOrSource;
    this.source = legacy ? nameOrSource : sourceOrExecution;
    this.execution = legacy ? sourceOrExecution : executionOrMatchers;
    const matchers = legacy ? executionOrMatchers : maybeMatchers;
    this.problemMatchers = matchers === undefined ? [] : Array.isArray(matchers) ? matchers : [matchers];
    this.group = undefined;
    this.detail = undefined;
    this.isBackground = false;
    this.presentationOptions = {};
    this.runOptions = {};
  }
}

/** What a shell command line of a task would be (for the confirmation dialog and the terminal). */
function commandLineOf(execution) {
  const quote = (part) => {
    const text = typeof part === 'string' ? part : part && part.value !== undefined ? String(part.value) : String(part);
    return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
  };
  if (execution instanceof ShellExecution || (execution && (execution.commandLine || execution.command))) {
    if (execution.commandLine) return String(execution.commandLine);
    return [execution.command, ...(execution.args || [])].map(quote).join(' ');
  }
  if (execution instanceof ProcessExecution || (execution && execution.process)) {
    return [execution.process, ...(execution.args || [])].map(quote).join(' ');
  }
  return null;
}

function createTaskApi({ host, ext, need, track, Disposable, EventEmitter, namespace, asExtension }) {
  const { request, state } = host;
  if (!state.taskProviders) state.taskProviders = new Map(); // type -> { extension, provider }
  if (!state.tasks) state.tasks = new Map(); // handle -> { extension, task }
  if (!state.taskExecutions) state.taskExecutions = new Map(); // handle -> execution

  function registerTaskProvider(type, provider) {
    need('terminal');
    if (typeof type !== 'string' || type === '') throw new Error('registerTaskProvider needs a task type.');
    if (!provider || typeof provider.provideTasks !== 'function') throw new Error('registerTaskProvider needs a provider with provideTasks.');
    const existing = state.taskProviders.get(type);
    if (existing) throw new Error(`Task type '${type}' already has a provider (${existing.extension}).`);
    const entry = { extension: ext.id, provider };
    state.taskProviders.set(type, entry);
    return track(
      new Disposable(() => {
        if (state.taskProviders.get(type) === entry) state.taskProviders.delete(type);
      }),
    );
  }

  async function executeTask(task) {
    need('terminal');
    const described = describeTask(host, ext.id, task);
    const answer = await request('tasks/execute', { extension: ext.id, task: described });
    if (!answer || answer.started !== true) {
      throw new Error(answer && answer.reason ? answer.reason : 'The task was not started.');
    }
    return state.taskExecutions.get(described.handle);
  }

  const listen = (name) => (listener, thisArg, disposables) =>
    track(host.events.on(name)(asExtension((data) => listener(data)), thisArg, disposables));

  const tasks = namespace('tasks', {
    registerTaskProvider,
    executeTask,
    async fetchTasks(filter) {
      need('terminal');
      const list = await provideAll(host, filter && filter.type);
      return list.map((item) => state.tasks.get(item.handle).task);
    },
    get taskExecutions() {
      return [...state.taskExecutions.values()];
    },
    onDidStartTask: listen('taskStarted'),
    onDidEndTask: listen('taskEnded'),
    onDidStartTaskProcess: listen('taskProcessStarted'),
    onDidEndTaskProcess: listen('taskProcessEnded'),
  });
  return { tasks, EventEmitter };
}

/** The serializable description of `task` the app shows and runs; remembers it under a handle. */
function describeTask(host, extensionId, task) {
  if (!(task instanceof Task) && !(task && task.execution !== undefined)) throw new Error('executeTask needs a vscode.Task.');
  const execution = task.execution;
  const commandLine = commandLineOf(execution);
  if (commandLine === null) throw unsupportedError('Task without a ShellExecution or ProcessExecution');
  const options = (execution && execution.options) || {};
  const folders = host.state.workspaceFolders;
  let cwd = options.cwd ? path.resolve(String(options.cwd).replace('${workspaceFolder}', folders[0] ? folders[0].path : '')) : null;
  if (cwd === null) cwd = folders[0] ? folders[0].path : null;
  const insideFolder = cwd !== null && folders.some((folder) => within(folder.path, cwd));
  counter += 1;
  const handle = `${extensionId}#task-${counter}`;
  host.state.tasks.set(handle, { extension: extensionId, task });
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  return {
    handle,
    extension: extensionId,
    name: String(task.name || ''),
    source: String(task.source || extensionId),
    type: String((task.definition && task.definition.type) || ''),
    detail: task.detail === undefined ? null : String(task.detail),
    group: task.group && task.group.id ? task.group.id : null,
    commandLine,
    kind: execution instanceof ProcessExecution || (execution && execution.process) ? 'process' : 'shell',
    cwd,
    cwdInsideFolder: insideFolder,
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), String(value)])),
    problemMatchers: task.problemMatchers.map((m) => (typeof m === 'string' ? m : (m && m.name) || 'custom')),
    isBackground: !!task.isBackground,
  };
}

/** Asks every provider (or those of `type`) for its tasks, each running as its own extension. */
async function provideAll(host, type) {
  const out = [];
  for (const [taskType, entry] of host.state.taskProviders || []) {
    if (type && taskType !== type) continue;
    try {
      const provided = await host.als.run(entry.extension, () =>
        entry.provider.provideTasks({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      );
      for (const task of provided || []) {
        try {
          out.push(describeTask(host, entry.extension, task));
        } catch (error) {
          host.log(entry.extension, 'error', `A task of type '${taskType}' was left out: ${error.message}`);
        }
      }
    } catch (error) {
      host.log(entry.extension, 'error', `provideTasks for '${taskType}' failed: ${error && error.stack ? error.stack : error}`);
    }
  }
  return out;
}

/** `host/taskStarted` / `host/taskEnded`: the app started a task the user chose, or its terminal closed. */
function taskEvent(host, method, params) {
  const known = host.state.tasks && host.state.tasks.get(params.handle);
  if (!known) return;
  if (method === 'host/taskStarted') {
    const execution = { task: known.task, terminate: () => host.notify('tasks/terminate', { handle: params.handle }) };
    host.state.taskExecutions.set(params.handle, execution);
    host.events.fire('taskStarted', { execution });
    host.events.fire('taskProcessStarted', { execution, processId: params.pid });
    return;
  }
  const execution = host.state.taskExecutions.get(params.handle);
  if (!execution) return;
  host.state.taskExecutions.delete(params.handle);
  host.events.fire('taskProcessEnded', { execution, exitCode: params.exitCode });
  host.events.fire('taskEnded', { execution });
}

module.exports = {
  createTaskApi,
  provideAll,
  taskEvent,
  describeTask,
  commandLineOf,
  Task,
  ShellExecution,
  ProcessExecution,
  CustomExecution,
  TaskGroup,
  TaskScope,
  TaskRevealKind,
  TaskPanelKind,
};
