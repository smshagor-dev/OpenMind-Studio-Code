'use strict';
const { registry, changed, owned, key, text, failure, limit } = require('./workbench.js');
function create({ host, ext, need, track, Disposable, EventEmitter }) {
  const state = registry(host);
  return {
    createSourceControl(id, label, rootUri) {
      need('commands');
      const handle = key(ext, id);
      if (!id || state.scm.has(handle)) failure('A source control provider needs a unique id.');
      const selection = new EventEmitter(); const input = new EventEmitter(); const groups = new Map();
      let disposed = false;
      const update = () => { if (!disposed) changed(host, 'scm'); };
      const box = new Proxy({ value: '', placeholder: '', enabled: true, visible: true, validateInput: undefined,
        onDidChange: input.event }, {
        set(target, property, value) { target[property] = value; if (property === 'value') input.fire(value); update(); return true; },
      });
      const control = new Proxy({ id, label, rootUri, inputBox: box, isSelected: false,
        onDidChangeSelection: selection.event, count: undefined, acceptInputCommand: undefined,
        statusBarCommands: [], quickDiffProvider: undefined,
        createResourceGroup(groupId, groupLabel) {
          if (disposed || groups.has(groupId)) failure('Invalid or duplicate source control group.');
          const group = new Proxy({ id: groupId, label: groupLabel, hideWhenEmpty: false, resourceStates: [],
            dispose() { groups.delete(groupId); update(); } }, {
            set(target, property, value) { target[property] = value; update(); return true; },
          });
          groups.set(groupId, group); update(); return group;
        },
        dispose() { if (disposed) return; disposed = true; state.scm.delete(handle); selection.dispose(); input.dispose(); changed(host, 'scm'); },
      }, { set(target, property, value) { target[property] = value; update(); return true; } });
      state.scm.set(handle, { extension: ext.id, control, groups, selection });
      track(new Disposable(() => control.dispose())); update(); return control;
    },
  };
}
function snapshot(host) {
  return { providers: [...registry(host).scm].map(([handle, entry]) => ({ handle, id: entry.control.id, label: entry.control.label,
    root: entry.control.rootUri?.toString(), selected: entry.control.isSelected,
    input: { value: entry.control.inputBox.value, placeholder: entry.control.inputBox.placeholder, enabled: entry.control.inputBox.enabled },
    canAccept: !!entry.control.acceptInputCommand,
    groups: [...entry.groups.values()].map(group => ({ id: group.id, label: group.label, hideWhenEmpty: group.hideWhenEmpty,
      resources: group.resourceStates.map((r, index) => ({ index, uri: r.resourceUri.toString(),
        tooltip: text(r.decorations?.tooltip), strikeThrough: r.decorations?.strikeThrough, faded: r.decorations?.faded, hasCommand: !!r.command })).slice(0, 1000) })) })) };
}
async function invoke(host, params) {
  const state = registry(host); const entry = state.scm.get(params.provider); if (!entry) failure('Source control provider not found.');
  return owned(host, entry.extension, async () => {
    const control = entry.control;
    if (params.op === 'select') {
      for (const candidate of state.scm.values()) {
        const selected = candidate === entry;
        if (candidate.control.isSelected !== selected) {
          candidate.control.isSelected = selected;
          owned(host, candidate.extension, () => candidate.selection.fire(selected));
        }
      }
      return true;
    }
    if (params.op === 'input' || params.op === 'accept') {
      if (!control.inputBox.enabled) failure('The source control input is disabled.');
      if (typeof params.value === 'string') control.inputBox.value = params.value;
      const validation = await control.inputBox.validateInput?.(control.inputBox.value, control.inputBox.value.length);
      if (validation) failure(text(validation.message) || 'Invalid source control input.');
      if (params.op === 'input') return true;
      require('./workbench.js').requireTrust(host);
      const command = control.acceptInputCommand; if (!command) failure('This provider has no input action.');
      return host.runWorkbenchCommand(command);
    }
    const resource = entry.groups.get(params.group)?.resourceStates[params.index];
    if (!resource) failure('Source control resource not found.');
    if (params.op === 'open') {
      if (!resource.command) failure('This source control resource has no command.');
      return host.runWorkbenchCommand(resource.command);
    }
    if (params.op === 'original' || params.op === 'compare') {
      if (!control.quickDiffProvider) failure('This provider has no quick diff support.');
      const uri = await control.quickDiffProvider.provideOriginalResource(resource.resourceUri, require('./vscode.js').CancellationToken.None);
      if (params.op === 'original') return uri?.toString() || null;
      if (!uri) failure('No original resource is available.');
      const api = host.state.running.get(entry.extension)?.api; if (!api) failure('The source control extension is not active.');
      const [before, after] = await Promise.all([api.workspace.fs.readFile(uri), api.workspace.fs.readFile(resource.resourceUri)]);
      return { original: Buffer.from(before).toString('utf8').slice(0, 65536), current: Buffer.from(after).toString('utf8').slice(0, 65536), truncated: before.length > 65536 || after.length > 65536 };
    }
    failure('Unsupported source control operation.');
  });
}
module.exports = { create, snapshot, invoke };
