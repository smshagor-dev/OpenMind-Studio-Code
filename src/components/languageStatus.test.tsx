import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  commandStatus,
  fileStatus,
  formatOption,
  language,
  languageRig,
  projectStatus,
  tool,
  workspaceStatus,
} from "../testUtils/languageFixtures";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { gitWithVersions, packs, toolEntry } from "../testUtils/toolchainFixtures";
import { LanguageUiService } from "../services/language/languageWiring";
import { ToolchainService } from "../services/toolchains/toolchainService";
import type { ToolEntry } from "../services/toolchains/toolchainIpc";
import type { LspServerInfo } from "../services/ipc";
import type { ProjectStatus } from "../services/language/languageIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { LanguageStatusDialog } from "./language/LanguageStatusDialog";
import { LanguageStatusItem } from "./language/LanguageStatusItem";

const LSP_STATE = { snapshot: null };

function server(overrides: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "typescript",
    name: "TypeScript Language Server",
    languages: ["typescript"],
    note: null,
    contents: "typescript-language-server",
    installed: false,
    runtime: "node",
    bundled: false,
    installSource: null,
    state: "stopped",
    workspace: null,
    node: null,
    capabilities: null,
    openDocuments: 0,
    pid: null,
    canInstall: true,
    installBlocked: null,
    logPath: "",
    logExists: false,
    ...overrides,
  };
}

async function mount(
  options: {
    projects?: ProjectStatus[];
    servers?: LspServerInfo[];
    activePath?: string | null;
    file?: ReturnType<typeof fileStatus>;
    bundled?: ToolEntry[];
  } = {},
) {
  const rig = languageRig({ workspace: workspaceStatus(options.projects ?? [projectStatus()]) });
  await rig.support.initialize();
  await rig.support.refresh();
  const activePath =
    options.activePath === undefined ? "C:/My Project/src/a.ts" : options.activePath;
  if (activePath !== null) {
    vi.mocked(rig.ipc.languageFileStatus).mockResolvedValue(options.file ?? fileStatus());
    await rig.support.lookUpFile(activePath);
  }
  const ui = new LanguageUiService();
  const run = vi.fn();
  harness.current = {
    language: {
      support: rig.support,
      projects: rig.projects,
      ui,
      activeText: () =>
        activePath === null ? null : { docId: "d1", dirty: false, path: activePath },
    },
    lsp: {
      subscribe: () => () => undefined,
      getState: () => LSP_STATE,
      servers: () => options.servers ?? [],
    },
    toolchains: new ToolchainService(
      createFakeIpc({
        toolchainsList: vi.fn().mockResolvedValue(packs(options.bundled ?? [])),
      }),
    ),
    run,
  };
  return { rig, ui, run };
}

beforeEach(() => {
  harness.current = null;
});

describe("LanguageStatusItem", () => {
  it("shows the detected project in the status bar and opens the status window on click", async () => {
    const { run } = await mount();
    render(<LanguageStatusItem />);
    const item = screen.getByRole("button", { name: "Vite + React" });
    fireEvent.click(item);
    expect(run).toHaveBeenCalledWith("language.showStatus");
  });

  it("says when nothing was detected, and shows nothing without a folder", async () => {
    await mount({ projects: [] });
    const { unmount } = render(<LanguageStatusItem />);
    expect(screen.getByRole("button", { name: "No project detected" })).toBeInTheDocument();
    unmount();
    const none = languageRig({ hasWorkspace: false });
    harness.current = { ...(harness.current as object), language: { support: none.support } };
    const { container } = render(<LanguageStatusItem />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("LanguageStatusDialog", () => {
  it("renders nothing while closed", async () => {
    await mount();
    render(<LanguageStatusDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the detected project with its framework chips, tools and notes", async () => {
    const { ui } = await mount({
      projects: [
        projectStatus({
          notes: [
            "Mobile projects need their own SDK; OpenMind doesn't manage emulators or devices.",
          ],
        }),
      ],
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    const dialog = screen.getByRole("dialog", { name: "Project & Language Status" });
    const project = within(dialog).getByRole("region", { name: "Vite + React" });
    expect(
      within(project).getByText(/Detected Vite \+ React\. Found: Node\.js, pnpm/),
    ).toBeInTheDocument();
    const chips = within(project).getByLabelText("Detected");
    expect(within(chips).getByText("Vite · Certain")).toHaveAttribute(
      "title",
      "vite.config.ts exists",
    );
    expect(within(chips).getByText("React · Likely")).toBeInTheDocument();
    expect(within(project).getAllByText(/Found in the system PATH/).length).toBeGreaterThan(0);
    expect(within(project).getByText(/emulators or devices/)).toBeInTheDocument();
  });

  it("lists the command buttons by category, enabled when the tools exist", async () => {
    const { ui, rig } = await mount({
      projects: [
        projectStatus({
          commandStatus: [
            commandStatus(),
            commandStatus({
              id: "node.script.build",
              label: "pnpm run build",
              category: "build",
              argv: ["pnpm", "run", "build"],
            }),
          ],
        }),
      ],
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    const dev = screen.getByRole("group", { name: "Dev" });
    const button = within(dev).getByRole("button", { name: "pnpm run dev" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "pnpm run dev");
    expect(screen.getByRole("group", { name: "Build" })).toBeInTheDocument();
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
    fireEvent.click(button);
    await vi.waitFor(() => {
      expect(rig.terminal.write).toHaveBeenCalledWith("t1", "pnpm run dev\r");
    });
    expect(rig.terminal.createTerminal).toHaveBeenCalledWith(undefined, "C:/My Project");
  });

  it("disables a command whose tool is missing and prints the reason, and never runs it", async () => {
    const missing = commandStatus({
      id: "tauri.dev",
      label: "pnpm tauri dev",
      argv: ["pnpm", "tauri", "dev"],
      available: false,
      reason: "Cargo not found. Install Rust (rustup) — OpenMind doesn't install it.",
      missing: ["cargo"],
    });
    const { ui, rig } = await mount({
      projects: [
        projectStatus({
          title: "Tauri + React",
          commandStatus: [missing],
          toolStatus: [
            tool("node", true),
            tool("cargo", false, "Install Rust (rustup) — OpenMind doesn't install it."),
          ],
        }),
      ],
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    const button = screen.getByRole("button", { name: "pnpm tauri dev" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", missing.reason);
    const reasons = screen.getByRole("list", { name: "Unavailable commands" });
    expect(within(reasons).getByText(/Cargo not found/)).toBeInTheDocument();
    expect(screen.getAllByText(/Not found\. Install Rust \(rustup\)/).length).toBeGreaterThan(0);
    fireEvent.click(button);
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
  });

  it("shows the iOS-needs-macOS limit and the Flutter SDK missing status", async () => {
    const { ui } = await mount({
      projects: [
        projectStatus({
          title: "Flutter",
          notes: [
            "iOS builds require macOS and Xcode; on this computer OpenMind only shows the project.",
          ],
          toolStatus: [
            tool(
              "flutter",
              false,
              "Install the Flutter SDK from flutter.dev — OpenMind doesn't install it.",
            ),
          ],
          commandStatus: [
            commandStatus({
              id: "flutter.run",
              label: "Run (flutter run)",
              category: "run",
              argv: ["flutter", "run"],
              available: false,
              reason:
                "Flutter SDK not found. Install the Flutter SDK from flutter.dev — OpenMind doesn't install it.",
            }),
            commandStatus({
              id: "ios.list",
              label: "List Xcode schemes (xcodebuild -list)",
              category: "build",
              available: false,
              reason: "iOS builds require macOS and Xcode.",
            }),
          ],
        }),
      ],
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(screen.getAllByText(/iOS builds require macOS and Xcode/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Flutter SDK not found/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "List Xcode schemes (xcodebuild -list)" }),
    ).toBeDisabled();
  });

  it("warns about an ambiguous project and lists every candidate", async () => {
    const { ui } = await mount({
      projects: [
        projectStatus({
          title: "FastAPI + Flask",
          ambiguous: true,
          detections: [
            {
              id: "fastapi",
              name: "FastAPI",
              group: "backend",
              confidence: "medium",
              evidence: "the Python manifest mentions fastapi",
            },
            {
              id: "flask",
              name: "Flask",
              group: "backend",
              confidence: "medium",
              evidence: "the Python manifest mentions flask",
            },
          ],
          commandStatus: [],
        }),
      ],
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(screen.getByText(/could be more than one thing/)).toBeInTheDocument();
    expect(screen.getByText("FastAPI · Likely")).toBeInTheDocument();
    expect(screen.getByText("Flask · Likely")).toBeInTheDocument();
    expect(screen.getByText("No commands are known for this project.")).toBeInTheDocument();
  });

  it("says the language support is built in and the missing tools are the user's to set up", async () => {
    const { ui } = await mount();
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(
      screen.getByText(
        /Language support metadata is built in\. Missing tools must be installed\/configured separately\./,
      ),
    ).toBeTruthy();
  });

  it("shows the bundled Git, Composer and Python debugger, or that none is bundled and what to do", async () => {
    const { ui } = await mount({
      bundled: [
        gitWithVersions(),
        toolEntry({ id: "composer", name: "Composer", category: "packageManager" }),
        toolEntry({ id: "debugpy", name: "Python debugger (debugpy)", category: "debugger" }),
      ],
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    const dialog = screen.getByRole("dialog", { name: "Project & Language Status" });
    expect(
      await within(dialog).findByText(/Active 2\.47\.1 — bundled with OpenMind Studio/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Nothing bundled\. Not bundled in this build/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /No debugger bundled\. Python debugging uses the debugger from the Runtime Manager/,
      ),
    ).toBeInTheDocument();
  });

  it("says Unknown project type when the folder has no project", async () => {
    const { ui } = await mount({ projects: [] });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(
      screen.getByText(/No project detected in this folder \(Unknown project type\)/),
    ).toBeInTheDocument();
  });

  it("shows the current file's language, support levels and tools — with LSP not configured spelled out", async () => {
    const { ui } = await mount({
      servers: [server()],
      file: fileStatus({
        lsp: [
          {
            tool: "typescript-language-server",
            name: "TypeScript Language Server",
            builtin: "typescript",
            found: null,
            note: "",
          },
        ],
        formatters: [formatOption()],
        linters: [
          formatOption({
            tool: "eslint",
            name: "ESLint",
            kind: "lint",
            found: null,
            argv: [],
            hint: "Add it to the project (`npm i -D eslint`).",
          }),
        ],
      }),
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    const levels = screen.getByLabelText("Support levels");
    expect(within(levels).getByText("Language server")).toBeInTheDocument();
    expect(within(levels).getByText("Formatting")).toBeInTheDocument();
    expect(
      screen.getByText(/LSP not configured: install it from Language Tools/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Found in the project's own copy/)).toBeInTheDocument();
    expect(
      screen.getByText(/Not found\. Add it to the project \(`npm i -D eslint`\)/),
    ).toBeInTheDocument();
  });

  it("says a language server OpenMind can't start is not something it can use", async () => {
    const { ui } = await mount({
      file: fileStatus({
        path: "C:/My Project/main.rs",
        language: { ...language("typescript"), id: "rust", name: "Rust" },
        lsp: [
          {
            tool: "rust-analyzer",
            name: "rust-analyzer",
            builtin: null,
            found: null,
            note: "Not found. Add it with `rustup component add rust-analyzer`. OpenMind can't start this language server yet.",
          },
        ],
        formatters: [],
      }),
      activePath: "C:/My Project/main.rs",
    });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(screen.getByText(/OpenMind can't start this language server yet/)).toBeInTheDocument();
    expect(screen.getByText("No formatter is known for this language.")).toBeInTheDocument();
  });

  it("explains itself when no saved text file is open, and closes with Close", async () => {
    const { ui } = await mount({ activePath: null });
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    expect(screen.getByText(/Open a saved text file to see its language/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(ui.isOpen()).toBe(false);
  });

  it("lists the toolchains on this computer, found or missing", async () => {
    const { ui } = await mount();
    ui.setOpen(true);
    render(<LanguageStatusDialog />);
    const heading = screen.getByRole("heading", { name: "Tools on this computer" });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByText("Node.js").length).toBeGreaterThan(0);
    expect(screen.getByText("cargo")).toBeInTheDocument();
  });
});
