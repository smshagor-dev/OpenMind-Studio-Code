import { invoke } from "@tauri-apps/api/core";
import type * as monaco from "monaco-editor";

/** The editor API inline chat uses (structural, so tests pass a fake). */
export interface InlineEditor {
  getModel: () => monaco.editor.ITextModel | null;
  executeEdits: monaco.editor.ICodeEditor["executeEdits"];
  pushUndoStop: () => boolean;
  focus: () => void;
}

export interface InlineRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface InlineMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InlineIpc {
  complete: (request: {
    requestId: string;
    modelId: string;
    useGpu: boolean;
    contextTokens: number;
    messages: InlineMessage[];
  }) => Promise<string>;
  cancel: (requestId: string) => Promise<void>;
}

export const tauriInlineIpc: InlineIpc = {
  complete: (request) => invoke("agent_inline_complete", { request }),
  cancel: (requestId) => invoke("agent_inline_cancel", { requestId }),
};

export interface InlineHost {
  ipc: InlineIpc;
  /** The agent's model and engine options, or a reason the model can't be used. */
  model: () => { modelId: string; useGpu: boolean; contextTokens: number } | { blocked: string };
  /** The file's path relative to the folder, for the prompt. */
  describe: (model: monaco.editor.ITextModel) => { name: string; language: string };
  t: (key: string, params?: Record<string, string | number>) => string;
}

export type InlineStatus = "idle" | "working" | "proposed" | "error";

export interface InlineChatState {
  editor: InlineEditor;
  range: InlineRange;
  /** The selected text the proposal replaces ("" when inserting at the cursor). */
  original: string;
  status: InlineStatus;
  proposal: string | null;
  error: string | null;
  /** Earlier instructions and answers, for Refine. */
  turns: { instruction: string; proposal: string }[];
  requestId: string | null;
}

/** Lines of code around the selection the model sees. */
const CONTEXT_LINES = 40;

const SYSTEM = [
  "You are OpenMindAI, a coding assistant inside the OpenMind Studio editor.",
  "You are given part of a file and an instruction. Write the code that should replace the selection (or be inserted at the cursor when nothing is selected).",
  "Reply with only that code: no explanation, no Markdown fences, nothing before or after it.",
  "Keep the file's language, indentation and style. Keep code the instruction doesn't ask to change.",
  "If the instruction asks a question instead of a change, answer it as a comment in the file's language.",
].join("\n");

/** The model's answer without Markdown fences around it (models add them despite being asked not to). */
export function cleanAnswer(answer: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(answer);
  const body = fenced ? (fenced[1] ?? "") : answer;
  return body.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/** The conversation sent to the model for an instruction (with earlier turns for Refine). */
export function inlineMessages(
  file: { name: string; language: string },
  before: string,
  selection: string,
  after: string,
  turns: { instruction: string; proposal: string }[],
  instruction: string,
): InlineMessage[] {
  const context = [
    `File: ${file.name} (${file.language})`,
    "Code before the selection:",
    "<before>",
    before,
    "</before>",
    selection.length > 0 ? "Selection (to replace):" : "Nothing is selected: write code to insert at the cursor.",
    "<selection>",
    selection,
    "</selection>",
    "Code after the selection:",
    "<after>",
    after,
    "</after>",
  ].join("\n");
  const messages: InlineMessage[] = [{ role: "system", content: SYSTEM }];
  const [first, ...rest] = turns;
  if (first === undefined) {
    messages.push({ role: "user", content: `${context}\n\nInstruction: ${instruction}` });
    return messages;
  }
  messages.push({ role: "user", content: `${context}\n\nInstruction: ${first.instruction}` });
  messages.push({ role: "assistant", content: first.proposal });
  for (const turn of rest) {
    messages.push({ role: "user", content: `Change it: ${turn.instruction}` });
    messages.push({ role: "assistant", content: turn.proposal });
  }
  messages.push({ role: "user", content: `Change it: ${instruction}` });
  return messages;
}

function surroundings(model: monaco.editor.ITextModel, range: InlineRange): { before: string; after: string } {
  const lineCount = model.getLineCount();
  const startLine = Math.max(1, range.startLineNumber - CONTEXT_LINES);
  const endLine = Math.min(lineCount, range.endLineNumber + CONTEXT_LINES);
  return {
    before: model.getValueInRange({
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: range.startLineNumber,
      endColumn: range.startColumn,
    }),
    after: model.getValueInRange({
      startLineNumber: range.endLineNumber,
      startColumn: range.endColumn,
      endLineNumber: endLine,
      endColumn: model.getLineMaxColumn(endLine),
    }),
  };
}

let nextRequest = 0;

/**
 * Inline chat (Ctrl+I): an instruction about the selection (or the cursor) goes to the OpenMindAI model on this
 * computer; its answer is shown as a proposed change the user accepts (one undoable edit), rejects or refines.
 * Nothing changes until Accept, and Accept refuses when the code under the selection changed meanwhile.
 */
export class InlineChatService {
  private state: InlineChatState | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: InlineHost) {}

  getState(): InlineChatState | null {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(state: InlineChatState | null): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private patch(change: Partial<InlineChatState>): void {
    if (this.state) this.set({ ...this.state, ...change });
  }

  /** Opens inline chat on the editor's selection (or cursor). */
  open(editor: InlineEditor, selection: InlineRange): void {
    const model = editor.getModel();
    if (model === null) throw new Error(this.host.t("inlineChat.noEditor"));
    if (this.state) this.close();
    this.set({
      editor,
      range: selection,
      original: model.getValueInRange(selection),
      status: "idle",
      proposal: null,
      error: null,
      turns: [],
      requestId: null,
    });
  }

  /** Sends an instruction (the first, or a refinement of the current proposal). */
  async submit(instruction: string): Promise<void> {
    const state = this.state;
    const text = instruction.trim();
    if (state === null || text.length === 0 || state.status === "working") return;
    const model = state.editor.getModel();
    if (model === null) return;
    const engine = this.host.model();
    if ("blocked" in engine) {
      this.patch({ status: "error", error: engine.blocked });
      return;
    }
    // A second instruction refines the proposal on screen; without one it starts over.
    const turns = state.proposal !== null ? state.turns : [];
    const { before, after } = surroundings(model, state.range);
    const requestId = `inline-${String(++nextRequest)}`;
    this.patch({ status: "working", error: null, requestId });
    try {
      const answer = await this.host.ipc.complete({
        requestId,
        modelId: engine.modelId,
        useGpu: engine.useGpu,
        contextTokens: engine.contextTokens,
        messages: inlineMessages(this.host.describe(model), before, state.original, after, turns, text),
      });
      if (this.state?.requestId !== requestId) return;
      const proposal = cleanAnswer(answer);
      if (proposal.length === 0) throw new Error(this.host.t("inlineChat.empty"));
      this.patch({ status: "proposed", proposal, requestId: null, turns: [...turns, { instruction: text, proposal }] });
    } catch (error) {
      if (this.state?.requestId !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      this.patch({
        status: message === "cancelled" ? "idle" : "error",
        error: message === "cancelled" ? null : message,
        requestId: null,
      });
    }
  }

  /** Stops the request in flight. */
  async cancel(): Promise<void> {
    const id = this.state?.requestId;
    if (!id) return;
    this.patch({ status: this.state?.proposal ? "proposed" : "idle", requestId: null });
    await this.host.ipc.cancel(id);
  }

  /** Replaces the selection with the proposal as one undoable edit. */
  accept(): void {
    const state = this.state;
    if (state === null || state.proposal === null) return;
    const model = state.editor.getModel();
    if (model === null) return;
    if (model.getValueInRange(state.range) !== state.original) {
      this.patch({ status: "error", error: this.host.t("inlineChat.changed") });
      return;
    }
    state.editor.pushUndoStop();
    state.editor.executeEdits("openmind-inline-chat", [
      { range: state.range, text: state.proposal, forceMoveMarkers: true },
    ]);
    state.editor.pushUndoStop();
    this.close();
    state.editor.focus();
  }

  /** Throws the proposal away; the code stays as it was. */
  reject(): void {
    const editor = this.state?.editor;
    this.close();
    editor?.focus();
  }

  close(): void {
    const id = this.state?.requestId;
    if (id) void this.host.ipc.cancel(id);
    this.set(null);
  }
}
