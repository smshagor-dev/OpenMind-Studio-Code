import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { expect, it } from "vitest";

const root = process.cwd();
const native = readFileSync(join(root, "src-tauri/src/commands/extension_host.rs"), "utf8");
function table(name: string) {
  const match = new RegExp(`const ${name}: \\[&str; (\\d+)\\] = \\[([\\s\\S]*?)\\];`).exec(native);
  if (!match) throw new Error(`Missing native table ${name}`);
  const methods = [...(match[2] ?? "").matchAll(/"(host\/[A-Za-z]+)"/g)].map(m => m[1]);
  expect(methods).toHaveLength(Number(match[1])); expect(new Set(methods).size).toBe(methods.length);
  return new Set(methods);
}
const requests = table("ALLOWED_REQUESTS"), notifications = table("ALLOWED_NOTIFICATIONS");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testUtils" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}
it("allows every production frontend host channel and defines its Node handler", () => {
  const handlerSource = readFileSync(join(root, "crates/extensions/host/host.js"), "utf8");
  const handlers = new Set([...handlerSource.matchAll(/['"](host\/[A-Za-z]+)['"]\s*:/g)].map(m => m[1]));
  const missing: string[] = [], wrongTransport: string[] = [];
  for (const path of sources(join(root, "src"))) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^host\/[A-Za-z]+$/.test(node.text)) {
        const method = node.text, location = `${relative(root, path)}: ${method}`;
        if ((!requests.has(method) && !notifications.has(method)) || !handlers.has(method)) missing.push(location);
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const method = node.arguments[0].text;
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
        if (method.startsWith("host/")) {
          if (["extHostRequest", "hostRequest", "requestHost", "request"].includes(name) && !requests.has(method)) wrongTransport.push(`${name}: ${method}`);
          if (["extHostNotify", "notifyHost", "notify", "tell"].includes(name) && !notifications.has(method)) wrongTransport.push(`${name}: ${method}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(missing).toEqual([]); expect(wrongTransport).toEqual([]);
});
it("keeps privileged host initialization and descriptor mutation outside the window channel", () => {
  for (const method of ["host/init", "host/register", "host/unregister", "host/shutdown"]) {
    expect(requests.has(method)).toBe(false); expect(notifications.has(method)).toBe(false);
  }
});
