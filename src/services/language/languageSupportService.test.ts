import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REGISTRY,
  languageRig,
  projectStatus,
  workspaceStatus,
} from "../../testUtils/languageFixtures";
import { matchLanguage } from "./languageRegistry";

describe("matchLanguage", () => {
  const id = (path: string) => matchLanguage(REGISTRY, path)?.id ?? null;

  it("recognises files by extension, case-insensitively, in Windows and Unix paths", () => {
    expect(id("C:/My Site/app.TS")).toBe("typescript");
    expect(id("C:\\My Site\\main.go")).toBe("go");
    expect(id("src/App.vue")).toBe("vue");
    expect(id("lib/main.dart")).toBe("dart");
  });

  it("matches whole names and name patterns before extensions", () => {
    expect(id("Dockerfile")).toBe("dockerfile");
    expect(id("api/Dockerfile.prod")).toBe("dockerfile");
    expect(id("docker-compose.yml")).toBe("dockercompose");
    expect(id("docker-compose.override.yml")).toBe("dockercompose");
    expect(id("compose.yaml")).toBe("dockercompose");
    expect(id(".env")).toBe("dotenv");
    expect(id(".env.local")).toBe("dotenv");
    expect(id("CMakeLists.txt")).toBe("cmake");
    expect(id("notes.yml")).toBe("yaml");
  });

  it("says nothing for a file it doesn't know", () => {
    expect(id("README")).toBeNull();
    expect(id("archive.zip")).toBeNull();
    expect(id("dir.d/file")).toBeNull();
  });
});

describe("LanguageSupportService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the registry once and answers languages and editor grammars", async () => {
    const { support, ipc } = languageRig();
    await support.initialize();
    expect(ipc.languageRegistry).toHaveBeenCalledTimes(1);
    expect(support.languageOf("main.go")?.name).toBe("Go");
    expect(support.editorLanguageFor("main.go")).toBe("go");
    // An approximate grammar is still used (Vue is coloured as HTML) and says so in the registry.
    expect(support.editorLanguageFor("App.vue")).toBe("html");
    expect(support.editorLanguageFor("compose.yaml")).toBe("yaml");
    // No grammar at all (Dart, CMake) and plain text: nothing to switch to.
    expect(support.editorLanguageFor("main.dart")).toBeNull();
    expect(support.editorLanguageFor("CMakeLists.txt")).toBeNull();
    expect(support.editorLanguageFor("notes.txt")).toBeNull();
    expect(support.editorLanguageFor("unknown.xyz")).toBeNull();
  });

  it("scans the open folder on request and reports scanning, projects and the status-bar summary", async () => {
    const rig = languageRig();
    await rig.support.initialize();
    expect(rig.support.summary()).toBeNull();
    const scan = rig.support.refresh();
    expect(rig.support.getState().scanning).toBe(true);
    expect(rig.support.summary()).toBe("Detecting project…");
    await scan;
    expect(rig.support.getState().scanning).toBe(false);
    expect(rig.support.summary()).toBe("Vite + React");
    expect(rig.ipc.languageWorkspaceStatus).toHaveBeenCalledTimes(1);
  });

  it("summarises several projects, and a folder with none", async () => {
    const rig = languageRig({
      workspace: workspaceStatus([
        projectStatus({ root: "apps/web", title: "Next.js" }),
        projectStatus({ root: "apps/api", title: "Go" }),
      ]),
    });
    await rig.support.initialize();
    await rig.support.refresh();
    expect(rig.support.summary()).toBe("Next.js (+1)");

    const empty = languageRig({ workspace: workspaceStatus([]) });
    await empty.support.initialize();
    await empty.support.refresh();
    expect(empty.support.summary()).toBe("No project detected");

    const none = languageRig({ hasWorkspace: false });
    await none.support.initialize();
    await none.support.refresh();
    expect(none.ipc.languageWorkspaceStatus).not.toHaveBeenCalled();
    expect(none.support.summary()).toBeNull();
  });


  it("shows the error of a failed scan and does not keep a stale state", async () => {
    const rig = languageRig();
    await rig.support.initialize();
    vi.mocked(rig.ipc.languageWorkspaceStatus).mockRejectedValueOnce("the scan failed");
    await rig.support.refresh();
    expect(rig.support.getState()).toMatchObject({ scanning: false, scanError: "the scan failed" });
  });

  it("never scans by itself: the folder and saved manifests are followed by the backend; Refresh asks it", async () => {
    const rig = languageRig();
    await rig.support.initialize();
    rig.events.emit("workspaceFolderChanged", {
      workspace: { id: 1, path: "C:/My Project", name: "My Project" },
    });
    rig.events.emit("documentSaved", { id: "d2", path: "C:/My Project/package.json" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.ipc.languageWorkspaceStatus).not.toHaveBeenCalled();
    await rig.support.refresh();
    expect(rig.ipc.languageWorkspaceStatus).toHaveBeenCalledTimes(1);
  });

  it("finds the project a file belongs to: the deepest root wins", async () => {
    const rig = languageRig({
      workspace: workspaceStatus([
        projectStatus({ root: "", title: "Root" }),
        projectStatus({ root: "apps/web", title: "Web" }),
        projectStatus({ root: "apps/web/admin", title: "Admin" }),
      ]),
    });
    await rig.support.initialize();
    await rig.support.refresh();
    expect(rig.support.projectOf("apps/web/admin/src/a.ts")?.title).toBe("Admin");
    expect(rig.support.projectOf("apps/web/src/a.ts")?.title).toBe("Web");
    expect(rig.support.projectOf("apps/webby/a.ts")?.title).toBe("Root");
    expect(rig.support.projectOf("README.md")?.title).toBe("Root");
  });

  it("looks a file up and keeps the error when that fails", async () => {
    const rig = languageRig();
    await rig.support.initialize();
    const file = await rig.support.lookUpFile("C:/My Project/src/a.ts");
    expect(file?.language?.id).toBe("typescript");
    expect(rig.support.getState().file).toBe(file);
    vi.mocked(rig.ipc.languageFileStatus).mockRejectedValueOnce(
      "This file is outside the open folder.",
    );
    expect(await rig.support.lookUpFile("D:/other.ts")).toBeNull();
    expect(rig.support.getState()).toMatchObject({
      file: null,
      fileError: "This file is outside the open folder.",
    });
  });
});
