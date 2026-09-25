import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { dirname, resolve } from "node:path";

/**
 * Loads one of the extension host's CommonJS files (`crates/extensions/host/*.js`) inside the test, the way the
 * host does: the project's package.json says "type": "module", which would make Node treat them as ES modules,
 * so they are evaluated here with their own `module`/`require`.
 */
export function loadHostModule(file: string, cache = new Map<string, unknown>()): unknown {
  const full = resolve(file);
  if (cache.has(full)) return cache.get(full);
  const nodeRequire = createRequire(import.meta.url);
  const module = { exports: {} as unknown };
  cache.set(full, module.exports);
  const localRequire = (request: string): unknown =>
    request.startsWith(".")
      ? loadHostModule(resolve(dirname(full), request), cache)
      : nodeRequire(request);
  const source = readFileSync(full, "utf8");
  const wrapper = runInThisContext(
    `(function (module, exports, require, process) {${source}
})`,
    { filename: full },
  ) as (...args: unknown[]) => void;
  wrapper(module, module.exports, localRequire, process);
  cache.set(full, module.exports);
  return module.exports;
}

export const HOST_DIR = resolve(__dirname, "../../crates/extensions/host");
