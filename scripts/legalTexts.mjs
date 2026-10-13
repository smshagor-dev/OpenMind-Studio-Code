// Pure helpers for OpenMind Studio's legal texts (docs/legal/*.md + LICENSE): the plain-text installer agreement and
// the files shipped as `legal/` with every package. scripts/legal-texts.mjs writes them; tests check them.

/** Markdown -> readable plain text for an installer page: headings underlined, emphasis and link syntax removed. */
export function markdownToText(markdown) {
  const out = [];
  // Emphasis may span a line break, so it is removed before the text is split into lines.
  const plain = markdown.replace(/\r\n/g, "\n").replace(/\*\*([^*]+)\*\*/g, "$1");
  for (const raw of plain.split("\n")) {
    let line = raw
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
        text === url ? url : `${text} (${url})`,
      )
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/ {2,}$/, "");
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      const level = heading[1].length;
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(level === 1 ? text.toUpperCase() : text);
      out.push((level <= 2 ? "=" : "-").repeat(text.length));
      continue;
    }
    if (/^\|\s*-+/.test(line)) continue; // table separator row
    if (line.startsWith("|")) {
      line = line
        .replace(/^\|\s*|\s*\|$/g, "")
        .split(/\s*\|\s*/)
        .join(" - ");
    }
    out.push(line);
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/**
 * The agreement both installers show (NSIS license page with an unchecked "I accept" box, the MSI's license dialog):
 * the License Agreement, then the Privacy Policy (for information), then the full Apache License 2.0.
 */
export function agreementText({ eula, privacy, license }) {
  const rule = "-".repeat(78);
  return [
    "OpenMind Studio - License Agreement and Privacy Policy",
    "",
    "Part 1 is the License Agreement you are asked to accept. Part 2, the Privacy Policy, is shown for your",
    "information: accepting the License Agreement does not turn on any optional feature or send any of your content.",
    "Part 3 is the Apache License 2.0, under which OpenMind Studio is licensed.",
    "",
    rule,
    "PART 1",
    rule,
    "",
    markdownToText(eula).trim(),
    "",
    rule,
    "PART 2 (for your information)",
    rule,
    "",
    markdownToText(privacy).trim(),
    "",
    rule,
    "PART 3",
    rule,
    "",
    license.replace(/\r\n/g, "\n").trim(),
    "",
  ].join("\n");
}

/** Problems with the agreement text (empty = fine). */
export function checkAgreement(text) {
  const problems = [];
  if (!text.includes("OPENMIND STUDIO LICENSE AGREEMENT"))
    problems.push("The License Agreement (EULA) is missing.");
  if (!text.includes("OPENMIND STUDIO PRIVACY POLICY"))
    problems.push("The Privacy Policy is missing.");
  if (!/Apache License\s+Version 2\.0, January 2004/.test(text))
    problems.push("The Apache License 2.0 text is missing.");
  if (!text.includes("END OF TERMS AND CONDITIONS"))
    problems.push("The Apache License 2.0 text is incomplete.");
  if (/\*\*|\]\(/.test(text)) problems.push("Markdown syntax was left in the agreement text.");
  return problems;
}

/** The files shipped in every package's `legal/` folder: published name -> source text key. */
export const LEGAL_FILES = {
  "LICENSE-AGREEMENT.txt": "agreement",
  "PRIVACY-POLICY.md": "privacy",
  "TERMS-OF-USE.md": "terms",
  "EULA.md": "eula",
  "LICENSE.txt": "license",
};
