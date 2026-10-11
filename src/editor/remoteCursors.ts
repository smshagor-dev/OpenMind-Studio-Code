import * as Y from "yjs";

import { fromBase64 } from "../services/collab/collabDocIpc";
import type { LiveDoc } from "../services/collab/collabDocService";
import type { PeerPresence } from "../services/collab/presenceService";
import { colorOf } from "../services/collab/presenceService";

/** The parts of Monaco the renderer uses (kept small so it can be tested without an editor). */
export interface CursorModel {
  getPositionAt: (offset: number) => { lineNumber: number; column: number };
  getValueLength: () => number;
}

export interface Decoration {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  options: {
    className?: string;
    beforeContentClassName?: string;
    hoverMessage?: { value: string };
    stickiness?: number;
    zIndex?: number;
  };
}

export interface DecorationSet {
  set: (decorations: Decoration[]) => void;
  clear: () => void;
}

export interface CursorEditor {
  getModel: () => CursorModel | null;
  createDecorationsCollection: () => DecorationSet;
}

export interface CursorSource {
  liveFor: (model: CursorModel) => LiveDoc | null;
  peers: (roomUid: string) => PeerPresence[];
  nameOf: (roomUid: string, peer: string) => string | null;
}

/** Monaco's `TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges`: another member's marker never swallows typing. */
const NEVER_GROWS = 1;

/** A Yjs relative position back to an offset in today's text, or null when the place no longer exists. */
export function resolve(doc: Y.Doc, encoded: string): number | null {
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(encoded)),
      doc,
    );
    return position ? position.index : null;
  } catch {
    return null; // a malformed position from someone is ignored, never thrown into the editor
  }
}

/** A display name as a CSS string (names are already plain: the Owner refuses control characters). */
export function cssString(text: string): string {
  const clean = text
    .replace(/\p{Cc}/gu, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${clean}"`;
}

/**
 * Other members' cursors and selections in the editors of this window (Milestone 24, phase 7). Positions arrive as
 * Yjs relative positions and are resolved against the document's current text, so they land correctly after
 * concurrent edits (emoji included: Yjs and Monaco both count UTF-16 units). Each editor keeps one decoration
 * collection that is updated in place — no decoration churn — and cleared when nobody is in its file. Names are drawn
 * by one shared stylesheet (`::after` labels), rewritten only when the set of names changes.
 */
export class RemoteCursors {
  private editors = new Map<CursorEditor, DecorationSet>();
  private labels = new Map<string, number>();
  private styleText = "";

  constructor(
    private readonly source: CursorSource,
    private readonly style: { set: (css: string) => void },
  ) {}

  attach(editor: CursorEditor): () => void {
    this.editors.set(editor, editor.createDecorationsCollection());
    this.renderEditor(editor);
    this.writeLabels();
    return () => {
      this.editors.get(editor)?.clear();
      this.editors.delete(editor);
    };
  }

  /** Presence changed, a document changed, an editor switched models: draw again. */
  render(): void {
    for (const editor of this.editors.keys()) this.renderEditor(editor);
    this.writeLabels();
  }

  renderEditor(editor: CursorEditor): void {
    const set = this.editors.get(editor);
    const model = editor.getModel();
    if (!set) return;
    const live = model ? this.source.liveFor(model) : null;
    if (!model || !live) {
      set.clear();
      return;
    }
    const decorations: Decoration[] = [];
    for (const p of this.source.peers(live.roomUid)) {
      if (p.state.active !== live.fileId || !p.state.cursor) continue;
      decorations.push(...this.decorate(live, model, p));
    }
    if (decorations.length === 0) set.clear();
    else set.set(decorations);
  }

  private decorate(live: LiveDoc, model: CursorModel, p: PeerPresence): Decoration[] {
    const cursor = p.state.cursor;
    if (!cursor) return [];
    const length = model.getValueLength();
    const head = resolve(live.doc, cursor.head);
    if (head === null) return [];
    const anchor = resolve(live.doc, cursor.anchor) ?? head;
    const at = (offset: number) => model.getPositionAt(Math.min(Math.max(offset, 0), length));
    const color = colorOf(p.peer);
    const name = this.source.nameOf(live.roomUid, p.peer) ?? "";
    const label = this.labelOf(name);
    const h = at(head);
    const out: Decoration[] = [];
    if (anchor !== head) {
      const [from, to] = anchor < head ? [at(anchor), h] : [h, at(anchor)];
      out.push({
        range: {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: to.column,
        },
        options: { className: `collab-selection collab-bg-${color}`, stickiness: NEVER_GROWS },
      });
    }
    const typing = p.state.typing ? " collab-caret--typing" : "";
    // On the first line there is no room above the caret: the name goes below it.
    const below = h.lineNumber === 1 ? " collab-caret--below" : "";
    out.push({
      range: {
        startLineNumber: h.lineNumber,
        startColumn: h.column,
        endLineNumber: h.lineNumber,
        endColumn: h.column,
      },
      options: {
        beforeContentClassName: `collab-caret collab-fg-${color} collab-label-${label}${typing}${below}`,
        hoverMessage: name ? { value: name } : undefined,
        stickiness: NEVER_GROWS,
        zIndex: 20,
      },
    });
    return out;
  }

  /** A small number per distinct name, for its `::after` label rule. */
  private labelOf(name: string): number {
    let id = this.labels.get(name);
    if (id === undefined) {
      id = this.labels.size + 1;
      this.labels.set(name, id);
    }
    return id;
  }

  private writeLabels(): void {
    const css = [...this.labels]
      .map(([name, id]) => `.collab-label-${id}::after{content:${cssString(name)};}`)
      .join("\n");
    if (css === this.styleText) return;
    this.styleText = css;
    this.style.set(css);
  }
}
