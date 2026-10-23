import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  extensionDialogOptions,
  nativeExtensionDialogs,
} from "./extensionDialogs";
import { HostBridge, type BridgeDeps } from "./extensionHostBridge";

const native = vi.hoisted(() => ({
  open: vi.fn<(options: unknown) => Promise<string | string[] | null>>(),
  save: vi.fn<(options: unknown) => Promise<string | null>>(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => native);
const require = createRequire(import.meta.url);
const { fixture } =
  require("../../crates/extensions/tests/node/rpc-fixture.cjs") as {
    fixture: (
      t: { after(callback: () => Promise<void>): void },
      definitions: Record<string, { code: string; permissions: string[] }>,
      options: {
        handleRequest(method: string, params: unknown): Promise<unknown>;
      },
    ) => Promise<{ request(method: string, params?: unknown): Promise<unknown> }>;
  };
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function integratedDialogs(code: string) {
  const choose = vi
    .fn<() => Promise<"files" | "folders" | null>>()
    .mockResolvedValue("files");
  const bridge = new HostBridge({
    dialogs: nativeExtensionDialogs(choose),
  } as BridgeDeps);
  const host = await fixture(
    { after: (callback) => cleanups.push(callback) },
    { "test.dialogs": { permissions: ["commands"], code } },
    { handleRequest: (method, params) => bridge.handleRequest(method, params) },
  );
  await host.request("host/activate", { id: "test.dialogs" });
  return { host, choose };
}

it("routes real-host open/save dialog requests through the bridge and native adapter with URI results", async () => {
  native.open.mockResolvedValue([
    "/workspace/first file.ts",
    "/workspace/second.ts",
  ]);
  native.save.mockResolvedValue("/workspace/saved file.ts");
  const { host } =
    await integratedDialogs(`const v = require('vscode'); exports.activate = () => {
    v.commands.registerCommand('open', async () => (await v.window.showOpenDialog({ defaultUri: v.Uri.file('/workspace'), title: 'Select source', canSelectMany: true, filters: { TypeScript: ['ts','tsx'] } })).map(uri => ({ scheme: uri.scheme, path: uri.path })));
    v.commands.registerCommand('save', async () => { const uri = await v.window.showSaveDialog({ defaultUri: v.Uri.file('/workspace/default.ts'), filters: { TypeScript: ['ts'] } }); return { scheme: uri.scheme, path: uri.path }; });
  };`);
  expect(
    await host.request("host/executeCommand", { command: "open" }),
  ).toEqual([
    { scheme: "file", path: "/workspace/first file.ts" },
    { scheme: "file", path: "/workspace/second.ts" },
  ]);
  expect(native.open).toHaveBeenCalledWith({
    title: "Select source",
    defaultPath: "/workspace",
    filters: [{ name: "TypeScript", extensions: ["ts", "tsx"] }],
    multiple: true,
    directory: false,
  });
  expect(
    await host.request("host/executeCommand", { command: "save" }),
  ).toEqual({ scheme: "file", path: "/workspace/saved file.ts" });
  expect(native.save).toHaveBeenCalledWith({
    title: undefined,
    defaultPath: "/workspace/default.ts",
    filters: [{ name: "TypeScript", extensions: ["ts"] }],
  });
});

it("preserves cancellation, folder selection and explicit mixed-selection mode choice", async () => {
  native.open.mockResolvedValue("/workspace/folder");
  native.save.mockResolvedValue(null);
  const { host, choose } =
    await integratedDialogs(`const v = require('vscode'); exports.activate = () => {
    v.commands.registerCommand('folder', async () => (await v.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }))[0].path);
    v.commands.registerCommand('mixed', async () => await v.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true }) === undefined);
    v.commands.registerCommand('cancelSave', async () => await v.window.showSaveDialog() === undefined);
  };`);
  expect(await host.request("host/executeCommand", { command: "folder" })).toBe(
    "/workspace/folder",
  );
  expect(native.open).toHaveBeenLastCalledWith(
    expect.objectContaining({ directory: true, multiple: false }),
  );
  choose.mockResolvedValueOnce(null);
  expect(await host.request("host/executeCommand", { command: "mixed" })).toBe(
    true,
  );
  expect(native.open).toHaveBeenCalledTimes(1);
  expect(
    await host.request("host/executeCommand", { command: "cancelSave" }),
  ).toBe(true);
});

it("propagates native failures and rejects non-file defaults and invalid selection/filter options", async () => {
  native.open.mockRejectedValueOnce(new Error("native dialog failed"));
  const { host } =
    await integratedDialogs(`const v = require('vscode'); exports.activate = () => {
    v.commands.registerCommand('failed', () => v.window.showOpenDialog());
    v.commands.registerCommand('virtual', () => v.window.showOpenDialog({ defaultUri: v.Uri.parse('memory:/source') }));
    v.commands.registerCommand('empty', () => v.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: false }));
  };`);
  await expect(
    host.request("host/executeCommand", { command: "failed" }),
  ).rejects.toThrow("native dialog failed");
  await expect(
    host.request("host/executeCommand", { command: "virtual" }),
  ).rejects.toThrow("file URI");
  await expect(
    host.request("host/executeCommand", { command: "empty" }),
  ).rejects.toThrow("must allow files or folders");
  expect(() =>
    extensionDialogOptions({ filters: [{ name: "bad", extensions: [42] }] }),
  ).toThrow("Invalid dialog filter");
});
