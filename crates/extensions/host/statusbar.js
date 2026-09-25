'use strict';
// Status bar items for OpenMind Studio's extension host: `window.createStatusBarItem`, `StatusBarAlignment` and
// `ThemeColor` (a VS Code API subset, written for this app). The app draws the items as plain text (never HTML) in
// its own status bar and runs an item's command when it is clicked. Every item belongs to one extension: its id
// carries the extension id, and the app ignores updates for ids it doesn't know or that were disposed.

const StatusBarAlignment = Object.freeze({ Left: 1, Right: 2 });

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

/** The theme colours an item may use; anything else is ignored (and said so once), never turned into CSS. */
const KNOWN_COLORS = new Set([
  'statusBarItem.errorBackground',
  'statusBarItem.warningBackground',
  'errorForeground',
  'editorError.foreground',
  'editorWarning.foreground',
  'editorInfo.foreground',
]);

function colorId(value) {
  return value instanceof ThemeColor ? value.id : null;
}

// One counter for the whole host process: an id is never used twice, even when an extension is deactivated and
// activated again (the app remembers disposed ids and ignores late updates for them).
let counter = 0;

function createStatusBarApi({ host, ext, track, Disposable }) {
  const { notify } = host;

  function createStatusBarItem(alignmentOrId, priorityOrAlignment, maybePriority) {
    // (alignment?, priority?) and the newer (id, alignment?, priority?) forms.
    const hasId = typeof alignmentOrId === 'string';
    const alignment = (hasId ? priorityOrAlignment : alignmentOrId) === StatusBarAlignment.Right ? 'right' : 'left';
    const priority = Number((hasId ? maybePriority : priorityOrAlignment) || 0) || 0;
    counter += 1;
    const id = `${ext.id}#status-${counter}`;
    let disposed = false;
    let visible = false;
    let scheduled = false;
    let warnedColor = false;
    const fields = { text: '', tooltip: undefined, command: undefined, color: undefined, backgroundColor: undefined, name: undefined };

    const snapshot = () => {
      const command = fields.command;
      return {
        extension: ext.id,
        id,
        alignment,
        priority,
        visible,
        text: String(fields.text ?? ''),
        tooltip: typeof fields.tooltip === 'string' ? fields.tooltip : fields.tooltip && typeof fields.tooltip.value === 'string' ? fields.tooltip.value : '',
        command: typeof command === 'string' ? { command, args: [] } : command && typeof command.command === 'string' ? { command: command.command, args: Array.isArray(command.arguments) ? command.arguments : [] } : null,
        color: colorId(fields.color),
        background: colorId(fields.backgroundColor),
      };
    };
    const push = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      // One message for a burst of property changes.
      queueMicrotask(() => {
        scheduled = false;
        if (!disposed) notify('statusBar/set', snapshot());
      });
    };
    const checkColor = (value) => {
      if (value === undefined || value === null || warnedColor) return;
      const identifier = colorId(value);
      if (identifier === null || !KNOWN_COLORS.has(identifier)) {
        warnedColor = true;
        console.warn(`Status bar item colour ignored: only ThemeColor(${[...KNOWN_COLORS].map((name) => `'${name}'`).join(', ')}) can be used.`);
      }
    };

    const item = {
      get alignment() {
        return alignment === 'right' ? StatusBarAlignment.Right : StatusBarAlignment.Left;
      },
      get priority() {
        return priority;
      },
      get id() {
        return id;
      },
      get text() {
        return fields.text;
      },
      set text(value) {
        fields.text = value;
        push();
      },
      get tooltip() {
        return fields.tooltip;
      },
      set tooltip(value) {
        fields.tooltip = value;
        push();
      },
      get command() {
        return fields.command;
      },
      set command(value) {
        fields.command = value;
        push();
      },
      get color() {
        return fields.color;
      },
      set color(value) {
        checkColor(value);
        fields.color = value;
        push();
      },
      get backgroundColor() {
        return fields.backgroundColor;
      },
      set backgroundColor(value) {
        checkColor(value);
        fields.backgroundColor = value;
        push();
      },
      get name() {
        return fields.name;
      },
      set name(value) {
        fields.name = value;
      },
      accessibilityInformation: undefined,
      show() {
        if (disposed) return;
        visible = true;
        push();
      },
      hide() {
        if (disposed) return;
        visible = false;
        push();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        visible = false;
        notify('statusBar/dispose', { extension: ext.id, id });
      },
    };
    track(new Disposable(() => item.dispose()));
    return item;
  }

  return { createStatusBarItem };
}

module.exports = { createStatusBarApi, StatusBarAlignment, ThemeColor };
