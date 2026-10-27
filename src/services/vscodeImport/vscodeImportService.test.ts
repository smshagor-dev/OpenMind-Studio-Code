import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { VsCodeImportIpc, VsCodePreview } from "./vscodeImportIpc";
import { VsCodeImportService, type VsCodeImportHost } from "./vscodeImportService";

const PREVIEW: VsCodePreview = {
  settings: [{ id: "editor.fontSize", value: 15 }],
  keybindings: [{ key: "Ctrl+Alt+S", command: "file.saveAll" }],
  extensions: ["acme.tool-1.0.0"],
  snippets: ["rust.json"],
  skipped: ["vim.useCtrlKeys (no OpenMind equivalent)"],
  warnings: [],
};

function rig(overrides: Partial<VsCodeImportIpc> = {}) {
  const ipc: VsCodeImportIpc = {
    sources: vi.fn().mockResolvedValue([
      { edition: "code", profile: "default", label: "Code — Default" },
      { edition: "codium", profile: "default", label: "VSCodium — Default" },
    ]),
    preview: vi.fn().mockResolvedValue(PREVIEW),
    apply: vi.fn().mockResolvedValue({
      settingsImported: 1, shortcutsImported: 1, settingsBackup: "s.bak", shortcutsBackup: null, skipped: [], warnings: [],
    }),
    importSnippets: vi.fn().mockResolvedValue(1),
    importProfile: vi.fn().mockResolvedValue({}),
    importExtension: vi.fn().mockResolvedValue({ id: "acme.tool" }),
    ...overrides,
  };
  const host: VsCodeImportHost = {
    reloadSettings: vi.fn().mockResolvedValue(undefined),
    reloadKeybindings: vi.fn().mockResolvedValue(undefined),
    reloadProfiles: vi.fn().mockResolvedValue(undefined),
    reloadExtensions: vi.fn().mockResolvedValue(undefined),
    reloadSnippets: vi.fn(),
    text: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
  };
  return { ipc, host, service: new VsCodeImportService(ipc, host) };
}

describe("VsCodeImportService", () => {
  it("lists the profiles only when opened and picks the first", async () => {
    const { ipc, service } = rig();
    expect(ipc.sources).not.toHaveBeenCalled();
    await service.toggle();
    expect(service.getState().selected).toBe("code:default");
    await service.toggle();
    expect(service.getState().expanded).toBe(false);
  });

  it("previews the chosen profile and needs a preview before importing", async () => {
    const { ipc, service } = rig();
    await service.toggle();
    service.select("codium:default");
    expect(service.applyBlocker()).toBe("vscodeImport.reason.previewFirst");
    expect(await service.apply()).toBe(false);
    await service.inspect();
    expect(ipc.preview).toHaveBeenCalledWith("codium", "default");
    expect(service.applyBlocker()).toBeNull();
    service.setImportSettings(false);
    service.setImportShortcuts(false);
    expect(service.applyBlocker()).toBe("vscodeImport.reason.nothingChosen");
  });

  it("imports and makes the new settings and shortcuts take effect at once", async () => {
    const { ipc, host, service } = rig();
    await service.toggle();
    await service.inspect();
    service.setImportShortcuts(false);
    await service.apply();
    expect(ipc.apply).toHaveBeenCalledWith("code", "default", true, false);
    expect(host.reloadSettings).toHaveBeenCalled();
    expect(host.reloadKeybindings).toHaveBeenCalled();
    expect(service.getState().result?.settingsBackup).toBe("s.bak");
  });

  it("shows a failure and stays usable", async () => {
    const { service } = rig({ preview: vi.fn().mockRejectedValue("Existing OpenMind settings are invalid") });
    await service.toggle();
    expect(await service.inspect()).toBe(false);
    expect(service.getState()).toMatchObject({ busy: false, error: "Existing OpenMind settings are invalid" });
  });

  it("imports snippets, the profile and an extension, refreshing what each changes", async () => {
    const { ipc, host, service } = rig();
    await service.toggle();
    await service.inspect();
    await service.importSnippets();
    expect(host.reloadSnippets).toHaveBeenCalled();
    await service.importProfile();
    expect(host.reloadProfiles).toHaveBeenCalled();
    await service.importExtension("acme.tool-1.0.0");
    expect(ipc.importExtension).toHaveBeenCalledWith("code", "acme.tool-1.0.0");
    expect(host.reloadExtensions).toHaveBeenCalled();
    expect(service.getState().notice).toContain("acme.tool");
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the backend's VS Code command map", () => {
  it("only names commands the app really has", () => {
    const map = readFileSync("crates/settings/src/vscode_map.rs", "utf8");
    const block = map.slice(map.indexOf("pub const COMMANDS"), map.indexOf("];"));
    const targets = [...block.matchAll(/\("[^"]+", "([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(targets.length).toBeGreaterThan(50);
    const source = sourceFiles("src").map((path) => readFileSync(path, "utf8")).join("\n");
    const missing = [...new Set(targets)].filter((id) => !source.includes(`"${id}"`));
    expect(missing).toEqual([]);
  });
});
