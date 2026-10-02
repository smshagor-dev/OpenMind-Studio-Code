/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LspServerInfo, LspSnapshot } from "../services/ipc";
import type { FileLspStatus } from "../services/lspAvailability";
import { OutputService } from "../services/outputService";
import type { ProblemFile } from "../services/markerService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { LanguageToolsDialog } from "./LanguageToolsDialog";
import { LspStatusItem } from "./LspStatusItem";
import { OutputPanel, ProblemsPanel } from "./PanelViews";

function server(patch: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "typescript",
    name: "TypeScript Language Server",
    languages: ["typescript", "javascript"],
    note: null,
    contents: "typescript-language-server 5.1.3, typescript 5.9.3",
    installed: false,
    runtime: "node",
    bundled: false,
    installSource: null,
    state: "stopped",
    workspace: "C:/My Site",
    node: null,
    capabilities: null,
    openDocuments: 0,
    pid: null,
    canInstall: true,
    installBlocked: null,
    logPath: "C:/app/logs/lsp/typescript.log",
    logExists: false,
    ...patch,
  };
}

function snapshot(servers: LspServerInfo[], patch: Partial<LspSnapshot> = {}): LspSnapshot {
  return {
    workspace: "C:/My Site",
    node: "OpenMind portable Node.js",
    nodeProblem: null,
    bundle: { present: false, problem: null, nodeVersion: null, packs: 0 },
    verbose: false,
    servers,
    ...patch,
  };
}

function fakeLsp(
  state: LspSnapshot,
  file: FileLspStatus = { path: null, server: null, outcome: null },
) {
  const stable = { snapshot: state };
  return {
    subscribe: () => () => undefined,
    getState: () => stable,
    refresh: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(true),
    uninstall: vi.fn().mockResolvedValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    openLog: vi.fn().mockResolvedValue(true),
    setVerbose: vi.fn().mockResolvedValue(undefined),
    activeFileStatus: () => file,
  };
}

describe("Language Tools dialog", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("a missing server says so, names what installing downloads, and Install really installs it", () => {
    const lsp = fakeLsp(snapshot([server()]));
    harness.current = { lsp, run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const card = within(screen.getByRole("region", { name: "TypeScript Language Server" }));
    expect(card.getByText("Missing")).toBeInTheDocument();
    expect(card.getAllByText("Language server is not installed yet.").length).toBeGreaterThan(0);
    expect(card.getByText(/typescript-language-server 5\.1\.3/)).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(card.getByRole("button", { name: "Open Logs" })).toBeDisabled();
    fireEvent.click(card.getByRole("button", { name: "Install" }));
    expect(lsp.install).toHaveBeenCalledWith("typescript");
  });

  it("a bundled server is ready offline: no Missing badge, and Unpack Now needs no download", () => {
    const bundled = server({ bundled: true });
    const lsp = fakeLsp(
      snapshot([bundled], {
        bundle: { present: true, problem: null, nodeVersion: "24.21.0", packs: 8 },
        node: "OpenMind bundled Node.js",
      }),
    );
    harness.current = { lsp, run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    expect(screen.getByTestId("lsp-bundle")).toHaveTextContent(
      "Offline bundle: 8 language server packages and Node.js 24.21.0",
    );
    expect(screen.getByTestId("lsp-bundle")).toHaveTextContent("nothing is downloaded");
    const card = within(screen.getByRole("region", { name: "TypeScript Language Server" }));
    expect(card.getByText("Bundled")).toBeInTheDocument();
    expect(card.queryByText("Missing")).toBeNull();
    expect(card.getByText(/unpacked from the offline bundle/)).toBeInTheDocument();
    expect(card.getByText(/Contains: typescript-language-server/)).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Restart" })).toBeEnabled();
    const unpack = card.getByRole("button", { name: "Unpack Now" });
    expect(unpack).toHaveAttribute("title", expect.stringContaining("no download"));
    fireEvent.click(unpack);
    expect(lsp.install).toHaveBeenCalledWith("typescript");
  });

  it("keeps its notes visible although it reuses the compact runtime cards (which hide theirs)", () => {
    harness.current = { lsp: fakeLsp(snapshot([server()])), run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    expect(screen.getByRole("dialog")).toHaveClass("modal--lsp-tools");
    const css = readFileSync(join(process.cwd(), "src/styles/toolchains.css"), "utf8");
    expect(css).toMatch(
      /\.modal--runtimes\.modal--lsp-tools \.runtime-card__notes \{\s*display: block;/,
    );
  });

  it("fits any window: a fixed header, one scrolling body, wrapping cards and buttons", () => {
    harness.current = { lsp: fakeLsp(snapshot([server()])), run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    const body = screen.getByTestId("lsp-tools-body");
    expect(body).toHaveClass("rm-body");
    expect(dialog.querySelector(".rm-head h2")?.textContent).toBe("Language Tools");
    // The cards and the footer scroll with the body; Close stays outside it.
    expect(body.querySelector(".runtimes__list")).not.toBeNull();
    expect(body.querySelector(".lsp-footer")).not.toBeNull();
    expect(body.contains(screen.getByRole("button", { name: "Close" }))).toBe(false);
    const css = readFileSync(join(process.cwd(), "src/styles/toolchains.css"), "utf8");
    expect(css).toMatch(/\.modal-overlay:has\(> \.modal--lsp-tools\)/);
    expect(css).toMatch(/\.modal--lsp-tools \.runtime-card__install \{\s*flex-wrap: wrap;/);
    expect(css).toMatch(/@media \(max-height: 520px\)/);
    // The dialog loads the stylesheet itself (it is a lazy chunk that may open before the Runtime Manager).
    const source = readFileSync(join(process.cwd(), "src/components/LanguageToolsDialog.tsx"), "utf8");
    expect(source).toContain('import "../styles/toolchains.css";');
  });

  it("a copy without the bundle says so, and a native server without it says why it can't install", () => {
    const native = server({
      id: "rust",
      name: "rust-analyzer",
      runtime: "native",
      contents: "rust-analyzer 2026-09-21",
      canInstall: false,
      installBlocked:
        "rust-analyzer ships only in OpenMind Studio's offline LSP bundle, which this copy doesn't have.",
    });
    harness.current = { lsp: fakeLsp(snapshot([native])), run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    expect(screen.getByTestId("lsp-bundle")).toHaveTextContent(
      "This copy has no offline language server bundle.",
    );
    const card = within(screen.getByRole("region", { name: "rust-analyzer" }));
    expect(card.getByText(/runs on its own program/)).toBeInTheDocument();
    expect(
      card.getByText(/ships only in OpenMind Studio's offline LSP bundle/),
    ).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Install" })).toBeDisabled();
  });

  it("fortls is installed with pip and says it runs on Python, not Node.js", () => {
    const fortls = server({
      id: "fortran",
      name: "fortls",
      languages: ["fortran"],
      runtime: "pythonModule",
      contents: "fortls 3.2.2",
    });
    harness.current = { lsp: fakeLsp(snapshot([fortls])), run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const card = within(screen.getByRole("region", { name: "fortls" }));
    expect(card.getByText("Installs: fortls 3.2.2 · runs on Python")).toBeInTheDocument();
    expect(card.queryByText(/Node\.js/)).toBeNull();
  });

  it("a downloaded fortls can be removed; a bundled server has no Remove button", () => {
    const fortls = server({
      id: "fortran",
      name: "fortls",
      languages: ["fortran"],
      runtime: "pythonModule",
      contents: "fortls 3.2.2",
      installed: true,
      installSource: "download",
      python: "OpenMind portable Python 3.14.7",
      pythonIsSystem: false,
    });
    const bundled = server({ installed: true, installSource: "bundle", bundled: true });
    const lsp = fakeLsp(snapshot([fortls, bundled]));
    harness.current = { lsp, run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const card = within(screen.getByRole("region", { name: "fortls" }));
    expect(card.getByTestId("lsp-python")).toHaveTextContent("Python: OpenMind portable Python 3.14.7.");
    fireEvent.click(card.getByRole("button", { name: "Remove" }));
    expect(lsp.uninstall).toHaveBeenCalledWith("fortran");
    const other = within(screen.getByRole("region", { name: "TypeScript Language Server" }));
    expect(other.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("says plainly when fortls would use the system Python, and offers OpenMind's own", () => {
    const fortls = server({
      id: "fortran",
      name: "fortls",
      languages: ["fortran"],
      runtime: "pythonModule",
      contents: "fortls 3.2.2",
      python: "System Python at C:/Python314/python.exe",
      pythonIsSystem: true,
    });
    const run = vi.fn();
    harness.current = { lsp: fakeLsp(snapshot([fortls])), run };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const note = within(screen.getByRole("region", { name: "fortls" })).getByTestId("lsp-python");
    expect(note).toHaveTextContent("Uses System Python at C:/Python314/python.exe, because OpenMind's portable Python isn't installed.");
    expect(note).toHaveTextContent("that Python, its packages and your pip settings are not changed");
    fireEvent.click(within(note).getByRole("button", { name: "Install OpenMind Python" }));
    expect(run).toHaveBeenCalledWith("runtime.manage");
  });

  it("without Node.js, Install is disabled and the reason is written out", () => {
    const blocked = server({
      canInstall: false,
      installBlocked: "Node.js runtime is not installed yet.",
    });
    harness.current = {
      lsp: fakeLsp(
        snapshot([blocked], { node: null, nodeProblem: "Node.js runtime is not installed yet." }),
      ),
      run: vi.fn(),
    };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const card = within(screen.getByRole("region", { name: "TypeScript Language Server" }));
    expect(card.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(card.getByRole("button", { name: "Install" })).toHaveAttribute(
      "title",
      "Node.js runtime is not installed yet.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Node.js runtime is not installed yet.");
  });

  it("an installing server shows the real state and can't be installed twice", () => {
    harness.current = {
      lsp: fakeLsp(
        snapshot([
          server({
            state: "installing",
            canInstall: false,
            installBlocked: "It is already installing.",
          }),
        ]),
      ),
      run: vi.fn(),
    };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    expect(screen.getAllByText("Installing…").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  });

  it("a running server shows its pid and Node, and Restart, Stop and Open Logs work", () => {
    const lsp = fakeLsp(
      snapshot([
        server({
          installed: true,
          state: "running",
          pid: 4242,
          openDocuments: 2,
          node: "OpenMind portable Node.js",
          logExists: true,
        }),
      ]),
    );
    harness.current = { lsp, run: vi.fn() };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    const card = within(screen.getByRole("region", { name: "TypeScript Language Server" }));
    expect(card.getByText("Running")).toBeInTheDocument();
    expect(
      card.getByText(/pid 4242 · 2 open files · OpenMind portable Node\.js/),
    ).toBeInTheDocument();
    fireEvent.click(card.getByRole("button", { name: "Restart" }));
    expect(lsp.restart).toHaveBeenCalledWith("typescript");
    fireEvent.click(card.getByRole("button", { name: "Stop" }));
    expect(lsp.stop).toHaveBeenCalledWith("typescript");
    fireEvent.click(card.getByRole("button", { name: "Open Logs" }));
    expect(lsp.openLog).toHaveBeenCalledWith("typescript");
  });

  it("a crashed server shows why, and Restart is offered", () => {
    harness.current = {
      lsp: fakeLsp(
        snapshot([
          server({
            installed: true,
            state: "error",
            message: "The language server stopped unexpectedly.",
          }),
        ]),
      ),
      run: vi.fn(),
    };
    render(<LanguageToolsDialog onClose={() => undefined} />);
    expect(screen.getByText("The language server stopped unexpectedly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
  });

  it("no open folder is said out loud; Open LSP Output runs the command", () => {
    const run = vi.fn();
    harness.current = { lsp: fakeLsp(snapshot([server()], { workspace: null })), run };
    const onClose = vi.fn();
    render(<LanguageToolsDialog onClose={onClose} />);
    expect(screen.getByText("Open a folder to start language servers.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open LSP Output" }));
    expect(run).toHaveBeenCalledWith("lsp.openOutput");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("status bar language server item", () => {
  it("shows the server for a supported file, the reason when there is none, and nothing for other files", () => {
    const run = vi.fn();
    const ready: FileLspStatus = {
      path: "C:/My Site/a.ts",
      server: server({ installed: true, state: "running" }),
      outcome: { state: "ready", server: "typescript" },
    };
    harness.current = { lsp: fakeLsp(snapshot([]), ready), run };
    const { unmount } = render(<LspStatusItem />);
    expect(screen.getByRole("button")).toHaveTextContent("TypeScript Language Server");
    unmount();

    harness.current = {
      lsp: fakeLsp(snapshot([]), {
        path: "C:/My Site/a.ts",
        server: server(),
        outcome: { state: "notInstalled", server: "typescript" },
      }),
      run,
    };
    const missing = render(<LspStatusItem />);
    expect(screen.getByRole("button")).toHaveTextContent("Language server is not installed yet.");
    fireEvent.click(screen.getByRole("button"));
    expect(run).toHaveBeenCalledWith("lsp.manage");
    missing.unmount();

    harness.current = {
      lsp: fakeLsp(snapshot([]), { path: "C:/My Site/notes.txt", server: null, outcome: null }),
      run,
    };
    const { container } = render(<LspStatusItem />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Problems panel with language server diagnostics", () => {
  const files: ProblemFile[] = [
    {
      uri: "inmemory://model/1",
      title: "app.py",
      path: "C:/My Site/app.py",
      problems: [
        {
          severity: "error",
          message: "Undefined name",
          source: "Pyright",
          line: 3,
          column: 5,
          endLine: 3,
          endColumn: 9,
        },
        {
          severity: "warning",
          message: "Unused import",
          source: "Pyright",
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 7,
        },
        {
          severity: "info",
          message: "Consider a type",
          source: null,
          line: 8,
          column: 2,
          endLine: 8,
          endColumn: 3,
        },
        {
          severity: "hint",
          message: "Could be simpler",
          source: null,
          line: 9,
          column: 1,
          endLine: 9,
          endColumn: 4,
        },
      ],
    },
    {
      uri: "inmemory://model/2",
      title: "index.php",
      path: "C:/My Site/index.php",
      problems: [
        {
          severity: "error",
          message: "Syntax error",
          source: "intelephense",
          line: 2,
          column: 1,
          endLine: 2,
          endColumn: 2,
        },
      ],
    },
  ];

  function markers(list: ProblemFile[]) {
    return { subscribe: () => () => undefined, getProblemFiles: () => list };
  }

  it("says so when there are no problems", () => {
    harness.current = { markers: markers([]), workspace: { openProblemAt: vi.fn() } };
    render(<ProblemsPanel />);
    expect(
      screen.getByText("No problems have been detected in the workspace."),
    ).toBeInTheDocument();
  });

  it("groups problems by file, labels every severity, and shows the count per file", () => {
    harness.current = { markers: markers(files), workspace: { openProblemAt: vi.fn() } };
    render(<ProblemsPanel />);
    const app = screen.getByTitle("C:/My Site/app.py").closest("li");
    expect(app).not.toBeNull();
    const inApp = within(app as HTMLElement);
    expect(inApp.getByText("4")).toBeInTheDocument();
    expect(inApp.getByText(/^Error \[Ln 3, Col 5\]/)).toBeInTheDocument();
    expect(inApp.getByText(/^Warning \[Ln 1, Col 1\]/)).toBeInTheDocument();
    expect(inApp.getByText(/^Info \[Ln 8, Col 2\]/)).toBeInTheDocument();
    expect(inApp.getByText(/^Hint \[Ln 9, Col 1\]/)).toBeInTheDocument();
    expect(screen.getByTitle("C:/My Site/index.php")).toBeInTheDocument();
  });

  it("clicking a problem opens its file at the location", () => {
    const openProblemAt = vi.fn(() => true);
    harness.current = { markers: markers(files), workspace: { openProblemAt } };
    render(<ProblemsPanel />);
    fireEvent.click(screen.getByText("Undefined name"));
    expect(openProblemAt).toHaveBeenCalledWith("inmemory://model/1", {
      line: 3,
      column: 5,
      length: 4,
    });
    fireEvent.click(screen.getByText("Syntax error"));
    expect(openProblemAt).toHaveBeenLastCalledWith("inmemory://model/2", {
      line: 2,
      column: 1,
      length: 1,
    });
  });

  it("a problem in a file that isn't open (a task's) opens the file by its path", () => {
    const openProblemAt = vi.fn(() => false);
    const openPathAt = vi.fn(() => Promise.resolve(null));
    harness.current = { markers: markers(files), workspace: { openProblemAt, openPathAt } };
    render(<ProblemsPanel />);
    fireEvent.click(screen.getByText("Undefined name"));
    expect(openPathAt).toHaveBeenCalledWith(expect.stringContaining("C:/My Site/"), { line: 3, column: 5, length: 4 });
  });
});

describe("LSP output channel", () => {
  it("shows the server's lines in the LSP channel", () => {
    const output = new OutputService();
    output.append("LSP", "[typescript] TypeScript Language Server started (pid 1).");
    output.append("LSP", "[typescript] error: The language server stopped unexpectedly.");
    output.select("LSP");
    harness.current = { output };
    render(<OutputPanel />);
    const body = screen.getByLabelText("LSP output");
    expect(body).toHaveTextContent("[typescript] TypeScript Language Server started (pid 1).");
    expect(body).toHaveTextContent("error: The language server stopped unexpectedly.");
  });

  it("an empty LSP channel says nothing has happened yet", () => {
    const output = new OutputService();
    output.select("LSP");
    harness.current = { output };
    render(<OutputPanel />);
    expect(screen.getByText("No output in “LSP” yet.")).toBeInTheDocument();
  });
});
