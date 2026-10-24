import type { AgentAttachment } from "./agentAttachments";
import type { Entry } from "./agentModel";
export function attachment(value: unknown): value is AgentAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length <= 80 &&
    typeof item.name === "string" &&
    item.name.length <= 300 &&
    (item.text === undefined ||
      typeof item.text === "string") &&
    (item.data === undefined ||
      (typeof item.data === "string" &&
        item.data.length <= 700000 &&
        /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(item.data)))
  );
}
export function entry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length > 128) return false;
  if (e.kind === "user" || e.kind === "notice" || e.kind === "document")
    return typeof e.text === "string" && (e.kind !== "document" || typeof e.name === "string");
  if (e.kind === "assistant") return typeof e.text === "string" && typeof e.reasoning === "string";
  if (e.kind === "asset")
    return (
      typeof e.name === "string" &&
      typeof e.data === "string" &&
      e.data.length <= 700000 &&
      /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(e.data)
    );
  if (e.kind !== "tool") return false;
  return (
    ["read", "edit", "delete", "command", "meta"].includes(String(e.toolKind)) &&
    ["running", "waiting", "ok", "failed", "declined"].includes(String(e.status)) &&
    [e.name, e.title, e.target, e.summary, e.preview].every((v) => typeof v === "string") &&
    (e.diff === null || validDiff(e.diff))
  );
}
function validDiff(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.added === "number" &&
    typeof d.removed === "number" &&
    typeof d.truncated === "boolean" &&
    Array.isArray(d.lines) &&
    d.lines.every((line: unknown) => {
      if (!line || typeof line !== "object") return false;
      const row = line as Record<string, unknown>;
      return (
        ["context", "added", "removed", "gap"].includes(String(row.kind)) &&
        typeof row.text === "string"
      );
    })
  );
}

