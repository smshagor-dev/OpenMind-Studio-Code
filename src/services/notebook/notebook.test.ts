import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import type { OpenedNotebook } from "../workflowIpc";
import { collapsed, KERNEL_MISSING, outputView, runBlocker, stripAnsi } from "./notebookModel";
import { NotebookService, RUN_ALL } from "./notebookService";

const PATH = "C:/w/analysis.ipynb";

function opened(patch: Partial<OpenedNotebook> = {}): OpenedNotebook {
  return {
    fingerprint: "fp1",
    trusted: false,
    kernel: null,
    model: {
      nbformat: 4,
      nbformatMinor: 5,
      language: "python",
      kernelName: "Python 3",
      cells: [
        { index: 0, id: "a", kind: "markdown", source: "# Title", executionCount: null, outputs: [] },
        { index: 1, id: "b", kind: "code", source: "x = 1\nx", executionCount: 2, outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }] },
        { index: 2, id: "c", kind: "code", source: "x + 1", executionCount: null, outputs: [] },
      ],
    },
    ...patch,
  };
}

function rig(open: OpenedNotebook = opened(), answer: string | null = RUN_ALL, autoSave = "off") {
  const ipc = createFakeIpc({
    notebookOpen: vi.fn().mockResolvedValue(open),
    notebookExecute: vi.fn().mockResolvedValue({ ok: true, executionCount: 3, outputs: [{ output_type: "execute_result", data: { "text/plain": "2" } }] }),
    notebookKernels: vi.fn().mockResolvedValue([{ interpreter: "C:/py/python.exe", label: "OpenMind portable Python", source: "portable", hasIpykernel: false }]),
    notebookKernelStart: vi.fn().mockResolvedValue("OpenMind portable Python"),
  });
  const notice = vi.fn();
  const confirm = vi.fn(() => Promise.resolve(answer));
  const service = new NotebookService({
    ipc,
    confirm,
    quickPick: () => Promise.resolve(0),
    notice,
    log: () => undefined,
    autoSave: () => ({ mode: autoSave, delay: 200 }),
  });
  return { service, ipc, notice, confirm };
}

describe("notebook outputs", () => {
  it("text, images, errors, markdown and unknown data each have a safe view", () => {
    expect(outputView({ output_type: "stream", name: "stderr", text: ["a\n", "\u001b[31mb\u001b[0m"] }, false)).toEqual({ kind: "text", stream: "stderr", text: "a\nb" });
    expect(outputView({ output_type: "display_data", data: { "image/png": "iVBORw0KGgo=\n" } }, false)).toEqual({ kind: "image", mime: "image/png", src: "data:image/png;base64,iVBORw0KGgo=" });
    expect(outputView({ output_type: "display_data", data: { "image/png": "https://evil/x.png" } }, true).kind).toBe("unsupported");
    expect(outputView({ output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[0;31mTraceback"] }, false)).toEqual({ kind: "error", title: "ValueError: bad", traceback: "Traceback" });
    expect(outputView({ output_type: "execute_result", data: { "text/markdown": "**x**" } }, false).kind).toBe("markdown");
    expect(outputView({ output_type: "display_data", data: { "application/vnd.widget+json": {} } }, true)).toEqual({ kind: "unsupported", mimes: ["application/vnd.widget+json"] });
    expect(stripAnsi("\u001b[1mbold\u001b[0m")).toBe("bold");
  });

  it("HTML output is shown only in a trusted notebook (sanitized); untrusted falls back to text or a notice", () => {
    const html = { output_type: "display_data", data: { "text/html": "<b>x</b>", "text/plain": "x" } };
    expect(outputView(html, true)).toEqual({ kind: "html", html: "<b>x</b>" });
    expect(outputView(html, false)).toEqual({ kind: "text", stream: "result", text: "x" });
    expect(outputView({ output_type: "display_data", data: { "text/html": "<b>x</b>" } }, false)).toEqual({ kind: "htmlBlocked" });
  });

  it("large outputs are collapsed", () => {
    expect(collapsed("a\nb")).toBeNull();
    const long = Array.from({ length: 250 }, (_, i) => String(i)).join("\n");
    expect(collapsed(long)?.hiddenLines).toBe(50);
    expect(collapsed("x".repeat(30_000))?.shown.length).toBe(20_000);
  });

  it("a cell runs only in a trusted Python notebook with a kernel, one at a time", () => {
    const base = { trusted: true, kernel: true, language: "python", cellKind: "code" as const, running: false };
    expect(runBlocker(base)).toBeNull();
    expect(runBlocker({ ...base, trusted: false })).toBe("Trust this notebook to run its cells.");
    expect(runBlocker({ ...base, kernel: false })).toBe(KERNEL_MISSING);
    expect(KERNEL_MISSING).toBe("Kernel not configured. Install/configure from Runtime Manager.");
    expect(runBlocker({ ...base, language: "R" })).toContain("Only Python notebooks can run");
    expect(runBlocker({ ...base, cellKind: "markdown" })).toBe("Only code cells run.");
    expect(runBlocker({ ...base, running: true })).toBe("A cell is running.");
  });
});

describe("NotebookService", () => {
  it("opening reads the notebook and runs nothing", async () => {
    const { service, ipc } = rig();
    await service.open(PATH);
    const doc = service.get(PATH);
    expect(doc?.cells.map((c) => c.kind)).toEqual(["markdown", "code", "code"]);
    expect(doc?.trusted).toBe(false);
    expect(ipc.notebookExecute).not.toHaveBeenCalled();
    expect(ipc.notebookKernelStart).not.toHaveBeenCalled();
  });

  it("an untrusted notebook doesn't run; trusting, picking a kernel and running a cell stores its outputs", async () => {
    const { service, ipc, notice } = rig();
    await service.open(PATH);
    const cell = service.get(PATH)?.cells[2]?.key ?? "";
    expect(await service.runCell(PATH, cell)).toBe(false);
    expect(notice).toHaveBeenCalledWith("Trust this notebook to run its cells.");
    await service.setTrusted(PATH, true);
    expect(ipc.notebookSetTrust).toHaveBeenCalledWith(PATH, true);
    expect(service.runReason(PATH, cell)).toBe(KERNEL_MISSING);
    await service.selectKernel(PATH);
    expect(ipc.notebookKernelStart).toHaveBeenCalledWith(PATH, "C:/py/python.exe");
    expect(await service.runCell(PATH, cell)).toBe(true);
    expect(ipc.notebookExecute).toHaveBeenCalledWith(PATH, 2, "x + 1", "fp1");
    const ran = service.get(PATH)?.cells[2];
    expect(ran?.executionCount).toBe(3);
    expect(ran?.outputs[0]?.output_type).toBe("execute_result");
    expect(service.get(PATH)?.dirty).toBe(true);
  });

  it("Run All asks first; declining runs nothing", async () => {
    const declined = rig(opened({ trusted: true, kernel: "Python" }), null);
    await declined.service.open(PATH);
    await declined.service.runAll(PATH);
    expect(declined.confirm).toHaveBeenCalledTimes(1);
    expect(declined.ipc.notebookExecute).not.toHaveBeenCalled();
    const accepted = rig(opened({ trusted: true, kernel: "Python" }));
    await accepted.service.open(PATH);
    await accepted.service.runAll(PATH);
    expect(accepted.ipc.notebookExecute).toHaveBeenCalledTimes(2);
  });

  it("edits save with their original positions; a conflict offers to overwrite", async () => {
    const { service, ipc } = rig();
    await service.open(PATH);
    const doc = service.get(PATH);
    const first = doc?.cells[0]?.key ?? "";
    service.setSource(PATH, first, "# New title");
    const added = service.addCell(PATH, first, "code");
    expect(added).not.toBeNull();
    service.moveCell(PATH, doc?.cells[2]?.key ?? "", -1);
    await service.save(PATH);
    const sent = vi.mocked(ipc.notebookSave).mock.calls[0];
    expect(sent?.[1].map((c) => c.origin)).toEqual([0, null, 2, 1]);
    expect(sent?.[1][0]?.source).toBe("# New title");
    expect(service.get(PATH)?.dirty).toBe(false);
    vi.mocked(ipc.notebookSave).mockRejectedValueOnce(new Error("The notebook changed on disk since it was opened."));
    service.setSource(PATH, first, "again");
    expect(await service.save(PATH)).toBe(false);
    expect(service.get(PATH)?.conflict).toBe(true);
    await service.save(PATH, true);
    expect(vi.mocked(ipc.notebookSave).mock.calls.at(-1)?.[3]).toBe(true);
  });

  it("closing the notebook stops its kernel", async () => {
    const { service, ipc } = rig();
    await service.open(PATH);
    await service.close(PATH);
    expect(ipc.notebookKernelStop).toHaveBeenCalledWith(PATH);
    expect(service.get(PATH)).toBeUndefined();
  });

  it("a notebook that can't be read shows why", async () => {
    const { service, ipc } = rig();
    vi.mocked(ipc.notebookOpen).mockRejectedValueOnce(new Error("nbformat 3 notebooks are not supported (only version 4)."));
    await service.open(PATH);
    expect(service.get(PATH)?.status).toBe("error");
    expect(service.get(PATH)?.error).toContain("nbformat 3");
  });
});
