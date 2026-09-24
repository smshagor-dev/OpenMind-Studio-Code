import type * as monaco from "monaco-editor";

import type { IpcClient } from "./ipc";

/** The slice of Monaco's editor API this service uses — structural, so tests can pass a fake. */
export type CodeEditorLike = Pick<
  monaco.editor.IStandaloneCodeEditor,
  | "focus"
  | "trigger"
  | "setSelection"
  | "revealRangeInCenter"
  | "onDidFocusEditorWidget"
  | "updateOptions"
  | "getSelections"
  | "getModel"
  | "onDidChangeCursorSelection"
  | "onDidChangeModel"
  | "onDidChangeModelLanguage"
  | "onDidChangeModelOptions"
>;

/** User-toggleable editor view options (VS Code's View / Selection menu toggles). */
export interface EditorViewOptions {
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  renderWhitespace: boolean;
  renderControlCharacters: boolean;
  columnSelection: boolean;
  /** VS Code's "Switch to Ctrl+Click for Multi-Cursor": `true` = Ctrl+Click adds cursors. */
  ctrlClickMultiCursor: boolean;
}

export const DEFAULT_VIEW_OPTIONS: EditorViewOptions = {
  wordWrap: false,
  minimap: true,
  stickyScroll: true,
  renderWhitespace: true,
  renderControlCharacters: true,
  columnSelection: false,
  ctrlClickMultiCursor: false,
};

/** What the status bar shows about the focused editor. */
export interface EditorStatus {
  line: number;
  column: number;
  /** Total characters selected across all selections. */
  selectedChars: number;
  selectionCount: number;
  languageId: string;
  tabSize: number;
  insertSpaces: boolean;
}

const SETTINGS_KEY = "editor.viewOptions";

/** A reveal request older than this is dropped: the file it was for never showed up. */
const REVEAL_TTL_MS = 5000;

export interface RevealRequest {
  /** URI of the Monaco model to reveal in. */
  uri: string;
  line: number;
  column: number;
  length: number;
}

/**
 * Bridges app-level commands (menus, keybindings) to the Monaco editors that
 * are mounted — one per editor group — and publishes cursor/language status
 * for the status bar. The *current* editor is the one that last had focus (or
 * the last one mounted), and is what commands act on. `MonacoHost` stays
 * UI-only: each group hands its editor to `attach()`; this service never
 * creates or owns an editor itself.
 */
export class EditorService {
  private editor: CodeEditorLike | null = null;
  private readonly editors = new Set<CodeEditorLike>();
  private pendingReveal: (RevealRequest & { at: number }) | null = null;
  private status: EditorStatus | null = null;
  private options: EditorViewOptions = DEFAULT_VIEW_OPTIONS;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    if (saved === null) {
      return;
    }
    try {
      const parsed = JSON.parse(saved) as Partial<EditorViewOptions>;
      this.options = { ...DEFAULT_VIEW_OPTIONS, ...pickBooleans(parsed) };
      this.applyOptions();
      this.notify();
    } catch {
      // A corrupt stored value just means defaults — nothing to surface to the user.
    }
  }

  /** Registers `editor` (and makes it current); returns the matching detach function. */
  attach(editor: CodeEditorLike): () => void {
    this.editors.add(editor);
    this.editor = editor;
    this.applyOptions();
    const refresh = () => {
      if (this.editor === editor) this.refreshStatus();
    };
    const disposables = [
      editor.onDidChangeCursorSelection(refresh),
      editor.onDidChangeModel(() => {
        refresh();
        this.applyPendingReveal();
      }),
      editor.onDidChangeModelLanguage(refresh),
      editor.onDidChangeModelOptions(refresh),
      editor.onDidFocusEditorWidget(() => {
        this.editor = editor;
        this.refreshStatus();
      }),
    ];
    this.refreshStatus();
    this.applyPendingReveal();
    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      this.editors.delete(editor);
      if (this.editor === editor) {
        this.editor = [...this.editors].pop() ?? null;
        this.refreshStatus();
      }
    };
  }

  /**
   * Selects and centers a range in whichever editor shows the model `uri` —
   * now if one already does, otherwise as soon as one is given that model
   * (the file was only just opened). A request nobody satisfies expires.
   */
  reveal(request: RevealRequest): void {
    this.pendingReveal = { ...request, at: Date.now() };
    this.applyPendingReveal();
  }

  private applyPendingReveal(): void {
    const pending = this.pendingReveal;
    if (!pending) return;
    if (Date.now() - pending.at > REVEAL_TTL_MS) {
      this.pendingReveal = null;
      return;
    }
    const candidates = this.editor ? [this.editor, ...this.editors] : [...this.editors];
    const target = candidates.find((editor) => editor.getModel()?.uri.toString() === pending.uri);
    if (!target) return;
    const range = {
      startLineNumber: pending.line,
      startColumn: pending.column,
      endLineNumber: pending.line,
      endColumn: pending.column + Math.max(0, pending.length),
    };
    this.pendingReveal = null;
    this.editor = target;
    target.setSelection(range);
    target.revealRangeInCenter(range);
    target.focus();
    this.refreshStatus();
  }

  hasEditor(): boolean {
    return this.editor?.getModel() != null;
  }

  /** Focuses the editor and runs a Monaco action/command id (e.g. `editor.action.commentLine`). */
  run(actionId: string): void {
    const editor = this.editor;
    if (!editor || editor.getModel() == null) {
      return;
    }
    editor.focus();
    editor.trigger("menu", actionId, null);
  }

  getStatus(): EditorStatus | null {
    return this.status;
  }

  getOptions(): EditorViewOptions {
    return this.options;
  }

  async toggleOption(name: keyof EditorViewOptions): Promise<void> {
    this.options = { ...this.options, [name]: !this.options[name] };
    this.applyOptions();
    this.notify();
    await this.ipc.settingsSet(SETTINGS_KEY, JSON.stringify(this.options)).catch(() => undefined);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private applyOptions(): void {
    const o = this.options;
    this.editor?.updateOptions({
      wordWrap: o.wordWrap ? "on" : "off",
      minimap: { enabled: o.minimap },
      stickyScroll: { enabled: o.stickyScroll },
      renderWhitespace: o.renderWhitespace ? "selection" : "none",
      renderControlCharacters: o.renderControlCharacters,
      columnSelection: o.columnSelection,
      multiCursorModifier: o.ctrlClickMultiCursor ? "ctrlCmd" : "alt",
    });
  }

  private refreshStatus(): void {
    const editor = this.editor;
    const model = editor?.getModel();
    const selections = editor?.getSelections();
    const primary = selections?.[0];
    if (!model || !selections || !primary) {
      this.status = null;
    } else {
      const modelOptions = model.getOptions();
      this.status = {
        line: primary.positionLineNumber,
        column: primary.positionColumn,
        selectedChars: selections.reduce(
          (total, selection) => total + model.getValueInRange(selection).length,
          0,
        ),
        selectionCount: selections.length,
        languageId: model.getLanguageId(),
        tabSize: modelOptions.tabSize,
        insertSpaces: modelOptions.insertSpaces,
      };
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function pickBooleans(value: Partial<EditorViewOptions>): Partial<EditorViewOptions> {
  const result: Partial<EditorViewOptions> = {};
  for (const key of Object.keys(DEFAULT_VIEW_OPTIONS) as (keyof EditorViewOptions)[]) {
    const candidate = value[key];
    if (typeof candidate === "boolean") {
      result[key] = candidate;
    }
  }
  return result;
}
