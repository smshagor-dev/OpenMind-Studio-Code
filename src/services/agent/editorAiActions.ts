import type { AgentMode } from "./agentIpc";

/** What the editor shows of one file when an OpenMindAI action runs. */
export interface EditorSnapshot {
  /** Absolute path. */
  path: string;
  /** Relative to the open folder (or the file name when outside it). */
  relative: string;
  language: string;
  /** The editor's whole text, unsaved edits included. */
  text: string;
  /** The selection (1-based, inclusive lines), or `null`. */
  selection: { startLine: number; endLine: number; text: string } | null;
  cursorLine: number;
}

export interface TextAttachment {
  id: string;
  name: string;
  text: string;
}

export interface EditorAiHost {
  attachText: (name: string, text: string) => void;
  send: (text: string, attachments: TextAttachment[], mode: AgentMode) => Promise<boolean>;
  /** Why the agent can't take a message now (no model, no folder ...), or `null`. */
  blocker: () => string | null;
  showAgent: () => void;
  notice: (message: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** Lines of context sent around a selection. */
const CONTEXT_LINES = 20;
/** Without a selection, actions send the whole file up to this many lines, else this many around the cursor. */
const WHOLE_FILE_LINES = 400;
const AROUND_CURSOR = 60;

function lines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
}

/** A block of code with its file, lines and language, as an attachment's text. */
export function codeBlock(snapshot: EditorSnapshot, startLine: number, endLine: number, body: string): string {
  const marker = fence(body);
  return `File: ${snapshot.relative} (lines ${String(startLine)}-${String(endLine)}, ${snapshot.language})\n${marker}${snapshot.language}\n${body}\n${marker}`;
}

/** The part of the file an action is about: the selection, else the whole file (small) or the cursor's surroundings. */
export function focusRange(snapshot: EditorSnapshot): { startLine: number; endLine: number } {
  if (snapshot.selection) return { startLine: snapshot.selection.startLine, endLine: snapshot.selection.endLine };
  const count = lines(snapshot.text).length;
  if (count <= WHOLE_FILE_LINES) return { startLine: 1, endLine: count };
  const startLine = Math.max(1, snapshot.cursorLine - AROUND_CURSOR / 2);
  return { startLine, endLine: Math.min(count, startLine + AROUND_CURSOR) };
}

function slice(text: string, startLine: number, endLine: number): string {
  return lines(text).slice(startLine - 1, endLine).join("\n");
}

/** The code an action sends (the focus range) and its surroundings, as attachments. */
export function codeAttachments(snapshot: EditorSnapshot): TextAttachment[] {
  const { startLine, endLine } = focusRange(snapshot);
  const total = lines(snapshot.text).length;
  const before = Math.max(1, startLine - CONTEXT_LINES);
  const after = Math.min(total, endLine + CONTEXT_LINES);
  const result: TextAttachment[] = [
    {
      id: crypto.randomUUID(),
      name: `${snapshot.relative}:${String(startLine)}-${String(endLine)}`,
      text: codeBlock(snapshot, startLine, endLine, slice(snapshot.text, startLine, endLine)),
    },
  ];
  if (before < startLine || after > endLine) {
    result.push({
      id: crypto.randomUUID(),
      name: `${snapshot.relative} (context)`,
      text: codeBlock(snapshot, before, after, slice(snapshot.text, before, after)),
    });
  }
  return result;
}

export function explainPrompt(snapshot: EditorSnapshot): string {
  const { startLine, endLine } = focusRange(snapshot);
  return [
    `Explain the code in ${snapshot.relative}, lines ${String(startLine)}-${String(endLine)} (attached; the second attachment is the surrounding code).`,
    "Say what it does, how it works and why it is written this way, then anything surprising or easy to get wrong.",
    "Refer to lines as path:line. This is a question about the code: do not change any files.",
  ].join("\n");
}

export function reviewPrompt(snapshot: EditorSnapshot): string {
  const { startLine, endLine } = focusRange(snapshot);
  return [
    `Review the code in ${snapshot.relative}, lines ${String(startLine)}-${String(endLine)} (attached, with its surroundings).`,
    "Look for bugs, security problems, incorrect behaviour and performance concerns.",
    "For each finding give the location as path:line, what goes wrong and when, and a suggested fix.",
    "Say how sure you are. Call something a bug only when the code shown proves it; otherwise call it a possible issue and say what would confirm it. If you find nothing, say so.",
    "Do not change any files.",
  ].join("\n");
}

/**
 * The OpenMindAI actions of the editor's context menu: they hand the code to the agent's conversation (as
 * attachments) and show the agent panel. Explain and Review run in plan mode, so the agent can read the project but
 * changes nothing.
 */
export class EditorAiActions {
  constructor(private readonly host: EditorAiHost) {}

  /** Add File to Chat: the selection (with its lines) or the whole file, as an attachment of the next message. */
  addFileToChat(snapshot: EditorSnapshot): void {
    const selection = snapshot.selection;
    const total = lines(snapshot.text).length;
    const name = selection
      ? `${snapshot.relative}:${String(selection.startLine)}-${String(selection.endLine)}`
      : snapshot.relative;
    const text = selection
      ? codeBlock(snapshot, selection.startLine, selection.endLine, selection.text)
      : codeBlock(snapshot, 1, total, snapshot.text);
    this.host.attachText(name, text);
    this.host.showAgent();
    this.host.notice(this.host.t("editorAi.attached", { name }));
  }

  /** Add to OpenMindAI Chat: the selection, or the code around the cursor, with its context. */
  addToChat(snapshot: EditorSnapshot): void {
    for (const attachment of codeAttachments(snapshot)) this.host.attachText(attachment.name, attachment.text);
    this.host.showAgent();
    this.host.notice(this.host.t("editorAi.addedToChat", { name: snapshot.relative }));
  }

  private async ask(prompt: string, snapshot: EditorSnapshot): Promise<void> {
    const blocker = this.host.blocker();
    this.host.showAgent();
    if (blocker !== null) throw new Error(blocker);
    const accepted = await this.host.send(prompt, codeAttachments(snapshot), "plan");
    if (!accepted) throw new Error(this.host.t("editorAi.notQueued"));
  }

  explain(snapshot: EditorSnapshot): Promise<void> {
    return this.ask(explainPrompt(snapshot), snapshot);
  }

  review(snapshot: EditorSnapshot): Promise<void> {
    return this.ask(reviewPrompt(snapshot), snapshot);
  }
}
