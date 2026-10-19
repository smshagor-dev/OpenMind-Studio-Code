/**
 * Tool calls some local models write into their answer as text (`<function=NAME>…</function>`, `<tool_call>{…}</tool_call>`).
 * The backend runs them as calls (crates/agent/src/text_calls.rs); the live stream has already shown the markup, so the
 * transcript hides it. A block still being streamed (opened, not yet closed) is hidden too. Fenced code is left as it is.
 */
const BLOCKS: readonly (readonly [string, string])[] = [
  ["<function=", "</function>"],
  ["<tool_call>", "</tool_call>"],
];

function stripProse(text: string, last: boolean): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    let at = -1;
    let close = "";
    for (const [open, end] of BLOCKS) {
      const found = text.indexOf(open, cursor);
      if (found >= 0 && (at < 0 || found < at)) {
        at = found;
        close = end;
      }
    }
    if (at < 0) return out + text.slice(cursor).replace(/<\/tool_call>/g, "");
    out += text.slice(cursor, at);
    const end = text.indexOf(close, at);
    // An unclosed block at the very end is still arriving; one in the middle is not a call, so it stays.
    if (end < 0) return last ? out : out + text.slice(at);
    cursor = end + close.length;
  }
}

export function withoutToolMarkup(text: string): string {
  if (!text.includes("<function=") && !text.includes("<tool_call>") && !text.includes("</tool_call>")) return text;
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$)/m);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : stripProse(part, index === parts.length - 1)))
    .join("")
    .replace(/\n{3,}/g, "\n\n");
}
