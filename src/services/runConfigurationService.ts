import type { IpcClient } from "./ipc";

export type RunTarget = "output" | "terminal";

export interface RunConfiguration {
  /** The command template, e.g. `python "${file}"`. */
  command: string;
  target: RunTarget;
  /** `false` while it is still the built-in default. */
  custom: boolean;
}

/** The built-in command for each file type Run Code supports (`${file}` stays one argument even with spaces in the path). */
const DEFAULT_COMMANDS: Readonly<Record<string, string>> = {
  ".py": 'python "${file}"',
  ".js": 'node "${file}"',
  ".mjs": 'node "${file}"',
  ".cjs": 'node "${file}"',
  ".php": 'php "${file}"',
  ".ts": 'tsx "${file}"',
};

const SETTINGS_KEY = "run.configurations";

interface StoredOverride {
  command: string;
  target: RunTarget;
}

/** `null` when the command is usable, otherwise what is wrong with it. */
export function validateCommand(command: string): string | null {
  const text = command.trim();
  if (text === "") return "Enter a command.";
  if (/[\r\n]/.test(text)) return "A command must be on a single line.";
  const quotes = (text.match(/"/g) ?? []).length;
  const apostrophes = (text.match(/'/g) ?? []).length;
  if (quotes % 2 !== 0 || apostrophes % 2 !== 0) return "A quote is never closed.";
  const program = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
  const name = program?.[1] ?? program?.[2] ?? program?.[3] ?? "";
  if (name === "" || /[\\/:]/.test(name)) {
    return "Start with a program name such as python or node, not a path.";
  }
  if (!text.includes("${file}")) return "Include ${file} so the command runs the active file.";
  return null;
}

/**
 * How each file type is run: its command template and where its output
 * goes (the Output panel or a terminal). Defaults are built in; a change is
 * stored per extension in `editor_settings`, so nothing is stored for a type
 * that still uses its default. The command is only ever a template that
 * Rust splits into an argument list — never text handed to a shell.
 */
export class RunConfigurationService {
  private overrides: Readonly<Record<string, StoredOverride>> = {};
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    if (saved !== null) {
      this.overrides = parse(saved);
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether Run Code knows how to run this extension (".py"). */
  supports(extension: string | null): boolean {
    return extension !== null && extension.toLowerCase() in DEFAULT_COMMANDS;
  }

  defaultCommand(extension: string): string | null {
    return DEFAULT_COMMANDS[extension.toLowerCase()] ?? null;
  }

  get(extension: string | null): RunConfiguration | null {
    if (extension === null || !this.supports(extension)) return null;
    const key = extension.toLowerCase();
    const override = this.overrides[key];
    return override
      ? { command: override.command, target: override.target, custom: true }
      : { command: DEFAULT_COMMANDS[key] ?? "", target: "output", custom: false };
  }

  /** The template to hand to Rust, or `null` to use the built-in default. */
  templateFor(extension: string | null): string | null {
    const configuration = this.get(extension);
    return configuration?.custom === true ? configuration.command : null;
  }

  targetFor(extension: string | null): RunTarget {
    return this.get(extension)?.target ?? "output";
  }

  /** Saves a configuration; resolves to the validation error, or `null` if it was saved. */
  async set(extension: string, command: string, target: RunTarget): Promise<string | null> {
    if (!this.supports(extension)) return `Run Code doesn't support ${extension} files.`;
    const problem = validateCommand(command);
    if (problem !== null) return problem;
    const key = extension.toLowerCase();
    if (command.trim() === DEFAULT_COMMANDS[key] && target === "output") {
      await this.reset(extension);
      return null;
    }
    this.overrides = { ...this.overrides, [key]: { command: command.trim(), target } };
    await this.persist();
    return null;
  }

  async reset(extension: string): Promise<void> {
    const key = extension.toLowerCase();
    this.overrides = Object.fromEntries(
      Object.entries(this.overrides).filter(([name]) => name !== key),
    );
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.notify();
    await this.ipc.settingsSet(SETTINGS_KEY, JSON.stringify(this.overrides)).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function parse(raw: string): Record<string, StoredOverride> {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, StoredOverride> = {};
    for (const [extension, entry] of Object.entries(value)) {
      if (!(extension in DEFAULT_COMMANDS) || typeof entry !== "object" || entry === null) continue;
      const { command, target } = entry as Record<string, unknown>;
      if (
        typeof command === "string" &&
        validateCommand(command) === null &&
        (target === "output" || target === "terminal")
      ) {
        result[extension] = { command, target };
      }
    }
    return result;
  } catch {
    return {};
  }
}
