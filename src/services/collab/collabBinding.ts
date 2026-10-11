import type * as monaco from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";

import { markLive } from "../../editor/collabModels";

/** The origin of changes that came from elsewhere (the Owner, another member): never sent back out. */
export const REMOTE = Symbol("collab-remote");

/** The shared text type, the same as the Owner's `yrs` documents (`crdt::TEXT_NAME`). */
export const TEXT_NAME = "content";

/** Local changes are gathered this long and sent as one merged update (fewer messages and stored rows). */
export const SEND_DELAY_MS = 40;

type UndoableModel = monaco.editor.ITextModel & { undo: () => void; redo: () => void };

/**
 * One collaborative text document bound to an existing Monaco model:
 *
 * - `y-monaco` keeps the model and the Yjs text equal: local typing becomes Yjs transactions whose origin is the
 *   binding; remote changes (origin [`REMOTE`]) are applied to the model without going through Monaco's undo stack.
 * - Undo/redo use a Yjs `UndoManager` that tracks **only this side's own changes**: another member's edits never land
 *   in this user's undo history. The model's `undo`/`redo` (what every editor undo command calls) are routed there
 *   while bound, and restored afterwards.
 * - Every change not from [`REMOTE`] is sent: merged over [`SEND_DELAY_MS`], so a burst of keystrokes is one update.
 */
export class CollabBinding {
  readonly text: Y.Text;
  private readonly binding: MonacoBinding;
  private readonly undo: Y.UndoManager;
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(
    readonly doc: Y.Doc,
    private readonly model: monaco.editor.ITextModel,
    private readonly sendUpdate: (update: Uint8Array) => void,
    /** Told about every change, local or not (presence: typing and remote cursors follow the text). */
    private readonly changed?: (local: boolean) => void,
  ) {
    this.text = doc.getText(TEXT_NAME);
    // From now on the model's text is the CRDT's; no snapshot may be written into it again.
    markLive(model);
    this.onUpdate = (update, origin) => {
      this.changed?.(origin !== REMOTE);
      if (origin === REMOTE) return;
      this.pending.push(update);
      this.timer ??= setTimeout(() => {
        this.flush();
      }, SEND_DELAY_MS);
    };
    doc.on("update", this.onUpdate);
    this.binding = new MonacoBinding(this.text, model);
    this.undo = new Y.UndoManager(this.text, { trackedOrigins: new Set([this.binding]) });
    const undoable = model as UndoableModel;
    undoable.undo = () => {
      this.undo.undo();
    };
    undoable.redo = () => {
      this.undo.redo();
    };
  }

  /** Another side's change (applied to the model; not part of this user's undo history). */
  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE);
  }

  /** Sends what was gathered now (also before closing). */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length === 0) return;
    const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
    this.pending = [];
    if (merged) this.sendUpdate(merged);
  }

  destroy(): void {
    this.flush();
    this.doc.off("update", this.onUpdate);
    this.undo.destroy();
    this.binding.destroy();
    const undoable = this.model as Partial<UndoableModel> & object;
    // Back to Monaco's own undo (the instance properties shadowed the prototype's).
    delete undoable.undo;
    delete undoable.redo;
  }
}

/** Makes `text` hold `target` with one minimal edit (common prefix and suffix kept), as a local change. */
export function setText(doc: Y.Doc, target: string): void {
  const text = doc.getText(TEXT_NAME);
  const current = text.toJSON();
  if (current === target) return;
  let prefix = 0;
  while (prefix < current.length && prefix < target.length && current[prefix] === target[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < target.length - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  // Never split a surrogate pair (an emoji): Yjs encodes text as UTF-8, where half a pair can't exist.
  const high = (code: number): boolean => code >= 0xd800 && code < 0xdc00;
  const low = (code: number): boolean => code >= 0xdc00 && code < 0xe000;
  if (prefix > 0 && high(target.charCodeAt(prefix - 1))) prefix -= 1;
  if (suffix > 0 && low(target.charCodeAt(target.length - suffix))) suffix -= 1;
  doc.transact(() => {
    text.delete(prefix, current.length - prefix - suffix);
    text.insert(prefix, target.slice(prefix, target.length - suffix));
  });
}
