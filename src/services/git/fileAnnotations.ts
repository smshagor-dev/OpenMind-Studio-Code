import type * as monaco from "monaco-editor";

import type { GitBlameLine } from "../ipc";
import type { FileGitIpc } from "./fileGitIpc";
import { formatDate, shortHash } from "./fileGitService";
import { diffLines, originalLineOf, type LineChange } from "./lineDiff";

/** The Monaco editor API the annotations use (structural, so tests pass a fake). */
export interface AnnotatedEditor {
  getModel: () => monaco.editor.ITextModel | null;
  createDecorationsCollection: (
    decorations?: monaco.editor.IModelDeltaDecoration[],
  ) => monaco.editor.IEditorDecorationsCollection;
  onDidChangeModel: (listener: () => void) => monaco.IDisposable;
  onDidChangeModelContent: (listener: () => void) => monaco.IDisposable;
}

export interface AnnotationSettings {
  bool: (id: string, fallback: boolean) => boolean;
  number: (id: string, fallback: number) => number;
  string: (id: string, fallback: string) => string;
}

export interface AnnotationHost {
  ipc: FileGitIpc;
  blame: (path: string) => Promise<GitBlameLine[]>;
  /** The file a model belongs to, or `null` (untitled, a preview, a historical revision). */
  pathOf: (model: monaco.editor.ITextModel) => string | null;
  settings: AnnotationSettings;
  /** The language for relative dates ("3 days ago"). */
  locale: () => string;
  /** A failure worth a line in the Git output (never a toast: annotations are passive). */
  log: (message: string) => void;
}

export const ANNOTATION_SETTINGS = [
  "git.annotations.blame",
  "git.annotations.heatmap",
  "git.annotations.changes",
  "git.annotations.heatmapDays",
  "git.annotations.dateFormat",
];

/** Heatmap buckets: 0 = newest … 9 = oldest. */
const HEAT_BUCKETS = 10;
const CHANGE_DEBOUNCE_MS = 300;

/** "3 days ago" in the UI language. */
export function relativeTime(seconds: number, now: number, locale: string): string {
  const diff = Math.round(seconds - now / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit);
  }
  return format.format(diff, "second");
}

/** Which heatmap bucket a commit time falls in, `null` for uncommitted lines. */
export function heatBucket(time: number, now: number, days: number): number | null {
  if (time <= 0) return null;
  const age = Math.max(0, now / 1000 - time) / 86_400;
  return Math.min(HEAT_BUCKETS - 1, Math.floor((age / Math.max(1, days)) * HEAT_BUCKETS));
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (char) => `\\${char}`);
}

interface Tracked {
  editor: AnnotatedEditor;
  decorations: monaco.editor.IEditorDecorationsCollection;
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
}

/**
 * File Blame, File Heatmap and File Changes on every open editor, each switched by its setting. Blame and the heatmap
 * come from the saved file's blame (mapped onto the editor's text when it has unsaved edits); File Changes diffs the
 * editor's text with the file at HEAD on the page — typing never runs Git, only the diff (debounced).
 */
export class FileAnnotationsService {
  private readonly editors = new Set<Tracked>();
  private readonly heads = new Map<string, Promise<string | null>>();

  constructor(
    private readonly host: AnnotationHost,
    private readonly now: () => number = () => Date.now(),
  ) {}

  attach(editor: AnnotatedEditor): () => void {
    const tracked: Tracked = { editor, decorations: editor.createDecorationsCollection(), timer: null, seq: 0 };
    this.editors.add(tracked);
    const subscriptions = [
      editor.onDidChangeModel(() => {
        void this.refresh(tracked);
      }),
      editor.onDidChangeModelContent(() => {
        if (!this.enabled()) return;
        if (tracked.timer !== null) clearTimeout(tracked.timer);
        tracked.timer = setTimeout(() => {
          tracked.timer = null;
          void this.refresh(tracked);
        }, CHANGE_DEBOUNCE_MS);
      }),
    ];
    void this.refresh(tracked);
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      if (tracked.timer !== null) clearTimeout(tracked.timer);
      tracked.decorations.clear();
      this.editors.delete(tracked);
    };
  }

  private enabled(): boolean {
    const s = this.host.settings;
    return (
      s.bool("git.annotations.blame", false) ||
      s.bool("git.annotations.heatmap", false) ||
      s.bool("git.annotations.changes", false)
    );
  }

  /** The settings changed, a file was saved or Git changed something: redraw (forgetting cached Git text). */
  refreshAll(path?: string): void {
    if (path === undefined) this.heads.clear();
    else this.heads.delete(path);
    for (const tracked of this.editors) void this.refresh(tracked);
  }

  private head(path: string): Promise<string | null> {
    let text = this.heads.get(path);
    if (text === undefined) {
      text = this.host.ipc.fileAt(path, "HEAD").then(
        (result) => result.text,
        () => null,
      );
      this.heads.set(path, text);
    }
    return text;
  }

  private async refresh(tracked: Tracked): Promise<void> {
    const seq = ++tracked.seq;
    const model = tracked.editor.getModel();
    const path = model === null ? null : this.host.pathOf(model);
    if (model === null || path === null || !this.enabled()) {
      tracked.decorations.clear();
      return;
    }
    const s = this.host.settings;
    const wantBlame = s.bool("git.annotations.blame", false) || s.bool("git.annotations.heatmap", false);
    const [blame, head] = await Promise.all([
      wantBlame ? this.host.blame(path).catch((error: unknown) => this.failed(path, error)) : Promise.resolve(null),
      s.bool("git.annotations.changes", false) ? this.head(path) : Promise.resolve(null),
    ]);
    if (seq !== tracked.seq || tracked.editor.getModel() !== model || model.isDisposed()) return;
    const text = model.getValue();
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    if (blame !== null) decorations.push(...this.blameDecorations(blame, text, model));
    if (head !== null) decorations.push(...changeDecorations(diffLines(head, text), model.getLineCount()));
    tracked.decorations.set(decorations);
  }

  private failed(path: string, error: unknown): null {
    this.host.log(`File annotations for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  private blameDecorations(
    blame: GitBlameLine[],
    text: string,
    model: Pick<monaco.editor.ITextModel, "getLineCount" | "getLineMaxColumn">,
  ): monaco.editor.IModelDeltaDecoration[] {
    const s = this.host.settings;
    const showBlame = s.bool("git.annotations.blame", false);
    const showHeat = s.bool("git.annotations.heatmap", false);
    const days = s.number("git.annotations.heatmapDays", 365);
    const absolute = s.string("git.annotations.dateFormat", "relative") === "absolute";
    // Blame is of the saved file: map the editor's lines onto it when there are unsaved edits.
    const saved = blame.map((line) => line.content).join("\n");
    const changes = diffLines(saved, text) ?? [];
    const now = this.now();
    const result: monaco.editor.IModelDeltaDecoration[] = [];
    for (let line = 1; line <= model.getLineCount(); line++) {
      const original = changes.length === 0 ? line : originalLineOf(changes, line);
      const entry = original === null ? undefined : blame[original - 1];
      if (entry === undefined) continue;
      const when = absolute ? formatDate(entry.time) : relativeTime(entry.time, now, this.host.locale());
      const end = model.getLineMaxColumn(line);
      const hover = entry.committed
        ? `**${escapeMarkdown(entry.author)}** · ${escapeMarkdown(formatDate(entry.time))}\n\n${escapeMarkdown(entry.summary)}\n\n\`${shortHash(entry.hash)}\``
        : escapeMarkdown(entry.summary);
      // The line's text carries the hover and the heat colour of its number.
      const lineOptions: monaco.editor.IModelDecorationOptions = {};
      const bucket = showHeat ? heatBucket(entry.time, now, days) : null;
      if (bucket !== null) lineOptions.lineNumberClassName = `git-heat git-heat--${String(bucket)}`;
      if (showBlame || bucket !== null) {
        lineOptions.hoverMessage = { value: showBlame ? hover : `${hover}\n\n_${escapeMarkdown(when)}_` };
      }
      if (lineOptions.hoverMessage || lineOptions.lineNumberClassName) {
        result.push({
          range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: end },
          options: lineOptions,
        });
      }
      // The blame text after the line's end (an empty range: Monaco draws it only with `showIfCollapsed`).
      if (showBlame) {
        result.push({
          range: { startLineNumber: line, startColumn: end, endLineNumber: line, endColumn: end },
          options: {
            showIfCollapsed: true,
            after: {
              content: entry.committed ? `   ${entry.author}, ${when} · ${entry.summary}` : `   ${entry.summary}`,
              inlineClassName: "git-blame-annotation",
            },
          },
        });
      }
    }
    return result;
  }
}

/** Gutter bars for added / modified lines and a marker where lines were deleted. */
export function changeDecorations(changes: LineChange[] | null, lineCount: number): monaco.editor.IModelDeltaDecoration[] {
  if (changes === null) return [];
  return changes.map((change) => {
    const start = Math.min(Math.max(1, change.start), Math.max(1, lineCount));
    const end = change.kind === "deleted" ? start : Math.min(change.end, Math.max(1, lineCount));
    return {
      range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `git-change git-change--${change.kind}`,
      },
    };
  });
}
