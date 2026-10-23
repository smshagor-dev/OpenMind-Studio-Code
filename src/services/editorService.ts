import * as monaco from "monaco-editor";

import type { ExtensionEditorAction } from "./extensionContributionService";
import type { HostRange, HostSelection } from "./hostEdits";
import type { IpcClient } from "./ipc";
import { snippetUsesClipboard } from "./snippetClipboard";

/** The slice of Monaco's editor API this service uses — structural, so tests can pass a fake. */
export type CodeEditorLike = Partial<
  Pick<
    monaco.editor.IStandaloneCodeEditor,
    | "onDidDispose"
    | "createDecorationsCollection"
    | "getContribution"
    | "addAction"
    | "setSelections"
    | "revealRange"
    | "revealRangeAtTop"
    | "revealRangeInCenterIfOutsideViewport"
    | "executeEdits"
    | "getRawOptions"
    | "getVisibleRanges"
    | "onDidScrollChange"
  >
> &
  Pick<
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

export interface VisibleEditorState {
  id: string;
  uri: string;
  groupId?: string;
  viewColumn: number;
  active: boolean;
  selections: HostSelection[];
  tabSize: number;
  insertSpaces: boolean;
  visibleRanges: HostRange[];
  selectionKind: number;
}

interface EditorIdentity {
  id: string;
  uri: string;
  groupId?: string;
  viewColumn?: () => number;
  selectionKind: number;
}

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

/** The view toggles that are real settings (`editor.*`) rather than a private saved blob. */
export const OPTION_SETTINGS: Partial<Record<keyof EditorViewOptions, string>> = {
  wordWrap: "editor.wordWrap",
  minimap: "editor.minimap",
  stickyScroll: "editor.stickyScroll",
  renderWhitespace: "editor.renderWhitespace",
};

/** The editor settings an open editor follows live (see `SettingsService.onChange`). */
export const EDITOR_SETTING_IDS = [
  ...Object.values(OPTION_SETTINGS),
  "editor.fontSize",
  "editor.fontFamily",
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.lineNumbers",
  "editor.cursorBlinking",
];

/** The slice of `SettingsService` the editor reads and writes. */
export interface EditorSettingsSource {
  bool: (id: string, fallback: boolean) => boolean;
  number: (id: string, fallback: number) => number;
  string: (id: string, fallback: string) => string;
  isSetIn: (scope: "user", id: string) => boolean;
  set: (scope: "user", id: string, value: boolean) => Promise<unknown>;
  setEffective: (id: string, value: boolean) => Promise<unknown>;
}

const LINE_NUMBERS = ["on", "off", "relative"] as const;
const CURSOR_BLINKING = ["blink", "smooth", "phase", "expand", "solid"] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

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
  private readonly identities = new Map<CodeEditorLike, EditorIdentity>();
  private nextEditorId = 0;
  private extensionActions: ExtensionEditorAction[] = [];
  private aiActions: ExtensionEditorAction[] = [];
  private formatActions: ExtensionEditorAction[] = [];
  /** App commands for the palette, per owner (Network, Shell Integration ...), so one owner can't drop another's. */
  private readonly appActions = new Map<string, ExtensionEditorAction[]>();
  private runExtensionCommand: ((command: string) => void) | null = null;
  private readonly actionDisposables = new Map<CodeEditorLike, { dispose: () => void }[]>();
  private pendingReveal: (RevealRequest & { at: number }) | null = null;
  private status: EditorStatus | null = null;
  private options: EditorViewOptions = DEFAULT_VIEW_OPTIONS;
  private readonly listeners = new Set<() => void>();
  private readonly attachListeners = new Set<(editor: CodeEditorLike) => (() => void) | undefined>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly settings: EditorSettingsSource | null = null,
  ) {}

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    if (saved !== null) {
      try {
        const parsed = JSON.parse(saved) as Partial<EditorViewOptions>;
        this.options = { ...DEFAULT_VIEW_OPTIONS, ...pickBooleans(parsed) };
        await this.migrateLegacyToggles();
      } catch {
        // A corrupt stored value just means defaults — nothing to surface to the user.
      }
    }
    this.applyOptions();
    this.notify();
  }

  /** The toggles that used to live in the private blob move into the settings file once (only where the user changed them). */
  private async migrateLegacyToggles(): Promise<void> {
    if (this.settings === null) return;
    for (const [name, id] of Object.entries(OPTION_SETTINGS) as [
      keyof EditorViewOptions,
      string,
    ][]) {
      const legacy = this.options[name];
      if (legacy !== DEFAULT_VIEW_OPTIONS[name] && !this.settings.isSetIn("user", id)) {
        await this.settings.set("user", id, legacy);
      }
    }
    const rest = Object.fromEntries(
      Object.entries(this.options).filter(([name]) => !(name in OPTION_SETTINGS)),
    );
    await this.ipc.settingsSet(SETTINGS_KEY, JSON.stringify(rest)).catch(() => undefined);
  }

  /** The settings changed: the open editors follow them. */
  refreshFromSettings(): void {
    this.applyOptions();
    this.notify();
  }

  /** How an extension action in the palette or the context menu runs its command. */
  setActionRunner(run: (command: string) => void): void {
    this.runExtensionCommand = run;
  }

  /** The commands extensions offer in the editor's command palette (F1) and right-click menu. */
  setExtensionActions(actions: ExtensionEditorAction[]): void {
    this.extensionActions = actions;
    for (const editor of this.editors) this.applyActions(editor);
  }

  /** The AI commands in the palette and the right-click menu — set only while an AI provider is enabled. */
  setAiActions(actions: ExtensionEditorAction[]): void {
    this.aiActions = actions;
    for (const editor of this.editors) this.applyActions(editor);
  }

  /**
   * The commands that asked to be in the editor's right-click menu (extensions, the AI panel), in order. Format
   * Document / With... are not repeated: the menu lists them itself.
   */
  contextMenuActions(): ExtensionEditorAction[] {
    return [...this.extensionActions, ...this.aiActions].filter((action) => action.inContextMenu);
  }

  /** App commands that belong in the palette only (Network: ..., Shell Integration: ...), replacing `owner`'s earlier list. */
  setAppActions(actions: ExtensionEditorAction[], owner = "network"): void {
    this.appActions.set(owner, actions);
    for (const editor of this.editors) this.applyActions(editor);
  }

  /** Format Document (and Format Document With...) in the palette and the right-click menu: they run the app's own commands. */
  setFormatActions(actions: ExtensionEditorAction[]): void {
    this.formatActions = actions;
    for (const editor of this.editors) this.applyActions(editor);
  }

  private disposeActions(editor: CodeEditorLike): void {
    for (const disposable of this.actionDisposables.get(editor) ?? []) disposable.dispose();
    this.actionDisposables.delete(editor);
  }

  private applyActions(editor: CodeEditorLike): void {
    this.disposeActions(editor);
    const add = editor.addAction;
    if (add === undefined) return;
    const own = [
      ...this.extensionActions.map((action) => ({
        action,
        prefix: "extension",
        group: "9_extensions",
      })),
      ...this.aiActions.map((action) => ({ action, prefix: "ai", group: "9_ai" })),
      ...this.formatActions.map((action) => ({
        action,
        prefix: "format",
        group: "1_modification",
      })),
      ...[...this.appActions.values()].flat().map((action) => ({ action, prefix: "app", group: "9_app" })),
    ];
    const disposables = own.map(({ action, prefix, group }, index) =>
      add.call(editor, {
        id: `${prefix}.${action.command}`,
        label: action.label,
        contextMenuGroupId: action.inContextMenu ? group : undefined,
        contextMenuOrder: index,
        run: () => {
          this.runExtensionCommand?.(action.command);
        },
      }),
    );
    this.actionDisposables.set(editor, disposables);
  }

  /**
   * Runs `listener` for every editor attached now and later (annotations, the context menu); what it returns runs
   * when that editor goes away. Returns a function that stops listening.
   */
  onEditorAttached(listener: (editor: CodeEditorLike) => (() => void) | undefined): () => void {
    this.attachListeners.add(listener);
    for (const editor of this.editors) this.addCleanup(editor, listener(editor));
    return () => {
      this.attachListeners.delete(listener);
    };
  }

  private readonly cleanups = new Map<CodeEditorLike, (() => void)[]>();

  private addCleanup(editor: CodeEditorLike, cleanup: (() => void) | undefined): void {
    if (cleanup) this.cleanups.set(editor, [...(this.cleanups.get(editor) ?? []), cleanup]);
  }

  /** The editor commands act on (the last focused one), or `null`. */
  current(): CodeEditorLike | null {
    return this.editor;
  }

  /** Registers `editor` (and makes it current); returns the matching detach function. */
  attach(editor: CodeEditorLike, location: { groupId?: string; viewColumn?: () => number; active?: () => boolean } = {}): () => void {
    this.editors.add(editor);
    this.identities.set(editor, { id: "", uri: "", selectionKind: 3, ...location });
    if (!this.editor || location.active?.() !== false) this.editor = editor;
    this.applyOptions();
    this.applyActions(editor);
    for (const listener of this.attachListeners) this.addCleanup(editor, listener(editor));
    const refresh = () => {
      this.identityOf(editor);
      if (this.editor === editor) this.refreshStatus();
      else this.notify();
    };
    const disposables = [
      editor.onDidChangeCursorSelection((event?: { source?: string }) => {
        const identity = this.identityOf(editor);
        if (identity) identity.selectionKind = event?.source === "keyboard" ? 1 : event?.source === "mouse" ? 2 : 3;
        refresh();
      }),
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
    const scroll = editor.onDidScrollChange?.(() => { this.notify(); });
    if (scroll) disposables.push(scroll);
    this.identityOf(editor);
    this.refreshStatus();
    this.applyPendingReveal();
    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      this.editors.delete(editor);
      this.identities.delete(editor);
      this.disposeActions(editor);
      for (const cleanup of this.cleanups.get(editor) ?? []) cleanup();
      this.cleanups.delete(editor);
      if (this.editor === editor) {
        this.editor = [...this.editors].pop() ?? null;
        this.refreshStatus();
      } else this.notify();
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

  // --- What extensions see and do in an editor (selections, options, reveal), by the model's URI ---

  private identityOf(editor: CodeEditorLike): EditorIdentity | undefined {
    const identity = this.identities.get(editor);
    const uri = editor.getModel()?.uri.toString() ?? "";
    if (identity && identity.uri !== uri) {
      identity.uri = uri;
      identity.id = `text-editor-${++this.nextEditorId}`;
      identity.selectionKind = 3;
    }
    return identity;
  }

  snapshotEditors(): VisibleEditorState[] {
    const result: VisibleEditorState[] = [];
    for (const editor of this.editors) {
      const identity = this.identityOf(editor), model = editor.getModel();
      if (!identity || !model || model.isDisposed()) continue;
      const options = model.getOptions();
      const viewColumn = identity.viewColumn?.() ?? [...this.editors].indexOf(editor) + 1;
      if (viewColumn < 1) continue;
      result.push({
        id: identity.id, uri: identity.uri, groupId: identity.groupId,
        viewColumn,
        active: editor === this.editor,
        selections: (editor.getSelections() ?? []).map(s => ({ anchorLine: s.selectionStartLineNumber - 1, anchorColumn: s.selectionStartColumn - 1, activeLine: s.positionLineNumber - 1, activeColumn: s.positionColumn - 1 })),
        tabSize: options.tabSize, insertSpaces: options.insertSpaces,
        visibleRanges: (editor.getVisibleRanges?.() ?? []).map(range => ({ startLine: range.startLineNumber - 1, startColumn: range.startColumn - 1, endLine: range.endLineNumber - 1, endColumn: range.endColumn - 1 })),
        selectionKind: identity.selectionKind,
      });
    }
    return result.sort((left, right) => left.viewColumn - right.viewColumn);
  }

  visibleEditorFor(uri: string, editorId?: string): CodeEditorLike | undefined {
    return this.editorShowing(uri, editorId);
  }

  private editorShowing(uri: string, editorId?: string): CodeEditorLike | undefined {
    const candidates = this.editor ? [this.editor, ...this.editors] : [...this.editors];
    return candidates.find(editor => editor.getModel()?.uri.toString() === uri && (editorId === undefined || this.identityOf(editor)?.id === editorId));
  }

  /** The selections of the editor showing this model (host coordinates, 0-based), or `null` if none shows it. */
  selectionsFor(uri: string): HostSelection[] | null {
    const selections = this.editorShowing(uri)?.getSelections();
    if (!selections || selections.length === 0) return null;
    return selections.map((selection) => ({
      anchorLine: selection.selectionStartLineNumber - 1,
      anchorColumn: selection.selectionStartColumn - 1,
      activeLine: selection.positionLineNumber - 1,
      activeColumn: selection.positionColumn - 1,
    }));
  }

  /** Tab size and insert-spaces of the model as its editor uses them. */
  optionsFor(uri: string): { tabSize: number; insertSpaces: boolean } | null {
    const options = this.editorShowing(uri)?.getModel()?.getOptions();
    return options ? { tabSize: options.tabSize, insertSpaces: options.insertSpaces } : null;
  }

  /** Uses Monaco's snippet session so placeholders and Tab navigation stay native. */
  async insertSnippetFor(uri: string, snippet: string, ranges: HostRange[] | undefined,
    options: { undoStopBefore?: boolean; undoStopAfter?: boolean }, editorId?: string,
    isCurrent?: () => boolean): Promise<boolean> {
    const editor = this.editorShowing(uri, editorId);
    if (!editor || editor.getRawOptions?.().readOnly) return false;
    const identity = this.identityOf(editor)?.id;
    const model = editor.getModel();
    if (!identity || !model || model.isDisposed()) return false;
    const version = model.getVersionId();
    const selections = JSON.stringify(editor.getSelections());
    const controller = editor.getContribution?.("snippetController2") as
      | { insert(template: string | { range: monaco.Range; template: string }[], options: { undoStopBefore?: boolean; undoStopAfter?: boolean; clipboardText?: string }): void }
      | null | undefined;
    if (!controller) return false;
    if (ranges?.length === 0) return true;
    const clipboardText = snippetUsesClipboard(snippet) ? await this.ipc.clipboardReadText() : undefined;
    if (this.editorShowing(uri, identity) !== editor || editor.getModel() !== model || model.isDisposed()
      || model.getVersionId() !== version || editor.getRawOptions?.().readOnly || isCurrent?.() === false
      || (ranges === undefined && JSON.stringify(editor.getSelections()) !== selections)) return false;
    controller.insert(ranges ? ranges.map(range => ({
      range: new monaco.Range(range.startLine + 1, range.startColumn + 1, range.endLine + 1, range.endColumn + 1),
      template: snippet,
    })) : snippet, { ...options, ...(clipboardText === undefined ? {} : { clipboardText }) });
    return true;
  }

  setSelectionsFor(uri: string, selections: HostSelection[], editorId?: string): boolean {
    const editor = this.editorShowing(uri, editorId);
    if (!editor?.setSelections) return false;
    editor.setSelections(
      selections.map((s) => ({
        selectionStartLineNumber: s.anchorLine + 1,
        selectionStartColumn: s.anchorColumn + 1,
        positionLineNumber: s.activeLine + 1,
        positionColumn: s.activeColumn + 1,
      })),
    );
    return true;
  }

  setOptionsFor(uri: string, options: { tabSize?: number | "auto"; insertSpaces?: boolean | "auto" }, editorId?: string): boolean {
    const model = this.editorShowing(uri, editorId)?.getModel();
    if (!model) return false;
    if (options.tabSize === "auto" || options.insertSpaces === "auto") {
      const current = model.getOptions();
      model.detectIndentation(typeof options.insertSpaces === "boolean" ? options.insertSpaces : current.insertSpaces, typeof options.tabSize === "number" ? options.tabSize : current.tabSize);
    }
    model.updateOptions({
      ...(typeof options.tabSize === "number" ? { tabSize: options.tabSize, indentSize: options.tabSize } : {}),
      ...(typeof options.insertSpaces === "boolean" ? { insertSpaces: options.insertSpaces } : {}),
    });
    this.refreshStatus();
    return true;
  }

  revealRangeFor(uri: string, range: HostRange, type = 0, editorId?: string): boolean {
    const editor = this.editorShowing(uri, editorId);
    if (!editor) return false;
    const target = {
      startLineNumber: range.startLine + 1,
      startColumn: range.startColumn + 1,
      endLineNumber: range.endLine + 1,
      endColumn: range.endColumn + 1,
    };
    if (type === 0 && editor.revealRange) editor.revealRange(target);
    else if (type === 2 && editor.revealRangeInCenterIfOutsideViewport) editor.revealRangeInCenterIfOutsideViewport(target);
    else if (type === 3 && editor.revealRangeAtTop) editor.revealRangeAtTop(target);
    else editor.revealRangeInCenter(target);
    return true;
  }

  /** The selected text (when it is one line) or the word at the cursor of the focused editor, or `null`. */
  wordAtCursor(): string | null {
    const model = this.editor?.getModel();
    const selection = this.editor?.getSelections()?.[0];
    if (!model || !selection) return null;
    if (!selection.isEmpty() && selection.startLineNumber === selection.endLineNumber) {
      return model.getValueInRange(selection).trim() || null;
    }
    return model.getWordAtPosition(selection.getPosition())?.word ?? null;
  }

  /** What is selected in the focused editor (all selections' first one), with its language and lines, or `null`. */
  selectedText(): {
    text: string;
    languageId: string;
    startLine: number;
    endLine: number;
    uri: string;
  } | null {
    const model = this.editor?.getModel();
    const selection = this.editor?.getSelections()?.[0];
    if (!model || !selection || selection.isEmpty()) return null;
    return {
      text: model.getValueInRange(selection),
      languageId: model.getLanguageId(),
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      uri: model.uri.toString(),
    };
  }

  /** Replaces the selection (or inserts at the cursor) as one undoable edit; false when there is no editor. */
  insertAtCursor(text: string): boolean {
    const editor = this.editor;
    const selection = editor?.getSelections()?.[0];
    if (!editor?.executeEdits || !selection || editor.getModel() == null) return false;
    editor.executeEdits("ai", [{ range: selection, text, forceMoveMarkers: true }]);
    editor.focus();
    return true;
  }

  /**
   * Edit > Paste: pastes `text` (read through the app's clipboard bridge) exactly like Ctrl+V — one undoable step,
   * replacing the selection. Monaco's own paste action reads the WebView clipboard, which asks the user for a
   * permission every time.
   */
  pasteText(text: string): boolean {
    const editor = this.editor;
    if (!editor || editor.getModel() == null) return false;
    editor.focus();
    editor.trigger("menu", "paste", { text });
    return true;
  }

  /**
   * Edit > Cut / Copy from a menu: the selected text goes to the clipboard through the app's bridge (Monaco's own
   * actions need the WebView's clipboard permission). Like Ctrl+C, an empty selection copies its whole line, and
   * several selections are joined by line breaks. Cut removes them as one undoable edit and is refused in a
   * read-only editor. Returns false when there is nothing to copy.
   */
  async copySelection(cut: boolean): Promise<boolean> {
    const editor = this.editor;
    const model = editor?.getModel();
    const selections = editor?.getSelections();
    if (!editor || !model || !selections || selections.length === 0) return false;
    const eol = model.getEOL();
    const ranges = selections.map((selection) =>
      selection.isEmpty()
        ? {
            startLineNumber: selection.startLineNumber,
            startColumn: 1,
            endLineNumber: Math.min(selection.startLineNumber + 1, model.getLineCount()),
            endColumn:
              selection.startLineNumber < model.getLineCount()
                ? 1
                : model.getLineMaxColumn(selection.startLineNumber),
          }
        : selection,
    );
    const pieces = selections.map((selection, index) => {
      const text = model.getValueInRange(ranges[index] ?? selection);
      return selection.isEmpty() && !text.endsWith(eol) ? text + eol : text;
    });
    await this.ipc.clipboardWriteText(pieces.join(selections.length > 1 ? eol : ""));
    if (cut && editor.executeEdits) {
      editor.focus();
      editor.executeEdits("cut", ranges.map((range) => ({ range, text: "" })));
    } else {
      editor.focus();
    }
    return true;
  }

  /** The editor in front doesn't take edits (a historical revision, a read-only document). */
  isReadOnly(): boolean {
    return this.editor?.getRawOptions?.().readOnly === true;
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

  /** The view options as they are now: the settings-backed toggles come from the settings, the rest are kept here. */
  getOptions(): EditorViewOptions {
    const settings = this.settings;
    if (settings === null) return this.options;
    const resolved = { ...this.options };
    for (const [name, id] of Object.entries(OPTION_SETTINGS) as [
      keyof EditorViewOptions,
      string,
    ][]) {
      resolved[name] = settings.bool(id, DEFAULT_VIEW_OPTIONS[name]);
    }
    return resolved;
  }

  async toggleOption(name: keyof EditorViewOptions): Promise<void> {
    const id = OPTION_SETTINGS[name];
    if (id !== undefined && this.settings !== null) {
      await this.settings.setEffective(id, !this.getOptions()[name]);
      return;
    }
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
    const o = this.getOptions();
    const s = this.settings;
    const prefs: monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions =
      s === null
        ? {}
        : {
            fontSize: s.number("editor.fontSize", 14),
            fontFamily: s.string("editor.fontFamily", "Consolas, monospace"),
            tabSize: s.number("editor.tabSize", 4),
            insertSpaces: s.bool("editor.insertSpaces", true),
            lineNumbers: oneOf(s.string("editor.lineNumbers", "on"), LINE_NUMBERS, "on"),
            cursorBlinking: oneOf(
              s.string("editor.cursorBlinking", "blink"),
              CURSOR_BLINKING,
              "blink",
            ),
          };
    const all = { ...prefs, ...this.viewOptionsFor(o) };
    for (const editor of this.editors) editor.updateOptions(all);
  }

  private viewOptionsFor(o: EditorViewOptions): monaco.editor.IEditorOptions {
    return {
      wordWrap: o.wordWrap ? "on" : "off",
      minimap: { enabled: o.minimap },
      stickyScroll: { enabled: o.stickyScroll },
      renderWhitespace: o.renderWhitespace ? "selection" : "none",
      renderControlCharacters: o.renderControlCharacters,
      columnSelection: o.columnSelection,
      multiCursorModifier: o.ctrlClickMultiCursor ? "ctrlCmd" : "alt",
    };
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

