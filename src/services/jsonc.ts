/**
 * Parses JSON with comments and trailing commas (what VS Code themes and snippets are written in).
 * Throws the `JSON.parse` error when the text is still not JSON after cleaning.
 */
export function parseJsonc(text: string): unknown {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripTrailingCommas(stripComments(clean)));
}

/** Removes `//` and `/* *\/` comments outside of strings. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
    } else if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i += 1;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i += 1;
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Removes a comma that is followed only by whitespace and a closing bracket, outside of strings. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        i += 1;
        out += text.charAt(i);
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j += 1;
      if (text.charAt(j) !== "}" && text.charAt(j) !== "]") out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}
