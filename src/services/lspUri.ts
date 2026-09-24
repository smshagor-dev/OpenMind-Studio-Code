/** `file://` URIs, as language servers write them. Mirrors `openmind_lsp::uri`. */

const UNRESERVED = /[A-Za-z0-9\-._~/]/;

/** `C:\My Site\a b.ts` → `file:///C:/My%20Site/a%20b.ts`. */
export function pathToUri(path: string): string {
  const unified = path.replace(/\\/g, "/");
  const hasDrive = /^[A-Za-z]:/.test(unified);
  let out = unified.startsWith("/") ? "file://" : "file:///";
  const encoder = new TextEncoder();
  let index = 0;
  for (const character of unified) {
    if (UNRESERVED.test(character) || (hasDrive && index === 1 && character === ":")) {
      out += character;
    } else {
      for (const byte of encoder.encode(character)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
    index += character.length;
  }
  return out;
}

/** `file:///c%3A/My%20Site/a.ts` → `c:/My Site/a.ts`; `null` for anything that isn't a plain `file:///` URI. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const rest = uri.slice("file://".length);
  if (!rest.startsWith("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}
