import type { Keybinding, KeybindingOwner } from "./keybindings";
import type { KeybindingEntry } from "./ipc";
import type { MenuEntry, TopLevelMenu } from "./menus";

/** A keybinding as the app uses it, and where it comes from. */
export interface EffectiveBinding extends Keybinding {
  source: "default" | "user" | "extension";
}

export interface CommandInfo {
  id: string;
  title: string;
  category: string;
}

/**
 * Pairs of commands that are meant to share a key because only one of them can be active at a
 * time (F11 is Step Into while a program is paused and Full Screen otherwise), so sharing is not a
 * conflict. Keys are the two command ids in either order.
 */
const CONTEXTUAL_PAIRS: [string, string][] = [
  ["view.toggleFullScreen", "debug.stepInto"],
  ["file.openFolder", "go.toSymbolInEditor"],
];

function isContextualPair(a: string, b: string): boolean {
  return CONTEXTUAL_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/**
 * The bindings in force: the user's entries (a `-command` entry removes that command's binding for
 * that key) applied to the defaults. User bindings come first, so they win when a key is shared.
 */
export function effectiveBindings(
  defaults: readonly Keybinding[],
  user: readonly KeybindingEntry[],
): EffectiveBinding[] {
  let base: EffectiveBinding[] = defaults.map((binding) => ({
    ...binding,
    source: binding.extension === undefined ? "default" : "extension",
  }));
  const added: EffectiveBinding[] = [];
  for (const entry of user) {
    if (entry.command.startsWith("-")) {
      const command = entry.command.slice(1);
      base = base.filter((binding) => !(binding.command === command && binding.key === entry.key));
      const index = added.findIndex((b) => b.command === command && b.key === entry.key);
      if (index >= 0) added.splice(index, 1);
    } else if (!added.some((b) => b.command === entry.command && b.key === entry.key)) {
      added.push({ key: entry.key, command: entry.command, owner: "app", source: "user" });
    }
  }
  return [...added, ...base];
}

export interface KeyConflict {
  /** The other command that has the key. */
  command: string;
  /** The owner of that binding: an `editor` binding is Monaco's own and can only be freed if the command is remappable. */
  owner: KeybindingOwner;
}

/** The commands (other than `command`) that already use `key`, ignoring the contextual pairs. */
export function conflictsFor(
  bindings: readonly EffectiveBinding[],
  key: string,
  command: string,
): KeyConflict[] {
  const seen = new Set<string>();
  const found: KeyConflict[] = [];
  for (const binding of bindings) {
    if (binding.key !== key || binding.command === command) continue;
    if (isContextualPair(binding.command, command) || seen.has(binding.command)) continue;
    seen.add(binding.command);
    found.push({ command: binding.command, owner: binding.owner });
  }
  return found;
}

/** Every key used by more than one command (not counting the contextual pairs): what the list flags. */
export function conflictingKeys(bindings: readonly EffectiveBinding[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const binding of bindings) {
    const list = byKey.get(binding.key) ?? [];
    if (!list.includes(binding.command)) list.push(binding.command);
    byKey.set(binding.key, list);
  }
  const conflicts = new Map<string, string[]>();
  for (const [key, commands] of byKey) {
    const clashing = commands.filter((command) =>
      commands.some((other) => other !== command && !isContextualPair(command, other)),
    );
    if (clashing.length > 1) conflicts.set(key, clashing);
  }
  return conflicts;
}

/**
 * What to store to make `key` the only shortcut of `command`: the command's defaults are removed
 * (`-command` entries) and the key is added. Entries of other commands are left alone.
 */
export function entriesForAssign(
  user: readonly KeybindingEntry[],
  defaults: readonly Keybinding[],
  command: string,
  key: string,
  /** Commands that lose `key` because the user chose to replace them. */
  replaced: readonly string[] = [],
): KeybindingEntry[] {
  const kept = user.filter((entry) => entry.command.replace(/^-/, "") !== command);
  const next: KeybindingEntry[] = [...kept];
  for (const binding of defaults.filter((b) => b.command === command)) {
    if (binding.key !== key) next.push({ key: binding.key, command: `-${command}` });
  }
  for (const other of replaced) {
    const holders = [...defaults.filter((b) => b.command === other && b.key === key)];
    if (holders.length > 0 && !next.some((e) => e.command === `-${other}` && e.key === key)) {
      next.push({ key, command: `-${other}` });
    }
    // A user binding of the other command on this key is removed instead of negated.
    const index = next.findIndex((e) => e.command === other && e.key === key);
    if (index >= 0) next.splice(index, 1);
  }
  next.push({ key, command });
  return next;
}

/** What to store to leave `command` without any shortcut. */
export function entriesForRemove(
  user: readonly KeybindingEntry[],
  defaults: readonly Keybinding[],
  command: string,
): KeybindingEntry[] {
  const next = user.filter((entry) => entry.command.replace(/^-/, "") !== command);
  for (const binding of defaults.filter((b) => b.command === command)) {
    next.push({ key: binding.key, command: `-${command}` });
  }
  return next;
}

/** What to store to give `command` its default shortcuts back. */
export function entriesForReset(
  user: readonly KeybindingEntry[],
  command: string,
): KeybindingEntry[] {
  return user.filter((entry) => entry.command.replace(/^-/, "") !== command);
}

function walk(entries: MenuEntry[], category: string, into: Map<string, CommandInfo>): void {
  for (const entry of entries) {
    if (entry.kind === "submenu") walk(entry.items, category, into);
    else if (entry.kind === "command" && !into.has(entry.command)) {
      into.set(entry.command, {
        id: entry.command,
        title: (entry.toggledLabel ?? entry.label).replace(/\.\.\.$/, "").replace(/…$/, ""),
        category,
      });
    }
  }
}

/** Titles for shortcuts that have no menu entry. */
const EXTRA_TITLES: Record<string, [string, string]> = {
  "debug.toggleBreakpoint": ["Toggle Breakpoint", "Run"],
  "view.showProblems": ["Problems", "View"],
  "view.showOutput": ["Output", "View"],
  "view.showRun": ["Run and Debug", "View"],
  "view.showSourceControl": ["Source Control", "View"],
  "search.findInFiles": ["Search: Find in Files", "Edit"],
  "run.code": ["Run Code", "Run"],
  "run.stop": ["Stop Running Code", "Run"],
  "debug.start": ["Start Debugging", "Run"],
  "debug.stop": ["Stop Debugging", "Run"],
  "debug.stepOver": ["Step Over", "Run"],
  "debug.stepInto": ["Step Into", "Run"],
  "debug.stepOut": ["Step Out", "Run"],
  "terminal.toggle": ["Toggle Terminal", "Terminal"],
  "file.new": ["New Text File", "File"],
  "file.closeActiveTab": ["Close Editor", "File"],
  "editor.closeAll": ["Close All Editors", "File"],
  "edit.formatDocument": ["Format Document", "Edit"],
  "edit.formatDocumentWith": ["Format Document With...", "Edit"],
  "edit.formatSelection": ["Format Selection", "Edit"],
  "edit.configureDefaultFormatter": ["Configure Default Formatter", "Edit"],
  "format.showStatus": ["Formatter Status", "Edit"],
  "format.toggleOnSave": ["Toggle Format on Save", "Edit"],
  "edit.renameSymbol": ["Rename Symbol", "Edit"],
  "go.toDefinition": ["Go to Definition", "Go"],
  "go.toReferences": ["Find All References", "Go"],
  "preferences.openSettings": ["Open Settings", "Preferences"],
  "preferences.openKeybindings": ["Open Keyboard Shortcuts", "Preferences"],
};

function humanize(id: string): string {
  const last = id.split(".").pop() ?? id;
  const words = last.replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Every command a shortcut can be assigned to: the menu commands, plus everything that has a default
 * shortcut, plus the ones the keyboard-shortcut list must always offer.
 */
export function commandCatalog(
  menus: readonly TopLevelMenu[],
  bindings: readonly Keybinding[],
  registered: (id: string) => boolean,
): CommandInfo[] {
  const found = new Map<string, CommandInfo>();
  for (const menu of menus) walk(menu.items, menu.label, found);
  for (const [id, [title, category]] of Object.entries(EXTRA_TITLES)) {
    const known = found.get(id);
    // A curated title beats a menu label that only says "Stop" or "Start Debugging (F5)".
    found.set(id, { id, title, category: known?.category ?? category });
  }
  for (const binding of bindings) {
    if (!found.has(binding.command)) {
      found.set(binding.command, {
        id: binding.command,
        title: humanize(binding.command),
        category: "Other",
      });
    }
  }
  return [...found.values()].filter(
    (info) => registered(info.id) || bindings.some((b) => b.command === info.id),
  );
}

/** True when `text` (a command's title, id, category or key) matches every word of `query`. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
