import type { DebugReadiness, DebugRun, DebugStatus, DebugTarget, LaunchConfig } from "./ipc";
import { i18n, t } from "../i18n";
import { translateBackend } from "../i18n/backendText";

/**
 * Pure debugging model: which files can be debugged, the default launch configuration, what
 * the debug view says when it can't start, which controls a run state enables, and parsers for
 * the parts of DAP responses the UI shows (mirrors `openmind_dap::protocol`).
 */

// --- What can be debugged ---

/** The debug target for a file (mirrors `openmind_dap::target::detect`); TypeScript is deliberately none. */
export function debugTargetOf(path: string): DebugTarget | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  switch (name.slice(dot + 1).toLowerCase()) {
    case "py":
    case "pyw":
      return "python";
    case "js":
    case "mjs":
    case "cjs":
      return "node";
    case "php":
    case "phtml":
      return "php";
    default:
      return null;
  }
}

const TARGET_LABEL: Record<DebugTarget, string> = {
  python: "Python",
  node: "Node.js",
  php: "PHP",
};

function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** The configurations offered for a file: "current file" for its target, in the workspace (or the file's folder). */
export function defaultConfigs(path: string, workspace: string | null): LaunchConfig[] {
  const target = debugTargetOf(path);
  if (target === null) return [];
  return [
    {
      name: `${TARGET_LABEL[target]}: Current File`,
      target,
      program: path,
      cwd: workspace ?? parentOf(path),
      args: [],
      stopOnEntry: false,
    },
  ];
}

// --- Whether debugging can start ---

export interface StartAvailability {
  enabled: boolean;
  /** Why not — always present when disabled. */
  reason?: string;
  /** The target of the file, when it has one. */
  target?: DebugTarget;
  /** The Runtime Manager kind to install when the debugger is what's missing. */
  installKind?: string;
}

function readinessFor(status: DebugStatus, target: DebugTarget): DebugReadiness {
  return status[target];
}

export function startAvailability(input: {
  path: string | null;
  status: DebugStatus | null;
  run: DebugRun | null;
}): StartAvailability {
  const { path, status, run } = input;
  if (run !== null && run.state !== "terminated") {
    return { enabled: false, reason: t("debug.reason.running") };
  }
  if (path === null) return { enabled: false, reason: t("debug.reason.openFile") };
  const target = debugTargetOf(path);
  if (target === null) {
    return { enabled: false, reason: t("debug.reason.noDebugger") };
  }
  if (status === null) {
    return { enabled: false, reason: t("debug.reason.checking"), target };
  }
  const readiness = readinessFor(status, target);
  if (!readiness.ready) {
    return {
      enabled: false,
      reason: readiness.problem ? translateBackend(readiness.problem) : t("debug.reason.notInstalled"),
      target,
      ...(readiness.installKind !== null ? { installKind: readiness.installKind } : {}),
    };
  }
  return { enabled: true, target };
}

// --- Which controls a run state enables ---

export type DebugControl = "continue" | "pause" | "stepOver" | "stepInto" | "stepOut";

export interface ControlState {
  enabled: boolean;
  reason?: string;
}

const NOT_PAUSED = "debug.reason.notPaused";

export function controlAvailability(
  control: DebugControl | "stop" | "restart",
  run: DebugRun | null,
): ControlState {
  if (run === null || run.state === "terminated") {
    return { enabled: false, reason: t("debug.reason.noSession") };
  }
  switch (control) {
    case "stop":
    case "restart":
      return { enabled: true };
    case "pause":
      return run.state === "running"
        ? { enabled: true }
        : { enabled: false, reason: t("debug.reason.notRunning") };
    default:
      return run.state === "stopped" ? { enabled: true } : { enabled: false, reason: t(NOT_PAUSED) };
  }
}

/** A short status line: "Paused on breakpoint", "Running", ... */
/** Why the program is paused: the adapter's own words in English; in another UI language our text for the usual reasons. */
function pausedText(run: DebugRun): string {
  const reason = run.stopped?.reason ?? "pause";
  const known = ["breakpoint", "step", "pause", "entry", "exception", "goto", "function breakpoint"];
  if (i18n.language !== "en" && known.includes(reason)) {
    return t("debug.run.pausedOn", { reason: t(`debug.reason.${reason.replace(" ", "")}`) });
  }
  return run.stopped?.description ?? t("debug.run.pausedOn", { reason });
}

export function runSummary(run: DebugRun | null): string {
  if (run === null) return "";
  switch (run.state) {
    case "starting":
      return t("debug.run.starting");
    case "running":
      return t("debug.run.running");
    case "stopped":
      return pausedText(run);
    case "terminated":
      return run.error ? t("debug.run.endedWithError") : t("debug.run.ended");
  }
}

// --- Parsing what the adapter answers ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" ? value : null);

export interface DebugFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  /** The file, when the frame has one on disk (runtime internals have none). */
  path: string | null;
  hint: string | null;
}

export function parseFrames(body: unknown): DebugFrame[] {
  if (!isRecord(body) || !Array.isArray(body.stackFrames)) return [];
  const frames: DebugFrame[] = [];
  for (const raw of body.stackFrames as unknown[]) {
    if (!isRecord(raw)) continue;
    const id = int(raw.id);
    if (id === null) continue;
    const source = isRecord(raw.source) ? raw.source : null;
    const path = source ? str(source.path) : null;
    frames.push({
      id,
      name: str(raw.name) ?? "",
      line: int(raw.line) ?? 0,
      column: int(raw.column) ?? 0,
      path: path !== null && !path.startsWith("<") && !path.includes("://") ? path : null,
      hint: str(raw.presentationHint) ?? (source ? str(source.presentationHint) : null),
    });
  }
  return frames;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export function parseScopes(body: unknown): DebugScope[] {
  if (!isRecord(body) || !Array.isArray(body.scopes)) return [];
  const scopes: DebugScope[] = [];
  for (const raw of body.scopes as unknown[]) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    const reference = int(raw.variablesReference);
    if (name === null || reference === null) continue;
    scopes.push({ name, variablesReference: reference, expensive: raw.expensive === true });
  }
  return scopes;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string | null;
  /** Non-zero when the value has children to expand. */
  variablesReference: number;
  evaluateName: string | null;
}

export function parseVariables(body: unknown): DebugVariable[] {
  if (!isRecord(body) || !Array.isArray(body.variables)) return [];
  const variables: DebugVariable[] = [];
  for (const raw of body.variables as unknown[]) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    if (name === null) continue;
    variables.push({
      name,
      value: str(raw.value) ?? "",
      type: str(raw.type),
      variablesReference: int(raw.variablesReference) ?? 0,
      evaluateName: str(raw.evaluateName),
    });
  }
  return variables;
}

export interface Evaluated {
  result: string;
  type: string | null;
  variablesReference: number;
}

export function parseEvaluate(body: unknown): Evaluated {
  const record = isRecord(body) ? body : {};
  return {
    result: str(record.result) ?? "",
    type: str(record.type),
    variablesReference: int(record.variablesReference) ?? 0,
  };
}

export type ConsoleKind =
  "stdout" | "stderr" | "console" | "important" | "input" | "result" | "error" | "system";

/** An `output` event as a console line, or `null` for the ones that are not for people (telemetry). */
export function consoleLineFromOutput(
  body: Record<string, unknown>,
): { kind: ConsoleKind; text: string } | null {
  const category = str(body.category) ?? "console";
  const text = str(body.output) ?? "";
  if (category === "telemetry" || text === "") return null;
  const kind: ConsoleKind =
    category === "stdout" || category === "stderr" || category === "important"
      ? category
      : "console";
  return { kind, text: text.replace(/\r?\n$/, "") };
}
