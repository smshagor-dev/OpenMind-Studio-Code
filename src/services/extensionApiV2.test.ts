import { describe, expect, it } from "vitest";

import { contributedLists } from "../components/extensionContributesModel";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { testExtension } from "../testUtils/fakeExtensionsIpc";
import { filesChanged } from "./extensionApiWiring";
import { ExtensionPromptService } from "./extensionPromptService";
import { FilePreviewService } from "./filePreviewService";

describe("file watcher events for extensions", () => {
  it("splits a batch into created / changed / deleted, a rename being both", () => {
    expect(
      filesChanged({
        overflow: false,
        changes: [
          { path: "C:/w/a.txt", kind: "created", from: null },
          { path: "C:/w/b.txt", kind: "modified", from: null },
          { path: "C:/w/c.txt", kind: "removed", from: null },
          { path: "C:/w/new.txt", kind: "renamed", from: "C:/w/old.txt" },
        ],
      }),
    ).toEqual({
      created: ["C:/w/a.txt", "C:/w/new.txt"],
      changed: ["C:/w/b.txt"],
      deleted: ["C:/w/c.txt", "C:/w/old.txt"],
    });
  });
});

describe("confirmation prompts", () => {
  it("resolve with the chosen button, or null when dismissed", async () => {
    const prompts = new ExtensionPromptService();
    const first = prompts.confirm({ extension: "pub.ext", title: "Run?", details: [], notes: [], buttons: ["Run"] });
    const dialog = prompts.getState().dialog;
    expect(dialog?.kind).toBe("confirm");
    prompts.answer(dialog?.id ?? -1, "Run");
    expect(await first).toBe("Run");
    const second = prompts.confirm({ extension: "pub.ext", title: "Run?", details: [], notes: [], buttons: ["Run"] });
    prompts.dismiss(prompts.getState().dialog?.id ?? -1);
    expect(await second).toBeNull();
  });
});

describe("custom-scheme documents", () => {
  it("open read-only from the extension's text, once per uri, and are never reloaded from disk", async () => {
    const ipc = createFakeIpc();
    const previews = new FilePreviewService(ipc);
    const request = { uri: "memfs:/hello.txt", text: "hi", language: "plaintext", extension: "pub.ext", readonly: true };
    const id = previews.openVirtual(request);
    expect(previews.isVirtual(id)).toBe(true);
    expect(previews.openVirtual({ ...request, text: "changed" })).toBe(id);
    expect(previews.get(id)?.model).toMatchObject({ type: "virtualText", text: "changed", readonly: true });
    await previews.reload(id);
    expect(ipc.previewInspect).not.toHaveBeenCalled();
  });
});

describe("extension details lists", () => {
  it("name what an extension contributes", () => {
    const base = testExtension().manifest;
    const extension = testExtension({
      manifest: {
        ...base,
        contributes: {
          ...base.contributes,
          commands: [{ command: "a.run", title: "Run A", category: null }],
          iconThemes: [{ id: "icons", label: "", path: "i.json" }],
          taskDefinitions: [{ type: "samplev2", required: [] }],
        },
      },
    });
    const lists = Object.fromEntries(contributedLists(extension).map((l) => [l.label, l.items]));
    expect(lists.Commands).toEqual(["Run A (a.run)"]);
    expect(lists["File icon themes"]).toEqual(["icons"]);
    expect(lists["Task types"]).toEqual(["samplev2"]);
  });
});
