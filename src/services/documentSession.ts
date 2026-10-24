/** Recovery data belongs to the local editor layout, never to a provider write. */
export interface SavedBuffer {
  uri: string;
  kind: "virtual" | "untitled";
  text: string;
  savedText: string;
  language: string;
  readonly: boolean;
  associatedPath?: string;
  name?: string;
  number?: number;
}
export const MAX_LAYOUT_LENGTH = 64 * 1024 * 1024;

export function parseSavedBuffer(value: unknown): SavedBuffer | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.uri !== "string" || r.uri.length > 16384 || r.uri.includes("\0")
    || (r.kind !== "virtual" && r.kind !== "untitled")
    || typeof r.text !== "string" || r.text.length > 32 * 1024 * 1024
    || typeof r.savedText !== "string" || r.savedText.length > 32 * 1024 * 1024
    || typeof r.language !== "string" || !r.language || r.language.length > 256
    || typeof r.readonly !== "boolean") return null;
  try {
    const uri = new URL(r.uri);
    if (r.kind === "untitled" ? !r.uri.startsWith("untitled:") || uri.protocol !== "untitled:" : !/^[a-z][a-z0-9+.-]*:\/\//.test(r.uri) || /^(file|untitled):/.test(r.uri)) return null;
    decodeURIComponent(uri.pathname);
  } catch { return null; }
  if (r.associatedPath !== undefined && (r.kind !== "untitled" || typeof r.associatedPath !== "string"
    || r.associatedPath.includes("\0") || !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(r.associatedPath))) return null;
  if (r.name !== undefined && (typeof r.name !== "string" || r.name.length > 16384)) return null;
  if (r.number !== undefined && (typeof r.number !== "number" || !Number.isSafeInteger(r.number) || r.number < 1)) return null;
  if (new TextEncoder().encode(r.text).length > 32 * 1024 * 1024 || new TextEncoder().encode(r.savedText).length > 32 * 1024 * 1024) return null;
  return { uri: r.uri, kind: r.kind, text: r.text, savedText: r.savedText, language: r.language, readonly: r.kind === "virtual" && r.readonly,
    ...(typeof r.associatedPath === "string" ? { associatedPath: r.associatedPath } : {}),
    ...(typeof r.name === "string" ? { name: r.name } : {}), ...(typeof r.number === "number" ? { number: r.number } : {}) };
}
