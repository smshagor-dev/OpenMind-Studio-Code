// usage: node scripts/verify-signatures.mjs [--mode signed|test-signed|external] [--allow-no-timestamp] <file>...
//
// Checks with Windows itself (Get-AuthenticodeSignature) that every file carries a valid Authenticode signature: a
// trusted chain, the file unchanged since it was signed and — for a release — an RFC 3161 timestamp, so the signature
// stays valid after the certificate expires. Used by the release workflow after an outside signing service (SignPath)
// returns the files, and by hand on any artifact. Exit code 0 when all pass, 1 otherwise, 2 for a usage error.
//
// A valid signature does not make Windows SmartScreen trust a new file at once: SmartScreen also builds reputation for
// the publisher and the file over time (docs/release.md).
import { existsSync } from "node:fs";

import { signatureVerdict } from "./releaseTools.mjs";
import { inspectSignature } from "./signtool.mjs";

const args = process.argv.slice(2);
let mode = "signed";
let allowNoTimestamp = false;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--mode") {
    mode = args[(i += 1)] ?? "";
  } else if (args[i] === "--allow-no-timestamp") {
    allowNoTimestamp = true;
  } else {
    files.push(args[i]);
  }
}
if (!["signed", "test-signed", "external"].includes(mode) || files.length === 0) {
  console.error(
    "usage: node scripts/verify-signatures.mjs [--mode signed|test-signed|external] [--allow-no-timestamp] <file>...",
  );
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`${file}: missing`);
    failures += 1;
    continue;
  }
  const info = inspectSignature(file);
  const problem = signatureVerdict(info, mode, { timestampWaived: allowNoTimestamp });
  const by = info.signer ? ` by ${info.signer}` : "";
  const at = info.timestamped ? `, timestamped by ${info.timestamper}` : ", no timestamp";
  if (problem === null) {
    console.log(`OK   ${file}: ${info.status}${by}${at}`);
  } else {
    console.error(`FAIL ${file}: ${problem} (${info.status}${by}${at})`);
    failures += 1;
  }
}
console.log(`${files.length - failures} of ${files.length} signature(s) verified.`);
process.exit(failures === 0 ? 0 : 1);
