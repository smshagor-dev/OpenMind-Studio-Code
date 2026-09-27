import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotebookService } from "../../services/notebook/notebookService";
import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import type { OpenedNotebook } from "../../services/workflowIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

vi.mock("./CellEditor", () => ({
  CellEditor: ({ source, label }: { source: string; label: string }) => <pre aria-label={label}>{source}</pre>,
}));

import { NotebookView } from "./NotebookView";

const PATH = "C:/w/n.ipynb";

function notebook(patch: Partial<OpenedNotebook> = {}): OpenedNotebook {
  return {
    fingerprint: "fp",
    trusted: false,
    kernel: null,
    model: {
      nbformat: 4,
      nbformatMinor: 5,
      language: "python",
      kernelName: null,
      cells: [
        { index: 0, id: "a", kind: "markdown", source: "# Hello", executionCount: null, outputs: [] },
        {
          index: 1,
          id: "b",
          kind: "code",
          source: "print(1)",
          executionCount: 1,
          outputs: [
            { output_type: "stream", name: "stdout", text: "1\n" },
            { output_type: "display_data", data: { "text/html": "<script>x()</script>" } },
          ],
        },
      ],
    },
    ...patch,
  };
}

async function mount(opened: OpenedNotebook) {
  const ipc = createFakeIpc({ notebookOpen: vi.fn().mockResolvedValue(opened) });
  const notebooks = new NotebookService({
    ipc,
    confirm: () => Promise.resolve(null),
    quickPick: () => Promise.resolve(null),
    notice: vi.fn(),
    log: () => undefined,
    autoSave: () => ({ mode: "off", delay: 1000 }),
  });
  harness.current = { notebooks, ipc };
  render(<NotebookView path={PATH} />);
  await screen.findByRole("toolbar", { name: "Notebook" });
  return { ipc, notebooks };
}

describe("NotebookView", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("an untrusted notebook warns, runs nothing and hides HTML output", async () => {
    const { ipc } = await mount(notebook());
    expect(screen.getByText(/This notebook is not trusted/)).toBeInTheDocument();
    expect(screen.getByText("Untrusted")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(screen.getByLabelText("Cell 2 source")).toHaveTextContent("print(1)");
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/HTML output is hidden/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    const run = screen.getByRole("button", { name: "Run cell 2" });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute("title", "Trust this notebook to run its cells.");
    expect(screen.getByRole("button", { name: "Select Kernel" })).toBeDisabled();
    expect(screen.getByText("Kernel not configured")).toBeInTheDocument();
    expect(ipc.notebookExecute).not.toHaveBeenCalled();
  });

  it("a trusted notebook without a kernel says the kernel is missing; trusting is a click", async () => {
    const { ipc } = await mount(notebook({ trusted: true }));
    expect(screen.queryByText(/This notebook is not trusted/)).toBeNull();
    const toolbar = within(screen.getByRole("toolbar", { name: "Notebook" }));
    expect(toolbar.getByRole("button", { name: /Run All/ })).toHaveAttribute(
      "title",
      "Kernel not configured. Install/configure from Runtime Manager.",
    );
    expect(toolbar.getByRole("button", { name: "■ Stop" })).toBeDisabled();
    fireEvent.click(toolbar.getByRole("button", { name: "Stop Trusting" }));
    await screen.findByText(/This notebook is not trusted/);
    expect(ipc.notebookSetTrust).toHaveBeenCalledWith(PATH, false);
  });

  it("a notebook of another language can be read but not run", async () => {
    const opened = notebook({ trusted: true, kernel: "Python" });
    opened.model.language = "R";
    await mount(opened);
    expect(screen.getByText(/This is a R notebook/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run cell 2" })).toHaveAttribute(
      "title",
      expect.stringContaining("Only Python notebooks can run"),
    );
  });
});
