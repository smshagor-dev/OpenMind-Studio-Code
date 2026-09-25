/** The text with every control character and space removed (`java<newline>script:` is still a script link). */
function withoutControls(value: string): string {
  let out = "";
  for (const char of value) if (char.charCodeAt(0) > 32) out += char;
  return out;
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * What an HTML file contains that a preview never runs: reported to the reader so a blocked script is never silent.
 * (The protection itself is the sanitizer plus a sandboxed frame with scripts off; this only counts.)
 */
export function describeHtmlSource(source: string): string[] {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const notices: string[] = [];
  const scripts = doc.querySelectorAll("script").length;
  if (scripts > 0) {
    notices.push(`${plural(scripts, "script", "scripts")} blocked (previews never run scripts).`);
  }
  let handlers = 0;
  let scriptLinks = 0;
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) handlers += 1;
      else if (/^(?:java|vb)script:/i.test(withoutControls(attribute.value))) scriptLinks += 1;
    }
  }
  if (handlers > 0) {
    notices.push(`${plural(handlers, "inline event handler", "inline event handlers")} blocked.`);
  }
  if (scriptLinks > 0) {
    notices.push(`${plural(scriptLinks, "script link", "script links")} (javascript:) blocked.`);
  }
  if (doc.querySelectorAll("form").length > 0)
    notices.push("Forms are shown but can't be submitted.");
  return notices;
}
