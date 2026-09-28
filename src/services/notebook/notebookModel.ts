import { t } from "../../i18n";
/**
 * How the notebook editor shows cell outputs, pure (Milestone 19). Every output is shown as data: text in a
 * `<pre>`, images as PNG/JPEG `data:` addresses (never a remote address), HTML only in a trusted notebook and then
 * sanitized in an empty-`sandbox` frame with scripts off, Markdown through the app's safe renderer. Anything else
 * says it can't be shown.
 */

export type OutputView =
  | { kind: "text"; text: string; stream: "stdout" | "stderr" | "result" }
  | { kind: "image"; src: string; mime: string }
  | { kind: "html"; html: string }
  | { kind: "htmlBlocked" }
  | { kind: "markdown"; text: string }
  | { kind: "error"; title: string; traceback: string }
  | { kind: "unsupported"; mimes: string[] };

/** More than this many lines, or characters, and an output is collapsed until the user expands it. */
export const COLLAPSE_LINES = 200;
export const COLLAPSE_CHARS = 20_000;

const ANSI = new RegExp(
  String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Jupyter stores text as a string or a list of lines. */
export function joined(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").join("");
  return "";
}

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

function image(data: Record<string, unknown>, mime: "image/png" | "image/jpeg"): OutputView | null {
  const raw = joined(data[mime]).replace(/\s+/g, "");
  if (raw === "" || !BASE64.test(raw)) return null;
  return { kind: "image", mime, src: `data:${mime};base64,${raw}` };
}

function rich(data: Record<string, unknown>, trusted: boolean): OutputView {
  const png = image(data, "image/png");
  if (png) return png;
  const jpeg = image(data, "image/jpeg");
  if (jpeg) return jpeg;
  if ("text/html" in data) {
    if (trusted) return { kind: "html", html: joined(data["text/html"]) };
    if (!("text/plain" in data)) return { kind: "htmlBlocked" };
  }
  if ("text/markdown" in data) return { kind: "markdown", text: joined(data["text/markdown"]) };
  if ("text/plain" in data)
    return { kind: "text", stream: "result", text: stripAnsi(joined(data["text/plain"])) };
  return { kind: "unsupported", mimes: Object.keys(data) };
}

/** The view of one nbformat output. */
export function outputView(output: Record<string, unknown>, trusted: boolean): OutputView {
  switch (output.output_type) {
    case "stream":
      return {
        kind: "text",
        stream: output.name === "stderr" ? "stderr" : "stdout",
        text: stripAnsi(joined(output.text)),
      };
    case "error": {
      const name = typeof output.ename === "string" ? output.ename : "Error";
      const value = typeof output.evalue === "string" ? output.evalue : "";
      const traceback = Array.isArray(output.traceback)
        ? output.traceback
            .filter((l): l is string => typeof l === "string")
            .map(stripAnsi)
            .join("\n")
        : "";
      return { kind: "error", title: value === "" ? name : `${name}: ${value}`, traceback };
    }
    case "execute_result":
    case "display_data": {
      const data = output.data;
      return data !== null && typeof data === "object"
        ? rich(data as Record<string, unknown>, trusted)
        : { kind: "unsupported", mimes: [] };
    }
    default:
      return { kind: "unsupported", mimes: [String(output.output_type)] };
  }
}

/** The part of a long text shown while collapsed, and how much is hidden. */
export function collapsed(text: string): { shown: string; hiddenLines: number } | null {
  const lines = text.split("\n");
  if (lines.length <= COLLAPSE_LINES && text.length <= COLLAPSE_CHARS) return null;
  const shown = lines.slice(0, COLLAPSE_LINES).join("\n").slice(0, COLLAPSE_CHARS);
  return { shown, hiddenLines: Math.max(0, lines.length - shown.split("\n").length) };
}

export interface RunInput {
  trusted: boolean;
  kernel: boolean;
  language: string;
  cellKind: "code" | "markdown" | "raw";
  running: boolean;
}

/** The English text of `notebook.kernelMissing` (kept for callers that compare it). */
export const KERNEL_MISSING = "Kernel not configured. Install/configure from Runtime Manager.";

/** Why a cell can't run now, or null. */
export function runBlocker(input: RunInput): string | null {
  if (input.cellKind !== "code") return t("notebook.onlyCode");
  if (input.language.toLowerCase() !== "python") {
    return t("notebook.onlyPython", { language: input.language });
  }
  if (!input.trusted) return t("notebook.trustToRun");
  if (!input.kernel) return t("notebook.kernelMissing");
  if (input.running) return t("notebook.cellRunning");
  return null;
}
