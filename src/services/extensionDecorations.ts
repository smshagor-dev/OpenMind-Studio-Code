import * as monaco from "monaco-editor";

import type { DocumentService } from "./documentService";
import type { CodeEditorLike, EditorService } from "./editorService";
import { WORKBENCH_TOKENS } from "./extensionTheme";
import { parseEdits } from "./hostEdits";

type Options = Record<string, unknown>;
interface DecorationType { owner: string; options: Options }
interface Entry {
  editor: CodeEditorLike;
  collection: monaco.editor.IEditorDecorationsCollection;
  style: HTMLStyleElement;
  off: () => void;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function record(value: unknown): Options {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Options : {};
}
const properties = ["color", "backgroundColor", "border", "borderColor", "borderWidth", "borderStyle", "borderRadius",
  "outline", "outlineColor", "outlineWidth", "outlineStyle", "fontStyle", "fontWeight", "textDecoration", "cursor",
  "opacity", "letterSpacing", "margin", "width", "height"] as const;
let nextClass = 1;

/** Extension decorations belong to an editor and never change the document text. */
export class ExtensionDecorations {
  private readonly types = new Map<string, DecorationType>();
  private readonly entries = new Map<string, Set<Entry>>();

  constructor(private readonly editor: EditorService, private readonly documents: DocumentService) {}

  create(params: Options): void {
    const key = text(params.key), owner = text(params.extension);
    if (!key || !owner || this.types.has(key)) throw new Error("Invalid decoration type.");
    this.types.set(key, { owner, options: record(params.options) });
  }

  private owned(params: Options): DecorationType | undefined {
    const type = this.types.get(text(params.key));
    return type?.owner === params.extension ? type : undefined;
  }

  dispose(params: Options): void {
    if (!this.owned(params)) return;
    const key = text(params.key);
    for (const entry of [...(this.entries.get(key) ?? [])]) this.remove(key, entry);
    this.types.delete(key);
  }

  reset(): void {
    for (const [key, type] of this.types) this.dispose({ key, extension: type.owner });
  }

  private remove(key: string, entry: Entry): void {
    entry.collection.clear();
    entry.style.remove();
    entry.off();
    this.entries.get(key)?.delete(entry);
    if (!this.entries.get(key)?.size) this.entries.delete(key);
  }

  set(params: Options): void {
    const type = this.owned(params);
    if (!type) return;
    const id = this.documents.idForHostPath(text(params.path));
    const uri = id === null ? null : this.documents.modelUri(id);
    if (!uri) return;
    const target = this.editor.visibleEditorFor(uri, typeof params.editorId === "string" ? params.editorId : undefined);
    if (!target?.createDecorationsCollection) return;
    if (!Array.isArray(params.decorations)) throw new Error("Decoration ranges must be a list.");
    const values = params.decorations.map(record);
    const edits = parseEdits(values.map(value => ({ ...record(value.range), text: "" })));
    // Overlap is allowed for decorations; each range still must be inside the model.
    if (id === null) return;
    for (const range of edits) this.documents.validateHostEdits(id, [range]);
    const rules: string[] = [];
    const classes = new Map<string, string>();
    const decorations = edits.map((range, index): monaco.editor.IModelDeltaDecoration => {
      const value = values[index] ?? {};
      const overrides = record(value.renderOptions);
      const merged = { ...type.options, ...overrides };
      const signature = JSON.stringify(overrides);
      let className = classes.get(signature);
      if (!className) {
        className = `openmind-decoration-${nextClass++}`;
        classes.set(signature, className);
        this.rules(rules, className, type.options, overrides);
      }
      const hover = Array.isArray(value.hoverMessage) ? value.hoverMessage.map(message => ({
        value: text(record(message).value), isTrusted: false, supportHtml: false,
      })) : undefined;
      const attachment = (side: "before" | "after"): monaco.editor.InjectedTextOptions | undefined => {
        const options = { ...record(type.options[side]), ...record(overrides[side]) };
        if (typeof options.contentText !== "string") return undefined;
        return { content: options.contentText, inlineClassName: `${className}-${side}`, cursorStops: monaco.editor.InjectedTextCursorStops.None };
      };
      const color = this.overviewColor(record(type.options.light).overviewRulerColor ?? merged.overviewRulerColor);
      const darkColor = this.overviewColor(record(type.options.dark).overviewRulerColor ?? merged.overviewRulerColor);
      const stickiness = [monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
        monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
        monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter][Number(merged.rangeBehavior)] ?? monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
      const position = new Map([[1, monaco.editor.OverviewRulerLane.Left], [2, monaco.editor.OverviewRulerLane.Center],
        [4, monaco.editor.OverviewRulerLane.Right], [7, monaco.editor.OverviewRulerLane.Full]]).get(Number(merged.overviewRulerLane)) ?? monaco.editor.OverviewRulerLane.Full;
      const before = attachment("before"), after = attachment("after");
      return {
        range: new monaco.Range(range.startLine + 1, range.startColumn + 1, range.endLine + 1, range.endColumn + 1),
        options: {
          className, inlineClassName: `${className}-text`,
          isWholeLine: merged.isWholeLine === true,
          stickiness,
          hoverMessage: hover, before, after, showIfCollapsed: Boolean(before || after),
          overviewRuler: color || darkColor ? { color, darkColor, position } : undefined,
        },
      };
    });
    // Build all ranges and styles before replacing a previously visible decoration set.
    const style = document.createElement("style");
    style.dataset.extensionDecoration = text(params.key);
    style.textContent = rules.join("\n");
    const collection = target.createDecorationsCollection(decorations);
    document.head.append(style);
    const key = text(params.key);
    for (const existing of [...(this.entries.get(key) ?? [])]) if (existing.editor === target) this.remove(key, existing);
    const entry: Entry = { editor: target, collection, style, off: () => {} };
    const model = target.onDidChangeModel(() => { this.remove(key, entry); });
    const disposable = target.onDidDispose?.(() => { this.remove(key, entry); });
    entry.off = () => { model.dispose(); disposable?.dispose(); };
    this.entries.set(key, new Set([...(this.entries.get(key) ?? []), entry]));
    if (!values.length) this.remove(key, entry);
  }

  private overviewColor(value: unknown): string | monaco.editor.ThemeColor | undefined {
    if (typeof value === "string") return value;
    const id = record(value).id;
    return typeof id === "string" ? { id } : undefined;
  }

  private color(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const id = record(value).id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_.]+$/.test(id)) return undefined;
    const token = WORKBENCH_TOKENS[id]?.[0];
    const native = `--vscode-${id.replace(/\./g, "-")}`;
    return token ? `var(${native}, var(${token}))` : `var(${native})`;
  }

  private css(options: Options, kind: "box" | "text" | "all" = "all"): string {
    const style = document.createElement("span").style;
    for (const property of properties) {
      const inline = ["color", "fontStyle", "fontWeight", "textDecoration", "cursor", "letterSpacing"].includes(property);
      if ((kind === "text" && !inline) || (kind === "box" && inline)) continue;
      const raw = options[property];
      const value = property.toLowerCase().includes("color") ? this.color(raw) : typeof raw === "string" ? raw : undefined;
      if (property === "cursor" && value !== undefined && !/^[a-z-]+$/i.test(value)) continue;
      if (value !== undefined) style[property] = value;
    }
    return style.cssText;
  }

  private rules(rules: string[], name: string, base: Options, override: Options): void {
    for (const theme of [undefined, "light", "dark"] as const) {
      const themed = theme ? { ...base, ...record(base[theme]), ...override, ...record(override[theme]) } : { ...base, ...override };
      const prefix = theme ? `html[data-theme="${theme}"] ` : "";
      rules.push(`${prefix}.${name}{${this.css(themed, "box")}}`, `${prefix}.${name}-text{${this.css(themed, "text")}}`);
      for (const side of ["before", "after"] as const) {
        const options = { ...record(base[side]), ...record(theme ? record(base[theme])[side] : undefined), ...record(override[side]), ...record(theme ? record(override[theme])[side] : undefined) };
        rules.push(`${prefix}.${name}-${side}{${this.css(options)}}`);
      }
    }
  }
}
