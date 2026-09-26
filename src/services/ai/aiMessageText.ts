/** A message split into prose and fenced code blocks (rendered as React elements, never as HTML). */
export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "code"; language: string; code: string; closed: boolean };

const FENCE = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

export function splitSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  let language = "";
  const flushText = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined !== "") segments.push({ type: "text", text: joined });
    text = [];
  };
  for (const line of content.split("\n")) {
    const match = FENCE.exec(line.trim());
    if (code === null) {
      if (match?.[1] !== undefined) {
        flushText();
        fence = match[1];
        language = match[2] ?? "";
        code = [];
      } else {
        text.push(line);
      }
    } else if (
      match?.[1] !== undefined &&
      match[1][0] === fence[0] &&
      match[1].length >= fence.length &&
      match[2] === ""
    ) {
      segments.push({ type: "code", language, code: code.join("\n"), closed: true });
      code = null;
    } else {
      code.push(line);
    }
  }
  if (code !== null) {
    segments.push({ type: "code", language, code: code.join("\n"), closed: false });
  } else {
    flushText();
  }
  return segments;
}
