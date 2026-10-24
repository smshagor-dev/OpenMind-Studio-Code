import { describe, expect, it, vi } from "vitest";
import { AgentTasks, lastInterruptedTask, type AgentTask } from "./agentTasks";
import { DEFAULT_AGENT_OPTIONS, agentOptions } from "./agentOptions";

const task = (id: string): AgentTask => ({ id, text: id, mode: "ask", modelId: "a", workspace: "/project", options: { ...DEFAULT_AGENT_OPTIONS }, status: "pending", reason: null, createdAt: 1 });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup() {
  const run = vi.fn<(task: AgentTask, signal: AbortSignal) => Promise<boolean>>(() => Promise.resolve(true));
  const stop = vi.fn(() => Promise.resolve());
  return { run, stop, queue: new AgentTasks({ run, stop, changed: () => undefined }) };
}
describe("task controller", () => {
  it("dispatches one task at a time and preserves FIFO until completion", async () => {
    const { queue, run } = setup();
    queue.enqueue(task("a")); queue.enqueue(task("b")); await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.getState().tasks.map((t) => t.status)).toEqual(["running", "pending"]);
    queue.finish("done"); await tick();
    expect(run.mock.calls[1]?.[0]).toMatchObject({ id: "b" });
  });
  it("Stop before dispatch pauses the queue without sending anything", async () => {
    const { queue, run } = setup();
    queue.enqueue(task("a")); await queue.stop(); await tick();
    expect(run).not.toHaveBeenCalled();
    expect(queue.getState().paused).toBe(true);
    queue.resume(); await tick(); expect(run).toHaveBeenCalledTimes(1);
  });
  it("Stop aborts preparation and leaves later prompts paused", async () => {
    const { queue, run, stop } = setup();
    queue.enqueue(task("a")); queue.enqueue(task("b")); await tick();
    const signal = run.mock.calls[0]?.[1];
    await queue.stop(); queue.finish("cancelled"); await tick();
    expect(signal?.aborted).toBe(true); expect(stop).toHaveBeenCalledWith("a");
    expect(run).toHaveBeenCalledTimes(1); expect(queue.getState().tasks[1]?.status).toBe("pending");
  });
  it("canceling the first pending task does not strand the next", async () => {
    const { queue, run } = setup(); queue.enqueue(task("a")); queue.enqueue(task("b")); queue.cancel("a"); await tick();
    expect(run.mock.calls[0]?.[0]).toMatchObject({ id: "b" });
  });
  it("restores interrupted tasks paused and bounds the pending queue", async () => {
    const { queue, run } = setup(); queue.restore([{ ...task("a"), status: "running" }]); await tick();
    expect(run).not.toHaveBeenCalled(); expect(queue.getState()).toMatchObject({ paused: true, activeId: null });
    for (let i = 0; i < 19; i++) expect(queue.enqueue(task(String(i)))).toBe(true);
    expect(queue.enqueue(task("overflow"))).toBe(false);
  });
  it("validates persisted options without trusting strings or nonfinite values", () => {
    expect(agentOptions({ maxSteps: Infinity, maxOutputTokens: 1000000, autoRunQueue: "true", temperature: -1 })).toMatchObject({ maxSteps: 128, maxOutputTokens: 1000000, autoRunQueue: true, temperature: 0 });
  });
});

it("a message sent after a declined turn runs at once", async () => {
  const { queue, run } = setup();
  queue.enqueue(task("a")); await tick();
  queue.finish("rejected"); await tick();
  expect(queue.getState().paused).toBe(true);
  queue.enqueue(task("next")); await tick();
  expect(run.mock.calls[1]?.[0]).toMatchObject({ id: "next" });
});

it("prompts waiting behind a failed turn stay held, also when another is added", async () => {
  const { queue, run } = setup();
  queue.enqueue(task("a")); queue.enqueue(task("b")); await tick();
  queue.finish("error"); await tick();
  queue.enqueue(task("c")); await tick();
  expect(run).toHaveBeenCalledTimes(1);
  expect(queue.getState().paused).toBe(true);
});

it("a message never runs by itself when auto-run is off", async () => {
  const { queue, run } = setup();
  queue.enqueue({ ...task("a"), options: { ...DEFAULT_AGENT_OPTIONS, autoRunQueue: false } }); await tick();
  expect(run).not.toHaveBeenCalled();
});

it("restoring history never turns a removed prompt into an interrupted task", () => {
  const { queue } = setup();
  queue.restore([{ ...task("stopped"), status: "cancelled", reason: "cancelled" }, { ...task("removed"), status: "cancelled", reason: null }]);
  expect(lastInterruptedTask(queue.getState().tasks)?.id).toBe("stopped");
});


it("restores large pending prompts and text attachments intact", () => {
  const { queue } = setup();
  const text = "বাংলা\n".repeat(40_000);
  queue.restore([{ ...task("large"), text, attachments: [{ id: "source", name: "large.txt", text }] }]);
  expect(queue.getState().tasks[0]?.text).toBe(text);
  expect(queue.getState().tasks[0]?.attachments?.[0]?.text).toBe(text);
  expect(queue.getState().paused).toBe(true);
});
