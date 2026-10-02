import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EditorGroupService } from "./editorGroupService";
import { EditorLayoutService } from "./editorLayoutService";

describe("saving the editor layout", () => {
  it("reports a failed save once (the tabs wouldn't reopen after a restart), and again after a save worked", async () => {
    const settingsSet = vi.fn().mockRejectedValue(new Error("database or disk is full"));
    const failed = vi.fn();
    const layout = new EditorLayoutService(
      createFakeIpc({ settingsSet }),
      new EditorGroupService(),
      () => null,
      failed,
    );

    await layout.save();
    await layout.save();
    expect(settingsSet).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(String(failed.mock.calls[0]?.[0])).toContain("disk is full");

    settingsSet.mockResolvedValueOnce(undefined);
    await layout.save();
    await layout.save();
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("says nothing while saves work", async () => {
    const failed = vi.fn();
    const layout = new EditorLayoutService(createFakeIpc(), new EditorGroupService(), () => null, failed);
    await layout.save();
    expect(failed).not.toHaveBeenCalled();
  });
});
