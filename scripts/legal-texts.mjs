// usage: node scripts/legal-texts.mjs [--check]
// Writes licenses/legal/ (git-ignored; tauri.conf.json ships it as `legal/` and uses LICENSE-AGREEMENT.txt as the
// installers' license page) from docs/legal/*.md and LICENSE:
//   LICENSE-AGREEMENT.txt  License Agreement + Privacy Policy + Apache License 2.0, plain text with CRLF (NSIS/WiX)
//   PRIVACY-POLICY.md, TERMS-OF-USE.md, EULA.md, LICENSE.txt
// --check: also fails (exit 1) when the agreement is incomplete.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agreementText, checkAgreement, LEGAL_FILES } from "./legalTexts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const texts = {
  eula: read("docs", "legal", "eula.md"),
  privacy: read("docs", "legal", "privacy-policy.md"),
  terms: read("docs", "legal", "terms-of-use.md"),
  license: read("LICENSE"),
};
texts.agreement = agreementText(texts);

const out = join(root, "licenses", "legal");
mkdirSync(out, { recursive: true });
for (const [name, key] of Object.entries(LEGAL_FILES)) {
  // Plain-text files get Windows line endings: the installers' text boxes show LF-only text as one line.
  const text = name.endsWith(".txt") ? texts[key].replace(/\n/g, "\r\n") : texts[key];
  writeFileSync(join(out, name), text);
}
const problems = checkAgreement(texts.agreement);
if (problems.length > 0) {
  console.error(`licenses/legal/LICENSE-AGREEMENT.txt:\n- ${problems.join("\n- ")}`);
  if (process.argv.includes("--check")) process.exit(1);
}
console.log(`Wrote ${Object.keys(LEGAL_FILES).length} legal files to licenses/legal/.`);
