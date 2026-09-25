/**
 * A note for an SVG that carries anything active or external, or null when it is plain drawing. The SVG is only ever
 * shown as an image (`<img>`): the browser then runs none of its scripts and loads none of its external references,
 * so this note is information for the reader, not the protection.
 */
export function describeSvg(source: string): string | null {
  const findings: string[] = [];
  if (/<script[\s>/]/i.test(source)) findings.push("scripts");
  if (/\son[a-z]+\s*=/i.test(source)) findings.push("event handlers");
  if (/<foreignObject[\s>/]/i.test(source)) findings.push("embedded HTML");
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|file:|javascript:)/i.test(source)) {
    findings.push("external references");
  }
  if (/url\(\s*["']?\s*(?:https?:|\/\/|file:)/i.test(source)) findings.push("external references");
  if (findings.length === 0) return null;
  const unique = [...new Set(findings)].join(", ");
  return `This SVG contains ${unique}. It is shown as a plain image: scripts do not run and nothing external is loaded.`;
}
