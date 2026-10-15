import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve(true)),
  listen: vi.fn<
    (
      name: string,
      handler: (event: { payload: { id: string; owner: string } }) => void,
      options: unknown,
    ) => Promise<() => void>
  >(() => Promise.resolve(() => undefined)),
  dirty: new Set<string>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "window-2" }),
}));
vi.mock("../container", () => ({
  container: {
    documents: {
      fileBackedIds: () => ["one", "two"],
      isDirty: (id: string) => mocks.dirty.has(id),
      snapshot: (id: string) => ({ path: `C:/project/${id}.ts` }),
    },
    workspace: { getActiveWorkspace: () => ({ path: "C:/project" }) },
  },
}));

describe("agent mutation guard", () => {
  it("answers with live dirty state even when no agent panel is open", async () => {
    const { installMutationGuard } = await import("./mutationGuard");
    await installMutationGuard();
    expect(mocks.listen).toHaveBeenCalledWith("agent:guard", expect.any(Function), {
      target: { kind: "WebviewWindow", label: "window-2" },
    });
    const handler = mocks.listen.mock.calls[0]?.[1];
    expect(handler).toBeDefined();
    mocks.dirty.add("two");
    handler?.({ payload: { id: "g1", owner: "main" } });
    expect(mocks.invoke).toHaveBeenLastCalledWith("agent_guard_answer", {
      id: "g1",
      owner: "main",
      editor: { root: "C:/project", unsaved: ["C:/project/two.ts"] },
    });
    mocks.dirty.clear();
    handler?.({ payload: { id: "g2", owner: "main" } });
    expect(mocks.invoke).toHaveBeenLastCalledWith("agent_guard_answer", {
      id: "g2",
      owner: "main",
      editor: { root: "C:/project", unsaved: [] },
    });
  });
});
