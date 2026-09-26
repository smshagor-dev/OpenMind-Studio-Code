import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { ProfileService } from "./profileService";
import type { ProfileList } from "./profilesIpc";

function list(active = "default", extra: string[] = []): ProfileList {
  const ids = ["default", "python", "minimal", ...extra];
  return {
    profiles: ids.map((id) => ({
      id,
      name: id === "default" ? "Default" : id,
      active: id === active,
      settingCount: 3,
      updatedAt: 1,
    })),
    active,
    problems: [],
    covers: ["editor.fontSize"],
  };
}

function rig(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({ profilesList: vi.fn().mockResolvedValue(list()), ...overrides });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  const notices: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  events.on("appNotice", ({ message }) => notices.push(message));
  const reload = vi.fn().mockResolvedValue(undefined);
  return { service: new ProfileService(ipc, events, reload), ipc, errors, notices, reload };
}

describe("ProfileService", () => {
  it("reads the profiles and knows the active one", async () => {
    const r = rig();
    await r.service.load();
    expect(r.service.active()?.name).toBe("Default");
    expect(r.service.getState().list?.profiles).toHaveLength(3);
  });

  it("switching re-reads the settings so the theme and icons follow, and says which profile is active", async () => {
    const r = rig({ profileSwitch: vi.fn().mockResolvedValue(list("minimal")) });
    await r.service.load();
    expect(await r.service.switchTo("minimal")).toBe(true);
    expect(r.ipc.profileSwitch).toHaveBeenCalledWith("minimal");
    expect(r.reload).toHaveBeenCalledTimes(1);
    expect(r.service.active()?.id).toBe("minimal");
    expect(r.notices.at(-1)).toBe("Profile: minimal.");
  });

  it("a failed switch is reported, changes nothing in the list and does not reload the settings", async () => {
    const r = rig({ profileSwitch: vi.fn().mockRejectedValue("settings.json has a problem") });
    await r.service.load();
    expect(await r.service.switchTo("python")).toBe(false);
    expect(r.errors[0]).toContain("settings.json has a problem");
    expect(r.service.active()?.id).toBe("default");
    expect(r.reload).not.toHaveBeenCalled();
    expect(r.service.getState().busy).toBe(false);
  });

  it("creates, renames, duplicates and deletes through the backend and shows the new list", async () => {
    const r = rig({
      profileCreate: vi.fn().mockResolvedValue(list("default", ["work"])),
      profileRename: vi.fn().mockResolvedValue(list("default", ["work"])),
      profileDuplicate: vi.fn().mockResolvedValue(list("default", ["work", "work-copy"])),
      profileDelete: vi.fn().mockResolvedValue(list()),
    });
    await r.service.create("Work", true);
    expect(r.ipc.profileCreate).toHaveBeenCalledWith("Work", true);
    expect(r.service.getState().list?.profiles.some((p) => p.id === "work")).toBe(true);
    await r.service.rename("work", "Job");
    await r.service.duplicate("work", "Job copy");
    expect(r.service.getState().list?.profiles).toHaveLength(5);
    await r.service.remove("work");
    expect(r.service.getState().list?.profiles).toHaveLength(3);
  });

  it("Default and the active profile can't be deleted, with the reason", async () => {
    const r = rig();
    await r.service.load();
    const [def, python] = r.service.getState().list?.profiles ?? [];
    expect(def && r.service.deleteBlocker(def)).toBe("The Default profile can't be deleted.");
    expect(python && r.service.deleteBlocker(python)).toBeUndefined();
    const inUse = { id: "python", name: "Python", active: true, settingCount: 1, updatedAt: 1 };
    expect(r.service.deleteBlocker(inUse)).toContain("in use");
  });

  it("Export asks the backend for the text and saves exactly that text through the Save dialog", async () => {
    const r = rig({
      profileExport: vi.fn().mockResolvedValue('{"format":"openmind-profile"}'),
      saveDocumentDialog: vi.fn().mockResolvedValue("D:/Share/me.json"),
      documentSave: vi.fn().mockResolvedValue(undefined),
    });
    expect(await r.service.exportProfile()).toBe(true);
    expect(r.ipc.profileExport).toHaveBeenCalledWith("default");
    expect(r.ipc.documentSave).toHaveBeenCalledWith(
      "D:/Share/me.json",
      '{"format":"openmind-profile"}',
      "utf8",
    );
    expect(r.notices.at(-1)).toContain("no keys, passwords or local paths");
  });

  it("cancelling the Save or Open dialog does nothing", async () => {
    const r = rig({
      profileExport: vi.fn().mockResolvedValue("{}"),
      saveDocumentDialog: vi.fn().mockResolvedValue(null),
      openDocumentDialog: vi.fn().mockResolvedValue(null),
      documentSave: vi.fn(),
    });
    expect(await r.service.exportProfile()).toBe(false);
    expect(await r.service.importProfile()).toBe(false);
    expect(r.ipc.documentSave).not.toHaveBeenCalled();
    expect(r.ipc.profileImport).not.toHaveBeenCalled();
  });

  it("Import sends the file's text to the backend for checking; an invalid file is reported and nothing is added", async () => {
    const r = rig({
      openDocumentDialog: vi.fn().mockResolvedValue("D:/in.json"),
      documentRead: vi.fn().mockResolvedValue({
        state: "file",
        content: "not a profile",
        encoding: "utf8",
        lineEnding: "lf",
      }),
      profileImport: vi.fn().mockRejectedValue("Not a valid profile file: expected value"),
    });
    await r.service.load();
    expect(await r.service.importProfile()).toBe(false);
    expect(r.ipc.profileImport).toHaveBeenCalledWith("not a profile");
    expect(r.errors[0]).toContain("Not a valid profile file");
    expect(r.service.getState().list?.profiles).toHaveLength(3);
  });

  it("a missing file can't be imported", async () => {
    const r = rig({
      openDocumentDialog: vi.fn().mockResolvedValue("D:/gone.json"),
      documentRead: vi.fn().mockResolvedValue({ state: "missing" }),
    });
    expect(await r.service.importProfile()).toBe(false);
    expect(r.errors[0]).toContain("the file is gone");
    expect(r.ipc.profileImport).not.toHaveBeenCalled();
  });

  it("nothing is read at construction: the profiles load only when asked", () => {
    const r = rig();
    expect(r.ipc.profilesList).not.toHaveBeenCalled();
  });
});
