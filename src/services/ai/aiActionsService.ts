import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { FilePreviewDoc } from "../filePreviewService";
import type { LayoutService } from "../layoutService";
import type { AiChatService } from "./aiChatService";
import {
  MAX_ACTION_CHARS,
  docsPrompt,
  explainPrompt,
  fixPrompt,
  previewPrompt,
  previewText,
  terminalPrompt,
  type ActiveKind,
  type AiActionKind,
  type AiSelection,
} from "./aiContext";

/** What the actions may read from the workbench — each is something the user has selected or is looking at. */
export interface AiContextSource {
  activeKind: () => ActiveKind;
  /** The selection of the active text editor (only while a text tab is in front). */
  selection: () => AiSelection | null;
  /** The selected text of the active terminal. */
  terminalSelection: () => string;
  /** The active file preview. */
  activePreview: () => FilePreviewDoc | null;
  /** Inserts text at the cursor of the active text editor; false when there is none. */
  insertAtCursor: (text: string) => boolean;
}

export const AI_ACTION_COMMANDS: Record<AiActionKind, string> = {
  explain: "ai.explainSelection",
  fix: "ai.suggestFix",
  docs: "ai.generateDocs",
  terminal: "ai.explainTerminalError",
  preview: "ai.summarizePreview",
};

export const AI_ACTION_LABELS: Record<AiActionKind, string> = {
  explain: "Explain Selected Code",
  fix: "Suggest Fix for Selected Code",
  docs: "Generate Comment / Docstring",
  terminal: "Explain Terminal Error",
  preview: "Summarize Current Preview",
};

/**
 * The AI actions: each takes something the user selected or is looking at, builds a prompt and hands it to the chat,
 * which asks before it leaves the computer. `reason()` is why an action can't run right now (shown as the reason
 * a button or command is disabled); `run()` refuses with that same message. Nothing is ever collected in the
 * background — an action reads its source at the moment the user runs it.
 */
export class AiActionsService {
  constructor(
    private readonly source: AiContextSource,
    private readonly chat: AiChatService,
    private readonly layout: Pick<LayoutService, "showView">,
    private readonly events: EventBus<AppEvents>,
  ) {}

  /** Why the action can't run now, or null. */
  reason(kind: AiActionKind): string | null {
    switch (kind) {
      case "explain":
      case "fix":
      case "docs":
        return this.selectionReason();
      case "terminal": {
        const text = this.source.terminalSelection();
        if (text.trim() === "") return "Select the terminal output to explain first.";
        return text.length > MAX_ACTION_CHARS ? this.tooLarge(text.length) : null;
      }
      case "preview": {
        const doc = this.source.activePreview();
        if (doc === null) return "Open a file preview first.";
        const { text, reason } = previewText(doc);
        if (text === null) return reason;
        return text.length > MAX_ACTION_CHARS ? this.tooLarge(text.length) : null;
      }
    }
  }

  private selectionReason(): string | null {
    const active = this.source.activeKind();
    if (active === "preview") return "A preview is not a text editor. Switch to a text file.";
    if (active === "none") return "Open a text file and select some code first.";
    const selection = this.source.selection();
    if (selection === null || selection.text.trim() === "") return "Select some code first.";
    return selection.text.length > MAX_ACTION_CHARS ? this.tooLarge(selection.text.length) : null;
  }

  private tooLarge(chars: number): string {
    return `That is too much text to send at once (${chars.toLocaleString()} characters; the limit is ${MAX_ACTION_CHARS.toLocaleString()}).`;
  }

  async run(kind: AiActionKind): Promise<void> {
    const reason = this.reason(kind);
    if (reason !== null) {
      this.events.emit("appNotice", { message: reason });
      return;
    }
    const label = AI_ACTION_LABELS[kind];
    let text: string;
    let what: string;
    let title = label;
    if (kind === "terminal") {
      text = terminalPrompt(this.source.terminalSelection());
      what = "the selected terminal output";
    } else if (kind === "preview") {
      const doc = this.source.activePreview();
      const body = doc === null ? null : previewText(doc).text;
      if (doc === null || body === null) return;
      text = previewPrompt(doc.name, doc.model?.type ?? "file", body);
      what = `text from the preview of ${doc.name}`;
      title = `${label}: ${doc.name}`;
    } else {
      const selection = this.source.selection();
      if (selection === null) return;
      text =
        kind === "explain"
          ? explainPrompt(selection)
          : kind === "fix"
            ? fixPrompt(selection)
            : docsPrompt(selection);
      what = "the selected code";
      title = `${label}${selection.fileName === null ? "" : `: ${selection.fileName}`}`;
    }
    await this.layout.showView("ai");
    await this.chat.submit({ text, what, title });
  }

  /** Puts an answer (or a code block of it) at the cursor of the active text editor — only when the user asks. */
  insertReason(): string | null {
    const active = this.source.activeKind();
    if (active === "preview") return "A preview can't be edited. Switch to a text file.";
    return active === "text" ? null : "Open a text file to insert into.";
  }

  insert(text: string): boolean {
    if (this.insertReason() !== null) {
      this.events.emit("appNotice", { message: this.insertReason() ?? "" });
      return false;
    }
    return this.source.insertAtCursor(text);
  }
}
