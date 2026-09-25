// Copies pdf.js's worker and its data folders (character maps, standard fonts, wasm decoders, ICC profiles) into
// public/pdf so the PDF preview loads everything from the app itself and never from the network.
//
// The worker can't be bundled by Vite 8 (Rolldown) for the reason described in CLAUDE.md (a worker importing from
// node_modules), but pdf.js ships it already built, so it is served as a plain static file, like Monaco's worker.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = join("node_modules", "pdfjs-dist");
const target = join("public", "pdf");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(source, "build", "pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(source, folder), join(target, folder), { recursive: true });
}
console.log(`Copied pdf.js worker and data to ${target}`);
