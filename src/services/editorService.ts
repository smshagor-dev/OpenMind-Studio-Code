import type * as monaco from "monaco-editor";

import type { IpcClient } from "./ipc";

/** The slice of Monaco's editor API this service uses — structural, so tests can pass a fake. */
export type CodeEditorLike = Pick<
  monaco.editor.IStandaloneCodeEditor,
  | "focus"
  | "trigger"
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

/**
 * Bridges app-level commands (menus, keybindings) to whichever Monaco editor
 * instance is currently mounted, and publishes cursor/language status for the
 * status bar. `MonacoHost` stays UI-only: `App` hands the editor it creates to
 * `attach()`; this service never creates or owns an editor itself.
 */
export class EditorService {
  private editor: CodeEditorLike | null = null;
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

  /** Registers `editor` as the active editor; returns the matching detach function. */
  attach(editor: CodeEditorLike): () => void {
    this.editor = editor;
    this.applyOptions();
    const refresh = () => {
      this.refreshStatus();
    };
    const disposables = [
      editor.onDidChangeCursorSelection(refresh),
      editor.onDidChangeModel(refresh),
      editor.onDidChangeModelLanguage(refresh),
      editor.onDidChangeModelOptions(refresh),
    ];
    this.refreshStatus();
    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      if (this.editor === editor) {
        this.editor = null;
        this.status = null;
        this.notify();
      }
    };
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
