import type { IpcClient, KeybindingEntry } from "./ipc";
import type { Keybinding, KeybindingService } from "./keybindings";
import {
  type CommandInfo,
  conflictingKeys,
  conflictsFor,
  effectiveBindings,
  entriesForAssign,
  entriesForRemove,
  entriesForReset,
  matchesQuery,
} from "./keybindingsModel";

export interface KeybindingRow {
  command: string;
  title: string;
  category: string;
  /** The keys in force, most important first (none: the command has no shortcut). */
  keys: string[];
  source: "default" | "user" | "extension" | "none";
  /** The extension that contributed the shortcut in force, if it came from one. */
  extension?: string;
  /** True when the user changed this command's shortcuts (so "Reset" has something to do). */
  customized: boolean;
  /** Titles of the other commands that share one of the keys. */
  conflicts: string[];
  change: { enabled: boolean; reason?: string };
}

export interface KeybindingsState {
  entries: KeybindingEntry[];
  /** Why the keybindings file can't be used (a syntax error); the defaults apply meanwhile. */
  error: string | null;
}

export type AssignCheck =
  | { ok: true; conflicts: [] }
  | {
      ok: false;
      /** The shortcut can't be used at all (built-in editor binding, or invalid). */
      blocked: boolean;
      reason: string;
      conflicts: { command: string; title: string }[];
    };

export type ChangeResult = { ok: true } | { ok: false; error: string };

const NOT_CHANGEABLE = "This shortcut is built into the editor and can't be changed.";

export interface KeybindingsDeps {
  /** Every command a shortcut can go on, with its title. */
  catalog: () => CommandInfo[];
  /** Editor-owned commands whose Monaco shortcut can be switched off and re-bound. */
  remappable: (command: string) => boolean;
  /** Tells Monaco which of its built-in shortcuts are no longer wanted. */
  syncEditor: (removedDefaults: { command: string; key: string }[]) => void;
  defaults: readonly Keybinding[];
  /** Shortcuts contributed by extensions (after the built-in ones; a user's shortcut wins over both). */
  extra?: () => readonly Keybinding[];
}

/**
 * The user's keyboard shortcuts: the defaults with the entries of \`settings/keybindings.json\`
 * applied. Editing here (assign, remove, reset) writes that file, so the Keyboard Shortcuts page and
 * the JSON file always agree; a change applies at once to the shortcut listener, the menus'
 * shortcut labels and Monaco's own bindings. UI-free.
 */
export class KeybindingsManager {
  private state: KeybindingsState = { entries: [], error: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly keybindings: KeybindingService,
    private readonly deps: KeybindingsDeps,
  ) {}

  getState(): KeybindingsState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  /** Reads the file again (after it was edited as JSON) and applies it. */
  async reload(): Promise<void> {
    try {
      const file = await this.ipc.keybindingsLoad();
      this.state = { entries: file.entries, error: file.error };
    } catch (error) {
      this.state = { entries: [], error: error instanceof Error ? error.message : String(error) };
    }
    this.apply();
  }

  /** The built-in shortcuts followed by the ones extensions contribute. */
  private allDefaults(): readonly Keybinding[] {
    return [...this.deps.defaults, ...(this.deps.extra?.() ?? [])];
  }

  /** The extensions' shortcuts changed: applies them. */
  refresh(): void {
    this.apply();
  }

  private apply(): void {
    const effective = effectiveBindings(this.allDefaults(), this.state.entries);
    this.keybindings.setBindings(effective);
    const removed = this.allDefaults().filter(
      (binding) =>
        binding.owner === "editor" &&
        this.deps.remappable(binding.command) &&
        !effective.some((b) => b.command === binding.command && b.key === binding.key),
    );
    this.deps.syncEditor(
      removed.map((binding) => ({ command: binding.command, key: binding.key })),
    );
    for (const listener of this.listeners) listener();
  }

  private titleOf(command: string): string {
    return this.deps.catalog().find((info) => info.id === command)?.title ?? command;
  }

  /** Whether the command's shortcut can be changed, and why not. */
  canChange(command: string): { enabled: boolean; reason?: string } {
    const builtIn = this.allDefaults().some(
      (binding) => binding.command === command && binding.owner === "editor",
    );
    if (builtIn && !this.deps.remappable(command))
      return { enabled: false, reason: NOT_CHANGEABLE };
    if (this.state.error !== null) {
      return { enabled: false, reason: "Fix the syntax error in keybindings.json first." };
    }
    return { enabled: true };
  }

  /** The list the page shows, filtered by \`query\` (title, id, category or key). */
  rows(query = ""): KeybindingRow[] {
    const effective = effectiveBindings(this.allDefaults(), this.state.entries);
    const clashes = conflictingKeys(effective);
    const rows = this.deps.catalog().map((info): KeybindingRow => {
      const own = effective.filter((binding) => binding.command === info.id);
      const customized = this.state.entries.some(
        (entry) => entry.command.replace(/^-/, "") === info.id,
      );
      const conflicts = own.flatMap((binding) =>
        (clashes.get(binding.key) ?? []).filter((other) => other !== info.id),
      );
      return {
        command: info.id,
        title: info.title,
        category: info.category,
        keys: own.map((binding) => binding.key),
        source: own[0]?.source ?? "none",
        extension: own[0]?.extension,
        customized,
        conflicts: [...new Set(conflicts)].map((command) => this.titleOf(command)),
        change: this.canChange(info.id),
      };
    });
    return rows
      .filter((row) =>
        matchesQuery(query, row.title, row.command, row.category, row.keys.join(" ")),
      )
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  /** Whether \`key\` can go on \`command\`, and which commands already use it. */
  checkAssign(command: string, key: string): AssignCheck {
    const allowed = this.canChange(command);
    if (!allowed.enabled) {
      return { ok: false, blocked: true, reason: allowed.reason ?? NOT_CHANGEABLE, conflicts: [] };
    }
    const effective = effectiveBindings(this.allDefaults(), this.state.entries);
    const others = conflictsFor(effective, key, command);
    if (others.length === 0) return { ok: true, conflicts: [] };
    const unfreeable = others.find(
      (other) => other.owner === "editor" && !this.deps.remappable(other.command),
    );
    const conflicts = others.map((other) => ({
      command: other.command,
      title: this.titleOf(other.command),
    }));
    if (unfreeable !== undefined) {
      return {
        ok: false,
        blocked: true,
        reason: `${key} is used by "${this.titleOf(unfreeable.command)}", a built-in editor shortcut that can't be changed.`,
        conflicts,
      };
    }
    return {
      ok: false,
      blocked: false,
      reason: `${key} is already used by ${conflicts.map((c) => `"${c.title}"`).join(", ")}.`,
      conflicts,
    };
  }

  /** Makes \`key\` the shortcut of \`command\`; with \`replace\` the commands that had it lose it. */
  async assign(command: string, key: string, replace = false): Promise<ChangeResult> {
    const check = this.checkAssign(command, key);
    if (!check.ok && (check.blocked || !replace)) return { ok: false, error: check.reason };
    const replaced = check.ok ? [] : check.conflicts.map((conflict) => conflict.command);
    return this.save(
      entriesForAssign(this.state.entries, this.allDefaults(), command, key, replaced),
    );
  }

  async remove(command: string): Promise<ChangeResult> {
    const allowed = this.canChange(command);
    if (!allowed.enabled) return { ok: false, error: allowed.reason ?? NOT_CHANGEABLE };
    return this.save(entriesForRemove(this.state.entries, this.allDefaults(), command));
  }

  async reset(command: string): Promise<ChangeResult> {
    return this.save(entriesForReset(this.state.entries, command));
  }

  private async save(entries: KeybindingEntry[]): Promise<ChangeResult> {
    try {
      const saved = await this.ipc.keybindingsSave(entries);
      this.state = { entries: saved, error: null };
      this.apply();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The path of \`keybindings.json\` (created empty if missing), to open in the editor. */
  jsonFile(): Promise<string> {
    return this.ipc.keybindingsFile();
  }

  /** After any file was saved: if it was the keybindings file, read it again. Returns whether it was. */
  async handleSaved(path: string): Promise<boolean> {
    const kind = await this.ipc.preferencesScopeOf(path).catch(() => null);
    if (kind !== "keybindings") return false;
    await this.reload();
    return true;
  }
}
