const vscode = require('vscode');

// A tiny in-memory file system for the `memfs:` scheme (read-only: no `isReadonly: false`).
const files = new Map([
  ['/', { type: vscode.FileType.Directory }],
  ['/hello.txt', { type: vscode.FileType.File, data: Buffer.from('Hello from memfs') }],
  ['/docs', { type: vscode.FileType.Directory }],
  ['/docs/readme.md', { type: vscode.FileType.File, data: Buffer.from('# Readme') }],
]);
const writes = [];
const memfs = {
  onDidChangeFile: new vscode.EventEmitter().event,
  watch: () => new vscode.Disposable(() => {}),
  stat(uri) {
    const entry = files.get(uri.path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: entry.type, ctime: 0, mtime: 0, size: entry.data ? entry.data.length : 0 };
  },
  readDirectory(uri) {
    const prefix = uri.path === '/' ? '/' : `${uri.path}/`;
    return [...files.entries()]
      .filter(([name]) => name !== uri.path && name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
      .map(([name, entry]) => [name.slice(prefix.length), entry.type]);
  },
  readFile(uri) {
    const entry = files.get(uri.path);
    if (!entry || !entry.data) throw vscode.FileSystemError.FileNotFound(uri);
    return new Uint8Array(entry.data);
  },
  writeFile(uri, content) {
    writes.push(uri.path);
    files.set(uri.path, { type: vscode.FileType.File, data: Buffer.from(content) });
  },
  createDirectory() {},
  delete() {},
  rename() {},
};

const seen = [];
let terminal;
let watcherEvents = [];

function activate(context) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sampleV2.panel', {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.title = 'Board';
        view.webview.html = '<h1>Board</h1><button>Ping</button>';
        view.webview.onDidReceiveMessage((message) => {
          seen.push(`view:${JSON.stringify(message)}`);
          view.webview.postMessage({ pong: message.ping });
        });
      },
    }),
    vscode.workspace.registerFileSystemProvider('memfs', memfs),
    vscode.tasks.registerTaskProvider('samplev2', {
      provideTasks() {
        const task = new vscode.Task(
          { type: 'samplev2', script: 'build' },
          vscode.TaskScope.Workspace,
          'build',
          'samplev2',
          new vscode.ShellExecution('npm run build', { env: { MODE: 'ci' } }),
          ['$tsc'],
        );
        task.group = vscode.TaskGroup.Build;
        task.detail = 'Builds the project';
        return [task];
      },
    }),
    vscode.languages.registerDocumentFormattingEditProvider('plaintext', {
      provideDocumentFormattingEdits(document) {
        const all = new vscode.Range(0, 0, document.lineCount, 0);
        return [vscode.TextEdit.replace(all, document.getText().toUpperCase())];
      },
    }),
    vscode.window.onDidCloseTerminal((closed) => seen.push(`closed:${closed.name}:${closed.exitStatus && closed.exitStatus.code}`)),
    vscode.window.onDidOpenTerminal((opened) => seen.push(`opened:${opened.name}`)),
    vscode.tasks.onDidStartTask((event) => seen.push(`taskStarted:${event.execution.task.name}`)),
    vscode.tasks.onDidEndTask((event) => seen.push(`taskEnded:${event.execution.task.name}`)),
    vscode.commands.registerTextEditorCommand('sampleV2.shout', (editor, edit) => {
      edit.replace(editor.selection, editor.document.getText(editor.selection).toUpperCase());
    }),
  );

  reg('sampleV2.openTerminal', () => {
    terminal = vscode.window.createTerminal({ name: 'Sample v2' });
    terminal.show();
    return terminal.name;
  });
  reg('sampleV2.echo', async () => terminal.sendText('echo hello from sample v2'));
  reg('sampleV2.terminalInfo', async () => ({ pid: await terminal.processId, count: vscode.window.terminals.length }));
  reg('sampleV2.badTerminal', () => {
    try {
      vscode.window.createTerminal({ name: 'x', shellPath: 'C:/evil.exe' });
      return 'created';
    } catch (e) {
      return e.message;
    }
  });
  reg('sampleV2.runTask', async () => {
    const [task] = await vscode.tasks.fetchTasks({ type: 'samplev2' });
    const execution = await vscode.tasks.executeTask(task);
    return execution ? execution.task.name : null;
  });
  reg('sampleV2.customTask', () => {
    try {
      new vscode.CustomExecution(async () => undefined);
      return 'created';
    } catch (e) {
      return e.message;
    }
  });
  reg('sampleV2.secretStore', async (value) => {
    await context.secrets.store('token', value);
    return true;
  });
  reg('sampleV2.secretGet', async () => (await context.secrets.get('token')) ?? null);
  reg('sampleV2.secretDelete', async () => {
    await context.secrets.delete('token');
    return true;
  });
  reg('sampleV2.findFiles', async () => (await vscode.workspace.findFiles('**/*.ts', '**/skip/**', 10)).map((uri) => uri.fsPath));
  reg('sampleV2.readMem', async (target) => {
    const uri = vscode.Uri.parse(target);
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString();
      const dir = await vscode.workspace.fs.readDirectory(vscode.Uri.parse('memfs:/'));
      return { text, dir };
    } catch (e) {
      return { error: e.code || e.message };
    }
  });
  reg('sampleV2.writeMem', async () => {
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.parse('memfs:/new.txt'), Buffer.from('x'));
      return 'written';
    } catch (e) {
      return `${e.code}|${writes.length}`;
    }
  });
  reg('sampleV2.openMem', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('memfs:/docs/readme.md'));
    await vscode.window.showTextDocument(doc);
    return { uri: doc.uri.toString(), text: doc.getText(), language: doc.languageId };
  });
  reg('sampleV2.watch', () => {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.ts');
    watcher.onDidCreate((uri) => watcherEvents.push(`create:${uri.fsPath}`));
    watcher.onDidDelete((uri) => watcherEvents.push(`delete:${uri.fsPath}`));
    context.subscriptions.push(watcher);
    return true;
  });
  reg('sampleV2.watched', () => watcherEvents);
  reg('sampleV2.activateExtension', async () => {
    const extension = vscode.extensions.getExtension('openmind-samples.sample-api-v2');
    const exports = await extension.activate();
    return {
      active: extension.isActive,
      ready: exports?.ready === true,
      listed: vscode.extensions.all.some((entry) => entry.id === extension.id),
    };
  });
  let extensionChanges = 0;
  context.subscriptions.push(vscode.extensions.onDidChange(() => { extensionChanges += 1; }));
  reg('sampleV2.extensionChangeCount', () => extensionChanges);
  reg('sampleV2.languageValues', () => {
    const range = new vscode.Range(0, 0, 0, 3);
    const action = new vscode.CodeAction('Apply correction', vscode.CodeActionKind.QuickFix);
    const child = new vscode.DocumentSymbol('run', 'function', vscode.SymbolKind.Function, range, range);
    const signature = new vscode.SignatureInformation('run(value)', 'A function');
    signature.parameters.push(new vscode.ParameterInformation('value'));
    return {
      action: action.title,
      quickfixContains: vscode.CodeActionKind.QuickFix.contains(new vscode.CodeActionKind('quickfix.rewrite')),
      sourceVsRefactor: vscode.CodeActionKind.Source.intersects(vscode.CodeActionKind.Refactor),
      lensResolved: new vscode.CodeLens(range, { title: 'Run', command: 'run' }).isResolved,
      linkTarget: new vscode.DocumentLink(range, vscode.Uri.parse('https://example.org')).target.scheme,
      childKind: child.kind,
      foldingKind: new vscode.FoldingRange(0, 3, vscode.FoldingRangeKind.Region).kind,
      signatureParameters: signature.parameters.length,
    };
  });
  reg('sampleV2.languageMatch', () => {
    const document = { languageId: 'typescript', uri: vscode.Uri.file('C:/workspace/index.ts') };
    return {
      exact: vscode.languages.match('typescript', document),
      wildcard: vscode.languages.match('*', document),
      mismatch: vscode.languages.match('python', document),
      glob: vscode.languages.match({ language: 'typescript', pattern: '**/*.ts' }, document),
      brace: vscode.languages.match({ language: 'typescript', pattern: '**/*.{ts,tsx}' }, document),
      otherFile: vscode.languages.match({ language: 'typescript', pattern: '**/*.py' }, document),
      relative: vscode.languages.match({
        language: 'typescript',
        pattern: new vscode.RelativePattern('C:/workspace', '**/*.ts'),
      }, document),
    };
  });
  reg('sampleV2.extensionState', () => {
    const extension = vscode.extensions.getExtension('openmind-samples.sample-api-v2');
    return {
      found: !!extension,
      active: extension?.isActive,
      exportsReady: extension?.exports?.ready === true,
      uri: extension?.extensionUri?.scheme,
    };
  });
  reg('sampleV2.events', () => seen);
  return { ready: true };
}

module.exports = { activate };
