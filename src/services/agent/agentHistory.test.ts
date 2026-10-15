import { describe, expect, it, vi } from "vitest";
import { AgentHistory, type HistoryIpc, type HistorySnapshot } from "./agentHistory";
import { DEFAULT_AGENT_OPTIONS } from "./agentOptions";
function fixture() {
  const ipc: HistoryIpc = {
    save: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
    load: vi.fn(() => Promise.resolve(null)),
    delete: vi.fn(() => Promise.resolve(true)),
  };
  const failed = vi.fn();
  const history = new AgentHistory(ipc, failed);
  const snapshot: HistorySnapshot = {
    id: "chat",
    title: "test",
    workspace: "/project",
    createdAt: 1,
    entries: [{ kind: "user", id: "u", text: "hello" }],
    tasks: [],
  };
  return { ipc, failed, history, snapshot };
}
describe("AgentHistory", () => {
  it("flushes the latest streamed snapshot before loading and restores document context", async () => {
    const { ipc, history, snapshot } = fixture();
    snapshot.entries.push({
      kind: "document",
      id: "doc",
      name: "code.ts",
      text: "export const answer = 42;",
    });
    history.schedule(snapshot);
    history.schedule({ ...snapshot, title: "latest" });
    await history.flush();
    expect(ipc.save).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(ipc.save).mock.calls[0]?.[0];
    if (!saved) throw new Error("Snapshot was not saved");
    vi.mocked(ipc.load).mockResolvedValueOnce(saved);
    expect(await history.load("chat")).toMatchObject({
      title: "latest",
      workspace: "/project",
      entries: snapshot.entries,
    });
  });
  it("stores attachments individually so six images do not exceed the per-message DB limit", async () => {
    const { ipc, history, snapshot } = fixture();
    const images = Array.from({ length: 6 }, (_, i) => ({
      id: `i${i}`,
      name: "image.jpg",
      data: `data:image/jpeg;base64,${"A".repeat(500000)}`,
    }));
    snapshot.tasks.push({
      id: "task",
      text: "read",
      attachments: images,
      mode: "ask",
      modelId: "local",
      workspace: "/project",
      options: { ...DEFAULT_AGENT_OPTIONS },
      status: "completed",
      reason: "done",
      createdAt: 1,
    });
    history.schedule(snapshot);
    await history.flush();
    const saved = vi.mocked(ipc.save).mock.calls[0]?.[0];
    if (!saved) throw new Error("Snapshot was not saved");
    expect(saved.messages.every((m) => m.content.length < 1024 * 1024)).toBe(true);
    vi.mocked(ipc.load).mockResolvedValueOnce(saved);
    expect((await history.load("chat"))?.tasks[0]?.attachments).toEqual(images);
  });
  it("rejects corrupt history instead of rendering an executable asset URL", async () => {
    const { ipc, history, snapshot } = fixture();
    history.schedule(snapshot);
    await history.flush();
    const saved = vi.mocked(ipc.save).mock.calls[0]?.[0];
    if (!saved) throw new Error("Snapshot was not saved");
    const message = saved.messages[0];
    if (!message) throw new Error("Missing message");
    message.content = JSON.stringify({
      kind: "asset",
      id: "x",
      name: "bad",
      data: "javascript:alert(1)",
    });
    vi.mocked(ipc.load).mockResolvedValueOnce(saved);
    await expect(history.load("chat")).rejects.toThrow("Invalid history entry");
  });
  it("serializes writes and flushes before delete", async () => {
    const { ipc, history, snapshot } = fixture();
    const order: string[] = [];
    vi.mocked(ipc.save).mockImplementation(async (value) => {
      await Promise.resolve();
      order.push(value.title);
    });
    vi.mocked(ipc.delete).mockImplementation(() => {
      order.push("deleted");
      return Promise.resolve(true);
    });
    history.schedule(snapshot);
    const first = history.flush();
    history.schedule({ ...snapshot, title: "second" });
    await history.delete("chat");
    await first;
    expect(order).toEqual(["test", "second", "deleted"]);
  });
});
