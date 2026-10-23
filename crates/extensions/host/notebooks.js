'use strict';
const { randomUUID } = require('crypto');
const { registry, changed, owned, key, failure, limit } = require('./workbench.js');
const NotebookCellKind = { Markup: 1, Code: 2 };
class NotebookRange {
  constructor(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) throw new TypeError('Invalid notebook cell range.');
    this.start = Math.min(start, end); this.end = Math.max(start, end);
  }
  get isEmpty() { return this.start === this.end; }
  with(change = {}) { return new NotebookRange(change.start ?? this.start, change.end ?? this.end); }
}
class NotebookEdit {
  constructor(range, newCells) { this.range = range; this.newCells = newCells; }
  static replaceCells(range, newCells) { return new NotebookEdit(range, newCells); }
  static insertCells(index, newCells) { return new NotebookEdit(new NotebookRange(index, index), newCells); }
  static deleteCells(range) { return new NotebookEdit(range, []); }
  static updateCellMetadata(index, metadata) {
    const edit = new NotebookEdit(new NotebookRange(index, index), []); edit.newCellMetadata = metadata; return edit;
  }
  static updateNotebookMetadata(metadata) {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []); edit.newNotebookMetadata = metadata; return edit;
  }
}
class NotebookCellData {
  constructor(kind, value, languageId) {
    this.kind = kind; this.value = value; this.languageId = languageId; this.metadata = {}; this.outputs = [];
  }
}
class NotebookData { constructor(cells) { this.cells = cells; this.metadata = {}; } }
class NotebookCellOutputItem {
  constructor(data, mime) { this.data = new Uint8Array(data); this.mime = mime; }
  static text(value, mime = 'text/plain') { return new NotebookCellOutputItem(Buffer.from(String(value)), mime); }
  static json(value, mime = 'application/json') { return NotebookCellOutputItem.text(JSON.stringify(value), mime); }
  static stdout(value) { return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stdout'); }
  static stderr(value) { return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stderr'); }
  static error(error) { return NotebookCellOutputItem.json({ name: error.name, message: error.message, stack: error.stack }, 'application/vnd.code.notebook.error'); }
}
class NotebookCellOutput { constructor(items, metadata = {}) { this.id = randomUUID(); this.items = items; this.metadata = metadata; } }

function create(parts) {
  const { host, ext, need, track, Disposable, EventEmitter, CancellationTokenSource, Uri, workspace, editors } = parts;
  const state = registry(host); const update = () => changed(host, 'notebooks');
  function registerNotebookSerializer(type, serializer, options = {}) {
    need('workspaceRead');
    if (!type || state.serializers.has(type)) failure('A notebook serializer needs a unique type.');
    if (typeof serializer?.serializeNotebook !== 'function' || typeof serializer?.deserializeNotebook !== 'function') failure('Notebook serializers need read and write implementations.');
    state.serializers.set(type, { extension: ext.id, serializer, options, fs: workspace.fs }); update();
    return track(new Disposable(() => {
      state.serializers.delete(type);
      // Keep open data, including unsaved cells, when an extension is disabled.
      update();
    }));
  }
  async function openNotebookDocument(typeOrUri, data) {
    need('workspaceRead');
    let type, uri, notebookData;
    if (typeof typeOrUri === 'string') {
      type = typeOrUri; uri = Uri.parse(`untitled:/notebook-${randomUUID()}`); notebookData = data || new NotebookData([]);
    } else {
      uri = typeOrUri;
      const existing = state.notebooks.get(uri.toString()); if (existing) return existing.document;
      // The UI supplies a type when a filename contribution cannot be inferred.
      const candidates = [...state.serializers].filter(([candidate, value]) => {
        if (data?.notebookType) return candidate === data.notebookType;
        const descriptor = host.state.extensions.get(value.extension);
        const contributed = (descriptor?.packageJSON || descriptor?.manifest)?.contributes?.notebooks || [];
        return contributed.some(notebook => notebook.type === candidate && notebook.selector?.some(selector =>
          require('./workspace.js').globToRegExp(typeof selector === 'string' ? selector : selector.filenamePattern).test(uri.fsPath.replace(/\\/g, '/'))));
      }).map(([type]) => type);
      if (candidates.length !== 1) failure('Choose the notebook serializer type before opening this file.');
      type = candidates[0];
      const entry = state.serializers.get(type); const token = new CancellationTokenSource();
      try { notebookData = await owned(host, entry.extension, async () => entry.serializer.deserializeNotebook(await entry.fs.readFile(uri), token.token)); }
      finally { token.dispose(); }
    }
    const serializer = state.serializers.get(type); if (!serializer) failure(`No serializer for '${type}'.`);
    if (!Array.isArray(notebookData?.cells)) failure('The notebook serializer returned invalid cells.');
    notebookData = structuredClone(notebookData);
    const entry = { document: null, data: notebookData, cells: [], executions: new Set(), closed: false, dirty: uri.scheme === 'untitled', version: 1, serializer, uri };
    const doc = {
      uri, notebookType: type,
      get version() { return entry.version; }, get isDirty() { return entry.dirty; },
      get isClosed() { return entry.closed; }, get isUntitled() { return uri.scheme === 'untitled'; },
      get metadata() { return entry.data.metadata || {}; }, get cellCount() { return entry.cells.length; },
      cellAt(index) { if (!entry.cells[index]) failure('Notebook cell index out of range.'); return entry.cells[index]; },
      getCells(range) { return entry.cells.slice(range?.start ?? 0, range?.end ?? entry.cells.length); },
      async save() {
        if (entry.closed) failure('The notebook is closed.');
        if (uri.scheme === 'untitled') failure('Choose a file path before saving an untitled notebook.');
        const token = new CancellationTokenSource();
        const version = entry.version;
        try {
          const currentSerializer = state.serializers.get(type);
          if (!currentSerializer) failure('The notebook serializer is unavailable. Unsaved cells are retained.');
          await owned(host, currentSerializer.extension, async () => {
            const bytes = await currentSerializer.serializer.serializeNotebook(structuredClone(entry.data), token.token);
            if (entry.version !== version) failure('The notebook changed during serialization; retry saving.');
            await currentSerializer.fs.writeFile(uri, bytes);
          });
          entry.dirty = false; host.events.fire('notebookSaved', doc); update(); return true;
        } finally { token.dispose(); }
      },
    };
    entry.document = doc;
    entry.createCell = value => {
      const cellUri = Uri.parse(`vscode-notebook-cell:/${randomUUID()}`);
      const file = cellUri.toString();
      const data = { path: file, text: value.value, languageId: value.languageId, version: 1, virtual: true };
      const cell = {
        get index() { return entry.cells.indexOf(cell); }, notebook: doc, kind: value.kind,
        document: editors.document(data),
        get metadata() { return value.metadata || {}; }, get outputs() { return value.outputs || []; },
        get executionSummary() { return value.executionSummary; },
      };
      return { cell, data };
    };
    notebookData.cells.forEach(value => {
      const { cell, data } = entry.createCell(value);
      entry.cells.push(cell); host.state.documents.set(data.path, data); host.events.fire('documentOpened', data);
    });
    state.notebooks.set(uri.toString(), entry); host.events.fire('notebookOpened', doc); update(); return doc;
  }
  const notebooks = {
    createNotebookController(id, notebookType, label, executeHandler) {
      need('workspaceRead');
      const handle = key(ext, id); if (!id || state.controllers.has(handle)) failure('A notebook controller needs a unique id.');
      const selected = new EventEmitter();
      let disposed = false;
      const controller = { id, notebookType, label, executeHandler, supportedLanguages: [], supportsExecutionOrder: false,
        description: undefined, detail: undefined, onDidChangeSelectedNotebooks: selected.event,
        updateNotebookAffinity() { throw require('./unsupported.js').unsupportedError('NotebookController.updateNotebookAffinity'); },
        createNotebookCellExecution(cell) {
          if (disposed) failure('The notebook controller was disposed.');
          const entry = state.notebooks.get(cell.notebook.uri.toString());
          if (!entry || entry.closed || cell.notebook.notebookType !== notebookType || !entry.cells.includes(cell)) failure('Notebook cell is not available to this controller.');
          if ([...entry.executions].some(active => active.cell === cell)) failure('This notebook cell is already executing.');
          const source = new CancellationTokenSource();
          let ended = false, started = false;
          const execution = { cell, controller, extension: ext.id, token: source.token, source, executionOrder: undefined,
            start(startTime = Date.now()) {
              if (ended || started) failure('Notebook execution has already started or ended.');
              started = true; entry.data.cells[cell.index].executionSummary = { timing: { startTime } }; update();
            },
            end(success, endTime = Date.now()) {
              if (ended) return; ended = true;
              const value = entry.data.cells[cell.index];
              value.executionSummary = { executionOrder: execution.executionOrder, success, timing: { ...value.executionSummary?.timing, endTime } };
              entry.executions.delete(execution); source.dispose(); entry.dirty = true; entry.version++; update();
            },
          };
          const output = (values, append, target = cell) => {
            if (ended || target !== cell) failure('Notebook execution is no longer active or targets a different cell.');
            const data = entry.data.cells[cell.index]; data.outputs = append ? [...(data.outputs || []), ...values] : values;
            entry.dirty = true; entry.version++; update(); return Promise.resolve();
          };
          execution.replaceOutput = (values, target) => output(Array.isArray(values) ? values : [values], false, target);
          execution.appendOutput = (values, target) => output(Array.isArray(values) ? values : [values], true, target);
          execution.clearOutput = target => output([], false, target);
          const outputItems = (items, target, append) => {
            if (ended) failure('Notebook execution is no longer active.');
            const existing = (entry.data.cells[cell.index].outputs || []).find(value => value === target || value.id === target.id);
            if (!existing) failure('This output does not belong to the executing cell.');
            existing.items = append ? [...existing.items, ...items] : items; entry.dirty = true; entry.version++; update(); return Promise.resolve();
          };
          execution.replaceOutputItems = (items, target) => outputItems(items, target, false);
          execution.appendOutputItems = (items, target) => outputItems(items, target, true);
          entry.executions.add(execution); update(); return execution;
        },
        dispose() {
          if (disposed) return; disposed = true; state.controllers.delete(handle);
          for (const entry of state.notebooks.values()) for (const execution of [...entry.executions]) {
            if (execution.controller === controller) { owned(host, ext.id, () => execution.source.cancel()); execution.end(undefined); }
          }
          selected.dispose(); update();
        },
      };
      state.controllers.set(handle, { extension: ext.id, controller, selected });
      track(new Disposable(() => controller.dispose())); update(); return controller;
    },
  };
  const event = name => (listener, thisArg, disposables) => track(host.events.on(name)((value) => owned(host, ext.id, () => listener.call(thisArg, value)), undefined, disposables));
  return { notebooks, workspace: {
    registerNotebookSerializer, openNotebookDocument,
    get notebookDocuments() { return [...state.notebooks.values()].map(entry => entry.document); },
    onDidOpenNotebookDocument: event('notebookOpened'), onDidCloseNotebookDocument: event('notebookClosed'),
    onDidSaveNotebookDocument: event('notebookSaved'), onDidChangeNotebookDocument: event('notebookChanged'),
  }, window: {
    async showNotebookDocument(document) {
      if (!state.notebooks.has(document.uri.toString())) failure('The notebook is not open.');
      host.notify('workbench/show', { domain: 'notebooks' });
      const editor = { notebook: document, visibleRanges: [], viewColumn: 1 };
      for (const property of ['selection', 'selections']) Object.defineProperty(editor, property, {
        enumerable: true,
        get() { throw require('./unsupported.js').unsupportedError(`NotebookEditor.${property}`); },
        set() { throw require('./unsupported.js').unsupportedError(`NotebookEditor.${property}`); },
      });
      return editor;
    },
  } };
}
// Validate every affected notebook before publishing any mutations. Mixed regular text/file
// transactions are rejected by the caller until a shared workbench transaction exists.
function applyEdits(host, buckets, checkEditable) {
  const state = registry(host); const plans = [];
  for (const { uri, edits } of buckets) {
    const entry = state.notebooks.get(uri.toString());
    if (!entry || entry.closed) failure('Notebook edit targets a document that is not open.');
    if (uri.scheme === 'file') checkEditable(uri.fsPath);
    if (entry.executions.size) failure('Stop notebook execution before applying structural edits.');
    const replacements = [], metadataEdits = [];
    let metadata = entry.data.metadata, metadataChanged = false;
    for (const edit of edits) {
      const { start, end } = edit.range || {};
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > entry.cells.length || !Array.isArray(edit.newCells)) failure('Invalid notebook edit range or cells.');
      const hasNotebookMetadata = edit.newNotebookMetadata !== undefined;
      const hasCellMetadata = edit.newCellMetadata !== undefined;
      if (hasNotebookMetadata && hasCellMetadata) failure('A notebook edit cannot update both notebook and cell metadata.');
      if (hasNotebookMetadata || hasCellMetadata) {
        const value = hasNotebookMetadata ? edit.newNotebookMetadata : edit.newCellMetadata;
        if (!value || typeof value !== 'object' || Array.isArray(value) || edit.newCells.length || start !== end) failure('Invalid notebook metadata edit.');
        if (hasNotebookMetadata) { metadata = structuredClone(value); metadataChanged = true; }
        else { if (start >= entry.cells.length) failure('Notebook metadata cell index out of range.'); metadataEdits.push({ index: start, value: structuredClone(value) }); }
      } else if (start !== end || edit.newCells.length) {
        const cells = edit.newCells.map(cell => {
          if (!cell || ![1, 2].includes(cell.kind) || typeof cell.value !== 'string' || typeof cell.languageId !== 'string') failure('Invalid notebook cell data.');
          if (cell.outputs !== undefined && !Array.isArray(cell.outputs)) failure('Invalid notebook cell outputs.');
          return structuredClone(cell);
        });
        replacements.push({ start, end, cells });
      }
    }
    replacements.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < replacements.length; i++) {
      if (replacements[i].start < replacements[i - 1].end || replacements[i].start === replacements[i - 1].start) failure('Overlapping notebook edits are not allowed.');
    }
    for (const edit of metadataEdits) if (replacements.some(range => edit.index >= range.start && edit.index < range.end)) failure('Cannot update metadata of a cell removed by the same edit.');
    plans.push({ entry, replacements, metadataEdits, metadata, metadataChanged });
  }
  // Allocation also completes before existing state changes.
  for (const plan of plans) for (const edit of plan.replacements) edit.created = edit.cells.map(value => plan.entry.createCell(value));
  const notifications = [];
  for (const { entry, replacements, metadataEdits, metadata, metadataChanged } of plans) {
    const cellChanges = [], contentChanges = [], opened = [], closed = [];
    for (const edit of metadataEdits) {
      entry.data.cells[edit.index].metadata = edit.value;
      cellChanges.push({ cell: entry.cells[edit.index], metadata: edit.value, document: undefined, outputs: undefined, executionSummary: undefined });
    }
    for (const edit of [...replacements].reverse()) {
      const removedCells = entry.cells.splice(edit.start, edit.end - edit.start, ...edit.created.map(value => value.cell));
      entry.data.cells.splice(edit.start, edit.end - edit.start, ...edit.cells);
      contentChanges.unshift({ range: new NotebookRange(edit.start, edit.end), addedCells: edit.created.map(value => value.cell), removedCells });
      for (const cell of removedCells) {
        const key = cell.document.uri.toString(); closed.push(host.state.documents.get(key)); host.state.documents.delete(key);
      }
      for (const value of edit.created) { host.state.documents.set(value.data.path, value.data); opened.push(value.data); }
    }
    if (metadataChanged) entry.data.metadata = metadata;
    if (!replacements.length && !metadataEdits.length && !metadataChanged) continue;
    entry.version++; entry.dirty = true;
    notifications.push({ entry, closed, opened, metadataChanged, metadata, contentChanges, cellChanges });
  }
  for (const { entry, closed, opened, metadataChanged, metadata, contentChanges, cellChanges } of notifications) {
    for (const data of closed) host.events.fire('documentClosed', data);
    for (const data of opened) host.events.fire('documentOpened', data);
    host.events.fire('notebookChanged', { notebook: entry.document, metadata: metadataChanged ? metadata : undefined, contentChanges, cellChanges });
  }
  changed(host, 'notebooks'); return true;
}
function closeDocument(host, entry) {
  for (const execution of [...entry.executions]) { owned(host, execution.extension, () => execution.source.cancel()); execution.end(undefined); }
  entry.closed = true; registry(host).notebooks.delete(entry.uri.toString());
  for (const cell of entry.cells) { const key = cell.document.uri.toString(); const value = host.state.documents.get(key); host.state.documents.delete(key); host.events.fire('documentClosed', value); }
  host.events.fire('notebookClosed', entry.document); changed(host, 'notebooks');
}
function snapshot(host) {
  const state = registry(host);
  return { serializers: [...state.serializers.keys()],
    controllers: [...state.controllers].map(([handle, { controller }]) => ({ handle, id: controller.id, label: controller.label, notebookType: controller.notebookType })),
    documents: [...state.notebooks].map(([uri, entry]) => ({ uri, notebookType: entry.document.notebookType, dirty: entry.dirty, version: entry.version,
      unavailable: !state.serializers.has(entry.document.notebookType),
      cells: entry.data.cells.map((cell, index) => ({ id: entry.cells[index].document.uri.toString(), index, kind: cell.kind, languageId: cell.languageId, value: cell.value,
        running: [...entry.executions].some(execution => execution.cell.index === index), summary: cell.executionSummary,
        outputs: (cell.outputs || []).flatMap(output => output.items).map(item => ({ mime: item.mime,
          text: Buffer.from(item.data).toString('utf8').slice(0, 16384) })) })).slice(0, 1000) })) };
}
async function invoke(host, params) {
  const state = registry(host);
  if (params.op === 'open' || params.op === 'new') {
    const serializer = state.serializers.get(params.type); if (!serializer) failure('Notebook serializer not found.');
    const api = host.state.running.get(serializer.extension)?.api; if (!api) failure('The notebook extension is not active.');
    const document = await owned(host, serializer.extension, () => params.op === 'new'
      ? api.workspace.openNotebookDocument(params.type, new NotebookData([new NotebookCellData(NotebookCellKind.Code, '', String(params.languageId || 'plaintext'))]))
      : api.workspace.openNotebookDocument(require('./vscode.js').Uri.file(params.path), { notebookType: params.type }));
    return document.uri.toString();
  }
  const entry = state.notebooks.get(params.uri); if (!entry) failure('Notebook not found.');
  if (params.op === 'insert' || params.op === 'delete') {
    const sameCells = Array.isArray(params.cellIds) && params.cellIds.length === entry.cells.length && params.cellIds.every((id, index) => id === entry.cells[index].document.uri.toString());
    if (params.version !== entry.version && !sameCells) failure('The notebook changed; refresh before changing its structure.');
    const serializer = state.serializers.get(entry.document.notebookType);
    const api = serializer && host.state.running.get(serializer.extension)?.api;
    if (!api) failure('The notebook serializer is unavailable.');
    if (!Number.isInteger(params.index)) failure('Notebook cell index must be an integer.');
    const edit = new api.WorkspaceEdit();
    edit.set(entry.uri, [params.op === 'insert'
      ? NotebookEdit.insertCells(params.index, [new NotebookCellData(NotebookCellKind.Code, '', String(params.languageId || 'plaintext'))])
      : NotebookEdit.deleteCells(new NotebookRange(params.index, params.index + 1))]);
    return owned(host, serializer.extension, () => api.workspace.applyEdit(edit));
  }
  if (params.op === 'saveAs') {
    if (entry.executions.size) failure('Stop notebook execution before saving to a new path.');
    if (typeof params.path !== 'string' || !params.path.trim()) failure('Choose a destination file path.');
    const serializer = state.serializers.get(entry.document.notebookType);
    const api = serializer && host.state.running.get(serializer.extension)?.api;
    if (!api) failure('The notebook serializer is unavailable. Unsaved cells are retained.');
    const target = require('./vscode.js').Uri.file(params.path);
    if (state.notebooks.has(target.toString())) failure('The destination notebook is already open. Choose a new path.');
    const version = entry.version; const token = new api.CancellationTokenSource();
    try {
      await owned(host, serializer.extension, async () => {
        const bytes = await serializer.serializer.serializeNotebook(structuredClone(entry.data), token.token);
        if (entry.closed || entry.version !== version) failure('The notebook changed during serialization; retry saving.');
        if (state.serializers.get(entry.document.notebookType) !== serializer) failure('The notebook serializer became unavailable. Unsaved cells are retained.');
        // Exclusive creation protects existing files, including a destination created concurrently.
        await serializer.fs.writeFile(target, bytes, { overwrite: false });
      });
      const document = await owned(host, serializer.extension, () => api.workspace.openNotebookDocument(target, { notebookType: entry.document.notebookType }));
      host.events.fire('notebookSaved', document);
      if (!entry.closed && entry.version === version) closeDocument(host, entry);
      // If an edit arrived while writing, preserve the original document with its newer changes.
      return document.uri.toString();
    } finally { token.dispose(); }
  }
  if (params.op === 'save') return entry.document.save();
  if (params.op === 'close') { if (entry.dirty && !params.discard) failure('Save or explicitly discard notebook changes before closing.'); closeDocument(host, entry); return true; }
  if (params.op === 'edit') {
    const cell = entry.cells[params.index]; if (!cell) failure('Notebook cell not found.');
    if (params.version !== entry.version && (!Object.hasOwn(params, 'previousValue') || String(params.previousValue) !== entry.data.cells[params.index].value)) failure('The notebook changed; reload before editing.');
    entry.data.cells[params.index].value = String(params.value);
    const data = host.state.documents.get(cell.document.uri.toString()); data.text = String(params.value); data.version++; data.isDirty = true;
    entry.version++; entry.dirty = true; host.events.fire('documentChanged', data);
    host.events.fire('notebookChanged', { notebook: entry.document, cellChanges: [{ cell, document: cell.document }], contentChanges: [], metadata: undefined });
    changed(host, 'notebooks'); return true;
  }
  if (params.op === 'cancel') {
    for (const execution of [...entry.executions]) owned(host, execution.extension, () => { execution.source.cancel(); execution.end(undefined); }); return true;
  }
  if (params.op !== 'execute') failure('Unsupported notebook operation.');
  require('./workbench.js').requireTrust(host);
  const target = state.controllers.get(params.controller); if (!target || target.controller.notebookType !== entry.document.notebookType) failure('Choose a compatible notebook controller.');
  if (typeof target.controller.executeHandler !== 'function') failure('The notebook controller has no execution handler.');
  const cells = params.indices ? params.indices.map(index => entry.document.cellAt(index)) : entry.cells.filter(cell => cell.kind === NotebookCellKind.Code);
  owned(host, target.extension, () => target.selected.fire({ notebook: entry.document, selected: true }));
  try { await owned(host, target.extension, () => target.controller.executeHandler(cells, entry.document, target.controller)); }
  catch (error) {
    for (const execution of [...entry.executions]) if (execution.controller === target.controller && cells.includes(execution.cell)) execution.end(false);
    throw error;
  }
  return true;
}
module.exports = { create, snapshot, invoke, NotebookRange, NotebookEdit, applyEdits, NotebookCellKind, NotebookCellData, NotebookData, NotebookCellOutput, NotebookCellOutputItem };
