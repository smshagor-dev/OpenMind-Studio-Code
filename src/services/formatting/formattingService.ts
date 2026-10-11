import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { IpcClient } from "../ipc";
import type {
  FormatOptionsAnswer,
  FormatPolicy,
  FormatterInfo,
  FormatterSourceName,
} from "./formattingIpc";

/** The id of the language server option (its formatting is asked of the running server). */
export const LSP_FORMATTER_ID = "lsp";
/** Files larger than this are not formatted (the same limit as the backend). */
export const MAX_FORMAT_CHARS = 2_000_000;

const DEFAULTS_KEY = "formatting.defaults";

/** What a formatter needs to know about the document. */
export interface FormatTarget {
  id: string;
  /** `null` for an unsaved file. */
  path: string | null;
  /** The editor's language id. */
  language: string;
  eol: "\n" | "\r\n";
  /** One indentation level. */
  indent: string;
}

/** Everything the service needs from the editor side, so it stays free of Monaco and React. */
export interface FormattingHost {
  /** The text tab in front, or why there is none (a preview, no editor ...). */
  active(): { target: FormatTarget } | { reason: string };
  /** A document by id, or `null` when it is gone or is not a text document. */
  target(id: string): FormatTarget | null;
  text(id: string): string;
  /** Replaces the text as one undoable edit that keeps the cursor where it can. */
  apply(id: string, text: string): void;
  /** The language server's formatting for this document, when a running server supports it. */
  lsp(id: string): { available: boolean; reason: string | null; run: () => Promise<string | null> };
  /**
   * Formatters extensions registered for this document (Milestone 18), `ext:<extension id>`: offered as choices, used
   * by themselves only when nothing else can format the file.
   */
  extensionFormatters?(id: string): { id: string; name: string; run: () => Promise<string | null> }[];
}

export interface FormattingSettings {
  bool: (id: string, fallback: boolean) => boolean;
  number: (id: string, fallback: number) => number;
  string: (id: string, fallback: string) => string;
}

export type ChoiceSource = FormatterSourceName | "languageServer" | "extension";

export interface FormatterChoice {
  id: string;
  name: string;
  source: ChoiceSource | null;
  available: boolean;
  reason: string | null;
  path: string | null;
}

/** What the status bar and the dialog say about the file in front. */
export interface FormatterStatus {
  targetId: string;
  language: string;
  languageName: string;
  choices: FormatterChoice[];
  selected: FormatterChoice | null;
  reason: string | null;
}

export type DialogMode = "with" | "configure" | "status";

export interface FormatterDialogState {
  mode: DialogMode;
  status: FormatterStatus;
  remember: boolean;
}

export interface FormattingState {
  status: FormatterStatus | null;
  dialog: FormatterDialogState | null;
  busy: boolean;
}

export type FormatOutcome =
  | { kind: "formatted"; formatter: string }
  | { kind: "unchanged"; formatter: string }
  | { kind: "none"; message: string }
  | { kind: "failed"; message: string; formatter: string | null }
  | { kind: "skipped"; message: string };

const SOURCE_LABEL: Record<ChoiceSource, string> = {
  builtIn: "built in",
  project: "from the project",
  bundled: "bundled with OpenMind",
  portable: "from OpenMind's runtimes",
  system: "from the system PATH",
  languageServer: "language server",
  extension: "from an extension",
};

export function sourceLabel(source: ChoiceSource | null): string {
  return source === null ? "not found" : SOURCE_LABEL[source];
}

/** One line for the status bar: "JSON — Built-in JSON formatter", "Python — Black missing, Ruff missing". */
export function statusText(status: FormatterStatus): string {
  const { selected, choices, languageName } = status;
  if (selected !== null) {
    const where =
      selected.source === null || selected.source === "builtIn"
        ? ""
        : ` (${sourceLabel(selected.source)})`;
    return `${languageName} — ${selected.name}${where}`;
  }
  const missing = choices.map((choice) =>
    choice.path === null ? `${choice.name} missing` : `${choice.name} unavailable`,
  );
  return missing.length === 0
    ? `${languageName} — no formatter`
    : `${languageName} — ${missing.join(", ")}`;
}

function toChoice(info: FormatterInfo): FormatterChoice {
  return {
    id: info.id,
    name: info.name,
    source: info.source,
    available: info.available,
    reason: info.reason,
    path: info.path,
  };
}

/**
 * Formats documents: asks the backend which formatter applies (a built-in one, the project's own tool, a bundled one,
 * a portable runtime's, a system one only when allowed) or the language server, runs it on the editor's text and
 * applies the answer as one undoable edit. Nothing here pretends: with no formatter it says why, and a failing
 * formatter leaves the text alone.
 */
export class FormattingService {
  private state: FormattingState = { status: null, dialog: null, busy: false };
  private readonly listeners = new Set<() => void>();
  private defaults: Record<string, string> = {};
  private running = new Set<string>();
  private statusSeq = 0;
  /** What the last status lookup was for (see `refreshStatusIfChanged`). */
  private statusKey: string | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly host: FormattingHost,
    private readonly settings: FormattingSettings,
    private readonly events: EventBus<AppEvents>,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  // --- State for the UI ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): FormattingState => this.state;

  private set(patch: Partial<FormattingState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  // --- Settings ---

  /** Loads the per-language default formatters the user chose with Format Document With / Configure. */
  async initialize(): Promise<void> {
    try {
      const raw = await this.ipc.settingsGet(DEFAULTS_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        this.defaults = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {
      this.defaults = {};
    }
  }

  policy(): FormatPolicy {
    return {
      project: this.settings.bool("formatter.useProjectLocalTools", true),
      bundled: this.settings.bool("formatter.useBundledTools", true),
      system: this.settings.bool("formatter.useSystemTools", false),
    };
  }

  private timeoutMs(): number {
    return this.settings.number("formatter.timeoutMs", 10_000);
  }

  /** The formatter the user prefers for a language: their per-language choice, else the global default setting. */
  preferredFor(language: string): string | null {
    const chosen = this.defaults[language];
    if (chosen !== undefined && chosen !== "") return chosen;
    const global = this.settings.string("editor.defaultFormatter", "").trim();
    return global === "" ? null : global;
  }

  formatOnSaveEnabled(): boolean {
    return this.settings.bool("editor.formatOnSave", true);
  }

  private async saveDefaults(): Promise<void> {
    try {
      await this.ipc.settingsSet(DEFAULTS_KEY, JSON.stringify(this.defaults));
    } catch (error) {
      this.events.emit("appError", {
        message: `Could not remember the default formatter: ${String(error)}`,
      });
    }
  }

  // --- Looking up ---

  private async lookUp(target: FormatTarget): Promise<FormatterStatus> {
    const answer: FormatOptionsAnswer = await this.ipc.formatOptions(
      target.path,
      target.language,
      this.preferredFor(target.language),
      this.policy(),
    );
    const choices = answer.formatters.map(toChoice);
    const lsp = this.host.lsp(target.id);
    if (lsp.available) {
      choices.push({
        id: LSP_FORMATTER_ID,
        name: "Language server",
        source: "languageServer",
        available: true,
        reason: null,
        path: null,
      });
    }
    const extensionChoices = (this.host.extensionFormatters?.(target.id) ?? []).map(
      (formatter): FormatterChoice => ({
        id: formatter.id,
        name: formatter.name,
        source: "extension",
        available: true,
        reason: null,
        path: null,
      }),
    );
    choices.push(...extensionChoices);
    const preferred = this.preferredFor(target.language);
    const backend = choices.find((c) => c.id === answer.selected) ?? null;
    let selected: FormatterChoice | null = null;
    let reason = answer.reason;
    const preferredExtension = extensionChoices.find((c) => c.id === preferred) ?? null;
    if (preferredExtension !== null) {
      selected = preferredExtension;
    } else if (preferred === LSP_FORMATTER_ID && lsp.available) {
      selected = choices.find((c) => c.id === LSP_FORMATTER_ID) ?? null;
    } else if (backend !== null) {
      selected = backend;
    } else if (lsp.available && (preferred === null || !choices.some((c) => c.id === preferred))) {
      selected = choices.find((c) => c.id === LSP_FORMATTER_ID) ?? null;
    }
    // An extension's formatter is the last resort: only when nothing else can format the file.
    if (selected === null && extensionChoices.length > 0) selected = extensionChoices[0] ?? null;
    if (selected !== null) reason = null;
    return {
      targetId: target.id,
      language: target.language,
      languageName: answer.languageName ?? target.language,
      choices,
      selected,
      reason,
    };
  }

  /**
   * Re-reads the status only when what it depends on changed — the file in front, its path, language, line ending,
   * indentation or language server — not on every edit. (The workspace notifies on each keystroke, also on each remote
   * collaborator's keystroke; a backend lookup each time starved the database under fast typing.)
   */
  async refreshStatusIfChanged(): Promise<void> {
    const active = this.host.active();
    const key =
      "target" in active
        ? JSON.stringify([
            active.target.id,
            active.target.path,
            active.target.language,
            active.target.eol,
            active.target.indent,
            this.host.lsp(active.target.id).available,
          ])
        : `none:${active.reason}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    await this.refreshStatus();
  }

  /** Re-reads what formatter applies to the file in front (status bar). Never runs a formatter. */
  async refreshStatus(): Promise<void> {
    const seq = ++this.statusSeq;
    const active = this.host.active();
    if (!("target" in active)) {
      this.set({ status: null });
      return;
    }
    try {
      const status = await this.lookUp(active.target);
      if (seq === this.statusSeq) this.set({ status });
    } catch (error) {
      if (seq === this.statusSeq) this.set({ status: null });
      this.log(`Could not look up formatters: ${String(error)}`);
    }
  }

  /** Why Format Document can't run right now (a preview, no editor ...), or `undefined` when it can. */
  unavailableReason(): string | undefined {
    const active = this.host.active();
    return "reason" in active ? active.reason : undefined;
  }

  // --- Formatting ---

  /** Formats the document in front (Format Document). */
  async formatActive(toolId?: string): Promise<FormatOutcome> {
    const active = this.host.active();
    if (!("target" in active)) {
      this.events.emit("appNotice", { message: active.reason });
      return { kind: "skipped", message: active.reason };
    }
    return this.formatDocument(active.target.id, { toolId, trigger: "command" });
  }

  /**
   * Formats one document. `trigger: "save"` is quieter: no formatter is not worth a message on every save, and a
   * failure is reported without stopping the save (the caller saves either way).
   */
  async formatDocument(
    id: string,
    options: { toolId?: string; trigger: "command" | "save" },
  ): Promise<FormatOutcome> {
    const target = this.host.target(id);
    if (target === null) {
      return { kind: "skipped", message: "That document can't be formatted." };
    }
    if (this.running.has(id)) return { kind: "skipped", message: "Formatting is already running." };
    this.running.add(id);
    this.set({ busy: true });
    try {
      const outcome = await this.run(target, options.toolId);
      this.report(outcome, options.trigger, target);
      return outcome;
    } finally {
      this.running.delete(id);
      this.set({ busy: this.running.size > 0 });
    }
  }

  private report(outcome: FormatOutcome, trigger: "command" | "save", target: FormatTarget): void {
    const name = target.path ?? "unsaved file";
    if (outcome.kind === "formatted") {
      this.log(`Formatted ${name} with ${outcome.formatter}.`);
    } else if (outcome.kind === "unchanged") {
      this.log(`${name} is already formatted (${outcome.formatter}).`);
    } else if (outcome.kind === "none") {
      this.log(`${name}: ${outcome.message}`);
      if (trigger === "command") this.events.emit("appNotice", { message: outcome.message });
    } else if (outcome.kind === "failed") {
      this.log(`${name}: ${outcome.message}`);
      const prefix = trigger === "save" ? "Format on Save: " : "";
      const suffix = trigger === "save" ? " The file was saved as it was." : "";
      this.events.emit("appError", { message: `${prefix}${outcome.message}${suffix}` });
    } else if (trigger === "command") {
      this.events.emit("appNotice", { message: outcome.message });
    }
  }

  private async run(target: FormatTarget, toolId: string | undefined): Promise<FormatOutcome> {
    const before = this.host.text(target.id);
    if (before.length > MAX_FORMAT_CHARS) {
      return {
        kind: "skipped",
        message: `This file is too large to format (${(before.length / 1_000_000).toFixed(1)} MB; the limit is ${MAX_FORMAT_CHARS / 1_000_000} MB).`,
      };
    }
    let status: FormatterStatus;
    try {
      status = await this.lookUp(target);
    } catch (error) {
      return {
        kind: "failed",
        message: `Could not look up formatters: ${String(error)}`,
        formatter: null,
      };
    }
    const chosen = this.choose(status, toolId);
    if ("message" in chosen) return { kind: "none", message: chosen.message };
    let formatted: string | null;
    try {
      const extension = chosen.choice.id.startsWith("ext:")
        ? this.host.extensionFormatters?.(target.id).find((f) => f.id === chosen.choice.id)
        : undefined;
      formatted = extension
        ? await extension.run()
        : chosen.choice.id === LSP_FORMATTER_ID
          ? await this.host.lsp(target.id).run()
          : (
              await this.ipc.formatRun({
                path: target.path,
                language: target.language,
                text: before,
                toolId: chosen.choice.id,
                preferred: this.preferredFor(target.language),
                indent: target.indent,
                eol: target.eol,
                timeoutMs: this.timeoutMs(),
                policy: this.policy(),
              })
            ).text;
    } catch (error) {
      return { kind: "failed", message: String(error), formatter: chosen.choice.name };
    }
    if (formatted === null) {
      return {
        kind: "failed",
        message: `${chosen.choice.name} did not return any formatting.`,
        formatter: chosen.choice.name,
      };
    }
    if (this.host.text(target.id) !== before) {
      return {
        kind: "skipped",
        message:
          "The text changed while it was being formatted, so nothing was applied. Try again.",
      };
    }
    if (formatted === before) return { kind: "unchanged", formatter: chosen.choice.name };
    this.host.apply(target.id, formatted);
    return { kind: "formatted", formatter: chosen.choice.name };
  }

  private choose(
    status: FormatterStatus,
    toolId: string | undefined,
  ): { choice: FormatterChoice } | { message: string } {
    if (toolId !== undefined) {
      const chosen = status.choices.find((c) => c.id === toolId);
      if (chosen === undefined) {
        return { message: `${toolId} is not a formatter for ${status.languageName}.` };
      }
      return chosen.available
        ? { choice: chosen }
        : { message: `${chosen.name} can't be used. ${chosen.reason ?? ""}`.trim() };
    }
    if (status.selected !== null) return { choice: status.selected };
    return { message: status.reason ?? `No formatter configured for ${status.languageName}.` };
  }

  /** Format on Save: runs before the file is written; it never throws and never stops the save. */
  async beforeSave(id: string): Promise<void> {
    if (!this.formatOnSaveEnabled()) return;
    const target = this.host.target(id);
    if (target === null || target.path === null) return;
    const outcome = await this.formatDocument(id, { trigger: "save" });
    if (outcome.kind === "skipped" && outcome.message.startsWith("This file is too large")) {
      this.log(`Format on Save skipped for ${target.path}: ${outcome.message}`);
    }
  }

  // --- Choosing a formatter ---

  /** Opens the formatter list: `with` = format now with the one you pick, `configure` = pick the default, `status` = just look. */
  async openDialog(mode: DialogMode): Promise<void> {
    const active = this.host.active();
    if (!("target" in active)) {
      this.events.emit("appNotice", { message: active.reason });
      return;
    }
    try {
      const status = await this.lookUp(active.target);
      this.set({ dialog: { mode, status, remember: mode === "configure" } });
    } catch (error) {
      this.events.emit("appError", { message: `Could not look up formatters: ${String(error)}` });
    }
  }

  closeDialog(): void {
    this.set({ dialog: null });
  }

  setRemember(remember: boolean): void {
    const dialog = this.state.dialog;
    if (dialog !== null) this.set({ dialog: { ...dialog, remember } });
  }

  /** The user picked a formatter in the dialog. */
  async pick(id: string): Promise<void> {
    const dialog = this.state.dialog;
    if (dialog === null || dialog.mode === "status") return;
    const choice = dialog.status.choices.find((c) => c.id === id);
    if (choice === undefined || !choice.available) return;
    const { language, languageName, targetId } = dialog.status;
    this.set({ dialog: null });
    if (dialog.remember) {
      this.defaults = { ...this.defaults, [language]: id };
      await this.saveDefaults();
      if (dialog.mode === "configure") {
        this.events.emit("appNotice", {
          message: `${choice.name} is now the default formatter for ${languageName}.`,
        });
      }
    }
    if (dialog.mode === "with")
      await this.formatDocument(targetId, { toolId: id, trigger: "command" });
    await this.refreshStatus();
  }

  /** Forgets the per-language default (the automatic order applies again). */
  async clearDefault(language: string): Promise<void> {
    this.defaults = Object.fromEntries(
      Object.entries(this.defaults).filter(([key]) => key !== language),
    );
    await this.saveDefaults();
    await this.refreshStatus();
  }
}
