// Copies Monaco's pre-bundled editor worker into public/ under a fixed name.
//
// Vite 8 (Rolldown) can't bundle a worker that imports from node_modules (see
// CLAUDE.md), but Monaco ships its editor worker already bundled and
// self-contained (`min/vs/assets/editor.worker-<hash>.js`). Serving that file
// as a static asset gives the diff editor a real worker to compute diffs in.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// pnpm links the dependency here; the package's `exports` map hides its package.json from require.resolve.
const assets = join("node_modules", "monaco-editor", "min", "vs", "assets");
const source = readdirSync(assets).find((name) => /^editor\.worker-.*\.js$/.test(name));
if (!source) {
  throw new Error(`No editor.worker-*.js in ${assets}`);
}
const target = join("public", "monaco-workers");
mkdirSync(target, { recursive: true });
copyFileSync(join(assets, source), join(target, "editor.worker.js"));
console.log(`Copied ${source} to ${join(target, "editor.worker.js")}`);
