import { toolchainsFrom } from "../../testUtils/canonicalFeeds";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { gitWithVersions, packs, toolEntry } from "../../testUtils/toolchainFixtures";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { ToolsPanel } from "./ToolsPanel";

const PYTHON_LONG =
  "debugpy is the debug adapter behind Run and Debug for Python. It runs on the active Python. Several versions can be kept; the active one is used when you start debugging.";


/** The Language Tools tab also lists language servers; these tests are about the bundled tools. */
const NO_SERVERS = {
  subscribe: () => () => undefined,
  getState: () => NO_SERVERS_STATE,
  servers: () => [],
  isInstalling: () => false,
  install: () => Promise.resolve(false),
  uninstall: () => Promise.resolve(false),
  refresh: () => Promise.resolve(),
};
const NO_SERVERS_STATE = { snapshot: null };
const INSTALL_STATE = { busy: [] };
const RUNTIME_STATE = { runtimes: [] };
const INSTALL_STUBS = {
  toolInstall: {
    subscribe: () => () => undefined,
    getState: () => INSTALL_STATE,
    isBusy: () => false,
    install: () => Promise.resolve(false),
    remove: () => Promise.resolve(false),
  },
  runtime: { subscribe: () => () => undefined, getState: () => RUNTIME_STATE },
};

function tools() {
  return [
    gitWithVersions(),
    toolEntry({
      id: "prettier",
      name: "Prettier",
      category: "formatter",
      summary: "Code formatter for web languages.",
    }),
    toolEntry({
      id: "debugpy",
      name: "Python debugger (debugpy)",
      category: "debugger",
      summary: "Debug adapter for Python.",
      details: PYTHON_LONG,
    }),
    toolEntry({
      id: "flutter-sdk",
      name: "Flutter SDK",
      category: "sdk",
      status: "external",
      summary: "Flutter and Dart SDK.",
      hint: "Install the Flutter SDK from flutter.dev — OpenMind doesn't install it.",
    }),
    toolEntry({
      id: "docker",
      name: "Docker",
      category: "helperTool",
      status: "external",
      hint: "Install Docker — OpenMind doesn't install it.",
    }),
    toolEntry({
      id: "eslint",
      name: "ESLint",
      category: "linter",
      status: "broken",
      versions: [],
    }),
  ];
}

async function mount(list = tools(), overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({
    toolchainsList: vi.fn().mockResolvedValue(packs(list)),
    ...overrides,
  });
  const toolchains = toolchainsFrom(ipc);
  harness.current = { toolchains, lsp: NO_SERVERS, ...INSTALL_STUBS };
  render(<ToolsPanel />);
  await screen.findByRole("region", { name: "Version Control" });
  return { ipc, toolchains };
}

describe("ToolsPanel", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("groups the tools into named sections", async () => {
    await mount();
    for (const name of [
      "Formatters",
      "Linters",
      "Debuggers",
      "Version Control",
      "Mobile/Desktop SDKs",
      "External Required",
    ]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    const external = screen.getByRole("region", { name: "External Required" });
    expect(within(external).getByText("Docker")).toBeInTheDocument();
    const sdks = screen.getByRole("region", { name: "Mobile/Desktop SDKs" });
    expect(within(sdks).getByText("Flutter SDK")).toBeInTheDocument();
  });

  it("shows the active version, an honest version count and a status chip on a card", async () => {
    await mount();
    const git = screen.getByRole("article", { name: "Git" });
    expect(within(git).getByText("Active")).toHaveClass("tc-chip--ok");
    expect(within(git).getByText("Active 2.47.1")).toBeInTheDocument();
    expect(within(git).getByText("2 versions available (up to 5 kept)")).toBeInTheDocument();
    // The long path is shortened in the middle; the whole path is its tooltip.
    const path = within(git).getByTitle("C:/Apps/OpenMind Studio/tools/git/2.47.1/cmd/git.exe");
    expect(path.textContent).toContain("…");
    expect(path.textContent.endsWith("git.exe")).toBe(true);
  });

  it("marks Missing, Broken and External tools, with their setup line, and never as active", async () => {
    await mount();
    const prettier = screen.getByRole("article", { name: "Prettier" });
    expect(within(prettier).getByText("Missing")).toHaveClass("tc-chip--warn");
    // Missing tools can now be installed from here.
    expect(within(prettier).getByText(/Install downloads it into OpenMind Studio's tools folder/)).toBeInTheDocument();
    expect(within(prettier).getByRole("button", { name: "Install" })).toBeEnabled();
    expect(within(screen.getByRole("article", { name: "ESLint" })).getByText("Broken")).toHaveClass(
      "tc-chip--error",
    );
    // An SDK the Runtime Manager provides is installed from here too.
    const flutter = screen.getByRole("article", { name: "Flutter SDK" });
    expect(within(flutter).getByText("Missing")).toHaveClass("tc-chip--warn");
    expect(within(flutter).getByText(/Installs flutter with the Runtime Manager/)).toBeInTheDocument();
    expect(within(flutter).getByRole("button", { name: "Install" })).toBeEnabled();
    // Nothing without a program on disk offers Verify.
    expect(within(flutter).getByRole("button", { name: "Verify" })).toBeDisabled();
    expect(within(prettier).getByRole("button", { name: "Verify" })).toBeDisabled();
  });

  it("keeps card text short: the summary carries its full text as a tooltip and the long text is in Details", async () => {
    await mount();
    const card = screen.getByRole("article", { name: "Python debugger (debugpy)" });
    const summary = within(card).getByText("Debug adapter for Python.");
    expect(summary).toHaveClass("tc-card__summary");
    expect(summary).toHaveAttribute("title", "Debug adapter for Python.");
    expect(within(card).queryByText(/Several versions can be kept/)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Python debugger (debugpy)" });
    expect(within(dialog).getByText(PYTHON_LONG)).toBeInTheDocument();
    expect(within(dialog).getByText("Not bundled")).toBeInTheDocument();
  });

  it("lists every version in the details, with the missing one flagged and unselectable", async () => {
    await mount();
    const git = screen.getByRole("article", { name: "Git" });
    fireEvent.click(within(git).getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Git" });
    expect(within(dialog).getByText("Versions (3 of up to 5)")).toBeInTheDocument();
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[2] as HTMLElement).getByText("Broken")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByRole("button", { name: "Use" })).toBeDisabled();
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "Use" })).toBeEnabled();
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Use" })).toBeDisabled();
    expect(within(dialog).getByText("GPL-2.0")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Git" })).toBeNull();
    });
  });

  it("switches the active version from the selector", async () => {
    const chosen = gitWithVersions();
    const { ipc } = await mount(tools(), {
      toolchainsSetActive: vi
        .fn()
        .mockResolvedValue(packs([{ ...chosen, activeVersion: "2.46.2" }])),
    });
    const git = screen.getByRole("article", { name: "Git" });
    const select = within(git).getByRole("combobox", { name: "Git version" });
    expect(select).toHaveValue("2.47.1");
    expect(within(select).getByRole("option", { name: /2\.45\.0/ })).toBeDisabled();
    fireEvent.change(select, { target: { value: "2.46.2" } });
    await waitFor(() => {
      expect(ipc.toolchainsSetActive).toHaveBeenCalledWith("git", "2.46.2");
    });
  });

  it("verifies on a click and shows the answer on the card", async () => {
    const { ipc } = await mount(tools(), {
      toolchainsVerify: vi.fn().mockResolvedValue({
        ok: true,
        message: "It ran and answered.",
        executed: true,
        output: "git version 2.47.1",
      }),
    });
    expect(ipc.toolchainsVerify).not.toHaveBeenCalled();
    const git = screen.getByRole("article", { name: "Git" });
    fireEvent.click(within(git).getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Verified: It ran and answered\./)).toBeInTheDocument();
  });

  it("shows the manifest problems instead of hiding them", async () => {
    const ipc = createFakeIpc({
      toolchainsList: vi.fn().mockResolvedValue(
        packs(tools(), {
          manifestError: "the toolchain manifest is not valid JSON: eof",
          warnings: ["Git: 7 is more than 5 versions; the 2 oldest are ignored."],
        }),
      ),
    });
    harness.current = { toolchains: toolchainsFrom(ipc), lsp: NO_SERVERS, ...INSTALL_STUBS };
    render(<ToolsPanel />);
    expect(
      await screen.findByText(
        /tools\/toolchains\.json was ignored: the toolchain manifest is not valid JSON/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/the 2 oldest are ignored/)).toBeInTheDocument();
  });

  it("says nothing is bundled when nothing is, and states the no-download rule", async () => {
    const list = [
      toolEntry({ id: "git" }),
      toolEntry({ id: "flutter-sdk", name: "Flutter SDK", category: "sdk", status: "external" }),
    ];
    const ipc = createFakeIpc({ toolchainsList: vi.fn().mockResolvedValue(packs(list)) });
    harness.current = { toolchains: toolchainsFrom(ipc), lsp: NO_SERVERS, ...INSTALL_STUBS };
    render(<ToolsPanel />);
    expect(await screen.findByText("No tools bundled")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is downloaded here and your system PATH is never changed/),
    ).toBeInTheDocument();
  });
});
