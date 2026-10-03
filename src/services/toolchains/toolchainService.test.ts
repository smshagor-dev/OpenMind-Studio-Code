import { describe, expect, it, vi } from "vitest";

import { ipcFeed } from "../../testUtils/canonicalFeeds";
import { createFakeIpc, type FakeIpc } from "../../testUtils/fakeIpcClient";
import { gitWithVersions, packs, toolEntry } from "../../testUtils/toolchainFixtures";
import { ToolchainService } from "./toolchainService";
import {
  formatSize,
  missingLine,
  sectionsOf,
  shortPath,
  statusChip,
  versionCount,
} from "./toolchainView";

/** A ToolchainService following the canonical tool list (read from the fake backend's `toolchainsList`). */
function following(ipc: FakeIpc, now?: () => number): ToolchainService {
  const service = new ToolchainService(ipc, now);
  service.useCanonical(ipcFeed(() => ipc.toolchainsList()));
  return service;
}

async function loaded(tools = [gitWithVersions()]) {
  const ipc = createFakeIpc({ toolchainsList: vi.fn().mockResolvedValue(packs(tools)) });
  const service = following(ipc, () => 1234);
  await service.refresh();
  return { ipc, service };
}

describe("ToolchainService", () => {
  it("loads the packs and finds a tool by id", async () => {
    const { service } = await loaded();
    expect(service.getState().loaded).toBe(true);
    expect(service.tool("git")?.activeVersion).toBe("2.47.1");
    expect(service.tool("nope")).toBeUndefined();
  });

  it("shows nothing loaded, without throwing, until the backend has read the tools", async () => {
    const ipc = createFakeIpc({ toolchainsList: vi.fn().mockRejectedValue("disk error") });
    const service = following(ipc);
    await service.refresh();
    expect(service.getState().loaded).toBe(false);
    expect(service.getState().packs).toBeNull();
  });

  it("only lets a present, inactive version be chosen and says why not otherwise", async () => {
    const { service } = await loaded();
    expect(service.selectBlocker("git", "2.46.2")).toBeNull();
    expect(service.selectBlocker("git", "2.47.1")).toMatch(/already the active/);
    expect(service.selectBlocker("git", "2.45.0")).toMatch(/missing/);
    expect(service.selectBlocker("git", "9.9.9")).toMatch(/isn't listed/);
    expect(service.selectBlocker("nope", "1.0.0")).toMatch(/isn't listed/);
  });

  it("chooses a version through the backend and tells the language support to look again", async () => {
    const chosen = gitWithVersions();
    const after = { ...chosen, activeVersion: "2.46.2" };
    // The backend updates the canonical tool list before it answers; the window then catches up.
    const ipc = createFakeIpc({
      toolchainsList: vi.fn().mockResolvedValueOnce(packs([chosen])).mockResolvedValue(packs([after])),
      toolchainsSetActive: vi.fn().mockResolvedValue(packs([after])),
    });
    const service = following(ipc);
    await service.refresh();
    await service.setActive("git", "2.46.2");
    expect(ipc.toolchainsSetActive).toHaveBeenCalledWith("git", "2.46.2");
    expect(service.tool("git")?.activeVersion).toBe("2.46.2");
  });

  it("does not call the backend for a version that can't be chosen", async () => {
    const { ipc, service } = await loaded();
    await service.setActive("git", "2.45.0");
    await service.setActive("git", "2.47.1");
    expect(ipc.toolchainsSetActive).not.toHaveBeenCalled();
  });

  it("shows a refused choice as an error", async () => {
    const ipc = createFakeIpc({
      toolchainsList: vi.fn().mockResolvedValue(packs([gitWithVersions()])),
      toolchainsSetActive: vi.fn().mockRejectedValue("Git 2.46.2 is not available"),
    });
    const service = following(ipc);
    await service.refresh();
    await service.setActive("git", "2.46.2");
    expect(service.getState().error).toMatch(/not available/);
  });

  it("verifies only when asked and remembers the newest answer and when it was", async () => {
    const ipc = createFakeIpc({
      toolchainsList: vi.fn().mockResolvedValue(packs([gitWithVersions()])),
      toolchainsVerify: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          message: "It ran and answered.",
          executed: true,
          output: "git version 2.47.1",
        }),
    });
    const service = following(ipc, () => 99);
    await service.refresh();
    expect(ipc.toolchainsVerify).not.toHaveBeenCalled();
    await service.verify("git");
    expect(ipc.toolchainsVerify).toHaveBeenCalledWith("git", null);
    expect(service.getState().verified.git).toMatchObject({ at: 99, result: { ok: true } });
    expect(service.getState().verifying).toBeNull();
  });

  it("turns a failing verify into a readable failed result", async () => {
    const ipc = createFakeIpc({ toolchainsVerify: vi.fn().mockRejectedValue("boom") });
    const service = following(ipc);
    await service.verify("git", "2.46.2");
    expect(service.getState().verified.git?.result).toMatchObject({ ok: false, message: "boom" });
  });

  it("opens and closes the details of one tool", async () => {
    const { service } = await loaded();
    service.openDetails("git");
    expect(service.getState().detailsId).toBe("git");
    service.closeDetails();
    expect(service.getState().detailsId).toBeNull();
  });
});

describe("toolchainView", () => {
  it("groups tools into the page's sections and drops the empty ones", () => {
    const sections = sectionsOf([
      toolEntry({ id: "git", category: "vcs" }),
      toolEntry({ id: "prettier", category: "formatter" }),
      toolEntry({ id: "eslint", category: "linter" }),
      toolEntry({ id: "debugpy", category: "debugger" }),
      toolEntry({ id: "pyright", category: "languageServer" }),
      toolEntry({ id: "composer", category: "packageManager" }),
      toolEntry({ id: "flutter-sdk", category: "sdk", status: "external" }),
      toolEntry({ id: "go-sdk", category: "runtime", status: "external" }),
      toolEntry({ id: "docker", category: "helperTool", status: "external" }),
    ]);
    expect(sections.map((s) => s.title)).toEqual([
      "Package Managers",
      "Language Servers",
      "Formatters",
      "Linters",
      "Debuggers",
      "Version Control",
      "Mobile/Desktop SDKs",
      "External Required",
    ]);
    const external = sections.find((s) => s.id === "external");
    expect(external?.tools.map((t) => t.id)).toEqual(["go-sdk", "docker"]);
    expect(sections.find((s) => s.id === "sdks")?.tools.map((t) => t.id)).toEqual(["flutter-sdk"]);
    expect(sections.find((s) => s.id === "runtimes")).toBeUndefined();
  });

  it("has one honest chip per state", () => {
    expect(statusChip(toolEntry({ status: "active" }))).toEqual({ label: "Active", tone: "ok" });
    expect(statusChip(toolEntry({ status: "missing" })).label).toBe("Missing");
    expect(statusChip(toolEntry({ status: "broken" })).tone).toBe("error");
    expect(statusChip(toolEntry({ status: "external" })).label).toBe("External");
  });

  it("counts versions without rounding up to the cap", () => {
    expect(versionCount(toolEntry())).toBe("No versions bundled");
    expect(versionCount(gitWithVersions())).toBe("2 versions available (up to 5 kept)");
  });

  it("shortens a long path in the middle and leaves a short one alone", () => {
    expect(shortPath("C:\\a\\b.exe")).toBe("C:/a/b.exe");
    const long = "C:/Apps/OpenMind Studio/tools/language-servers/typescript/5.4.5/bin/tsserver.cmd";
    const short = shortPath(long, 40);
    expect(short.length).toBe(40);
    expect(short).toContain("…");
    expect(short.endsWith("tsserver.cmd")).toBe(true);
    expect(short.startsWith("C:/Apps")).toBe(true);
  });

  it("formats sizes and gives a setup line for anything that isn't active", () => {
    expect(formatSize(null)).toBeNull();
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(missingLine(toolEntry({ status: "active" }))).toBeNull();
    expect(missingLine(toolEntry({ status: "missing" }))).toMatch(/Not bundled/);
    expect(missingLine(toolEntry({ status: "broken" }))).toMatch(/missing from tools/);
  });
});
