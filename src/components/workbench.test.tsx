import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { SearchOutcome } from "../services/ipc";
import { LayoutService } from "../services/layoutService";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { PortsService } from "../services/portsService";
import { SearchService } from "../services/searchService";
import { TerminalService } from "../services/terminalService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
vi.mock("./XtermHost", () => ({ XtermHost: () => <div /> }));
vi.mock("../editor/MonacoHost", () => ({ MonacoHost: () => <div data-testid="monaco" /> }));

import { ActivityBar } from "./ActivityBar";
import { BottomPanel } from "./BottomPanel";
import { MarkdownPreview } from "./MarkdownPreview";
import { MenuPopup, type PopupItem } from "./MenuPopup";
import { SearchView } from "./SearchView";

const FAKE_PROBLEMS = {
  files: [] as unknown[],
  listeners: new Set<() => void>(),
};

function setup(overrides: { searchOutcome?: SearchOutcome; content?: string } = {}) {
  const ipc = createFakeIpc({
    searchRun: vi.fn().mockResolvedValue(
      overrides.searchOutcome ?? {
        files: [],
        totalMatches: 0,
        filesSearched: 0,
        skippedBinary: 0,
        skippedLarge: 0,
        truncated: false,
        cancelled: false,
        durationMs: 1,
      },
    ),
  });
  const events = new EventBus<AppEvents>();
  const layout = new LayoutService(ipc);
  const panel = new PanelService(ipc);
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const terminal = new TerminalService(ipc, events, () => null, panel);
  const openPathAt = vi.fn().mockResolvedValue("tab");
  const search = new SearchService(ipc, events, output, () => "C:/p", { openPathAt });
  const commands = new CommandRegistry();
  commands.register("runtime.manage", () => undefined);
  commands.register("php.openWindow", () => undefined);
  commands.register("output.clear", () => {
    output.clear(output.getState().selected);
  });
  const run = vi.fn((id: string, ...args: unknown[]) => {
    void commands.execute(id, ...args);
  });
  const followLink = vi.fn().mockResolvedValue(undefined);
  const documents = {
    has: () => true,
    contentOf: () => overrides.content ?? "",
    onDidChangeContent: () => () => undefined,
  };
  harness.current = {
    ipc,
    events,
    layout,
    panel,
    output,
    ports,
    terminal,
    search,
    run,
    documents,
    markdown: { followLink },
    markers: {
      subscribe: (listener: () => void) => {
        FAKE_PROBLEMS.listeners.add(listener);
        return () => FAKE_PROBLEMS.listeners.delete(listener);
      },
      getCounts: () => ({ errors: 0, warnings: 0 }),
      getProblemFiles: () => FAKE_PROBLEMS.files,
    },
    workspace: { openProblemAt: vi.fn() },
  };
  return { ipc, layout, panel, output, ports, search, run, openPathAt, followLink };
}

describe("ActivityBar", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("lists every view plus Runtime Manager, and the unavailable ones are disabled with a reason", () => {
    setup();
    render(<ActivityBar sidebarVisible />);

    for (const name of [
      "Explorer",
      "Search",
      "Source Control",
      "Run and Debug",
      "Extensions",
      "PHP Server",
      "Runtime Manager",
    ]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    const remote = screen.getByRole("button", { name: "Remote Explorer" });
    expect(remote).toBeDisabled();
    expect(remote).toHaveAttribute("title", expect.stringContaining("isn't available"));
  });

  it("switches the side bar view, and clicking the active view's icon hides the side bar", async () => {
    const { layout } = setup();
    const { rerender } = render(<ActivityBar sidebarVisible />);
    expect(screen.getByRole("button", { name: "Explorer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(layout.getState().activeView).toBe("search");
    });
    rerender(<ActivityBar sidebarVisible />);
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Explorer" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(layout.getState().sidebarVisible).toBe(false);
    });
  });

  it("PHP Server opens its own window and leaves the side bar view alone", () => {
    const { layout, run } = setup();
    render(<ActivityBar sidebarVisible />);

    fireEvent.click(screen.getByRole("button", { name: "PHP Server" }));

    expect(run).toHaveBeenCalledWith("php.openWindow");
    expect(layout.getState().activeView).toBe("explorer");
  });

  it("Runtime Manager opens the runtime dialog through its command", () => {
    const { run } = setup();
    render(<ActivityBar sidebarVisible />);

    fireEvent.click(screen.getByRole("button", { name: "Runtime Manager" }));

    expect(run).toHaveBeenCalledWith("runtime.manage");
  });
});

describe("BottomPanel", () => {
  beforeEach(() => {
    harness.current = null;
    FAKE_PROBLEMS.files = [];
  });

  it("shows the five tabs and switches between them", async () => {
    const { panel } = setup();
    await panel.show("terminal");
    render(<BottomPanel themeKind="dark" />);

    const tabs = within(screen.getByRole("tablist", { name: "Panel tabs" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Problems",
      "Output",
      "Debug Console",
      "Terminal",
      "Ports",
    ]);
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Ports" }));
    await waitFor(() => {
      expect(screen.getByRole("tabpanel", { name: "Ports" })).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: "Ports" })).toHaveAttribute("aria-selected", "true");
  });

  it("Problems shows an honest empty state", async () => {
    const { panel } = setup();
    await panel.show("problems");
    render(<BottomPanel themeKind="dark" />);

    expect(
      screen.getByText("No problems have been detected in the workspace."),
    ).toBeInTheDocument();
  });

  it("Debug Console says debugging isn't available", async () => {
    const { panel } = setup();
    await panel.show("debugConsole");
    render(<BottomPanel themeKind="dark" />);

    expect(screen.getByText(/isn.t available yet/)).toBeInTheDocument();
  });

  it("Output shows the selected channel's lines, switches channel, and clears", async () => {
    const { panel, output } = setup();
    output.append("Terminal", "Started PowerShell");
    output.append("Search", "Searched for x");
    await panel.show("output");
    render(<BottomPanel themeKind="dark" />);
    expect(screen.getByText("No output in “OpenMind Studio” yet.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Output channel"), { target: { value: "Terminal" } });
    expect(await screen.findByLabelText("Terminal output")).toHaveTextContent("Started PowerShell");

    output.append("Terminal", "later line");
    await waitFor(() => {
      expect(screen.getByLabelText("Terminal output")).toHaveTextContent("later line");
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear Output" }));
    await waitFor(() => {
      expect(screen.getByText("No output in “Terminal” yet.")).toBeInTheDocument();
    });
  });

  it("Ports shows the empty state, then registered ports with a working open-in-browser action", async () => {
    const { panel, ports, ipc } = setup();
    await panel.show("ports");
    render(<BottomPanel themeKind="dark" />);
    expect(screen.getByText(/No ports are registered/)).toBeInTheDocument();

    ports.register({ port: 3000, label: "Web", source: "node", url: "http://localhost:3000" });
    ports.register({ port: 9000, label: "Raw", source: "node" });

    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3);
    const buttons = screen.getAllByRole("button", { name: "Open in Browser" });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => {
      expect(ipc.openExternalUrl).toHaveBeenCalledWith("http://localhost:3000");
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1] as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByRole("row")).toHaveLength(2);
    });
  });

  it("the close button hides the panel", async () => {
    const { panel } = setup();
    await panel.show("output");
    render(<BottomPanel themeKind="dark" />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Panel" }));

    await waitFor(() => {
      expect(panel.getState().visible).toBe(false);
    });
  });
});

describe("SearchView", () => {
  beforeEach(() => {
    harness.current = null;
  });

  const OUTCOME: SearchOutcome = {
    files: [
      {
        path: "C:/p/src/a.rs",
        relativePath: "src/a.rs",
        matches: [
          {
            line: 2,
            column: 9,
            length: 6,
            preview: "let x = needle;",
            previewStart: 8,
            previewEnd: 14,
          },
          { line: 7, column: 1, length: 6, preview: "needle()", previewStart: 0, previewEnd: 6 },
        ],
      },
      {
        path: "C:/p/b.rs",
        relativePath: "b.rs",
        matches: [
          { line: 1, column: 1, length: 6, preview: "needle", previewStart: 0, previewEnd: 6 },
        ],
      },
    ],
    totalMatches: 3,
    filesSearched: 5,
    skippedBinary: 0,
    skippedLarge: 0,
    truncated: false,
    cancelled: false,
    durationMs: 3,
  };

  it("searches when Enter is pressed and groups the results by file with counts", async () => {
    const { ipc } = setup({ searchOutcome: OUTCOME });
    render(<SearchView />);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "needle" } });
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });

    expect(await screen.findByText("3 results in 2 files")).toBeInTheDocument();
    expect(ipc.searchRun).toHaveBeenCalled();
    const files = within(screen.getByRole("list", { name: "Search results" })).getAllByRole(
      "button",
      {
        expanded: true,
      },
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toHaveTextContent("a.rs");
    expect(files[0]).toHaveTextContent("2");
    expect(files[1]).toHaveTextContent("b.rs");
    expect(screen.getAllByText("needle", { selector: "mark" })).toHaveLength(3);
  });

  it("the toggles set the search options", () => {
    const { search } = setup();
    render(<SearchView />);

    fireEvent.click(screen.getByRole("button", { name: "Match Case" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Regular Expression" }));

    expect(search.getState().options).toEqual({
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    });
    expect(screen.getByRole("button", { name: "Match Case" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clicking a result opens that file at the match", async () => {
    const { openPathAt } = setup({ searchOutcome: OUTCOME });
    render(<SearchView />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "needle" } });
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });

    fireEvent.click((await screen.findAllByTitle("Line 7, column 1"))[0] as HTMLElement);

    await waitFor(() => {
      expect(openPathAt).toHaveBeenCalledWith("C:/p/src/a.rs", { line: 7, column: 1, length: 6 });
    });
  });

  it("clicking a file's header folds its matches", async () => {
    setup({ searchOutcome: OUTCOME });
    render(<SearchView />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "needle" } });
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });
    await screen.findByText("3 results in 2 files");
    expect(screen.getAllByTitle(/^Line /)).toHaveLength(3);

    fireEvent.click(screen.getByTitle("C:/p/src/a.rs"));

    expect(screen.getAllByTitle(/^Line /)).toHaveLength(1);
  });

  it("says when nothing matched, and shows a search error as an alert", async () => {
    const { ipc } = setup();
    render(<SearchView />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zzz" } });
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });
    expect(await screen.findByText("No results found.")).toBeInTheDocument();

    vi.mocked(ipc.searchRun).mockRejectedValueOnce("the search text isn't a valid pattern");
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent("valid pattern");
  });
});

describe("MarkdownPreview", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("renders headings, emphasis, lists and code as real elements", () => {
    setup({
      content:
        "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n```\nlet x = 1;\n```",
    });
    render(<MarkdownPreview docId="d" />);

    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("em").tagName).toBe("EM");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("let x = 1;").tagName).toBe("CODE");
  });

  it("never turns raw HTML into elements or runs scripts", () => {
    setup({
      content:
        '<script>window.__pwned = true</script>\n\n<img src=x onerror="window.__pwned = true">\n\n<b>bold?</b>',
    });
    const { container } = render(<MarkdownPreview docId="d" />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>");
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("dangerous link targets are not links; safe ones go to the app instead of navigating", () => {
    const { followLink } = setup({
      content: "[evil](javascript:alert(1)) [web](https://example.com) [file](docs/a.md)",
    });
    render(<MarkdownPreview docId="doc-9" />);

    expect(screen.queryByRole("link", { name: "evil" })).toBeNull();
    const web = screen.getByRole("link", { name: "web" });
    const notPrevented = fireEvent.click(web);
    fireEvent.click(screen.getByRole("link", { name: "file" }));

    expect(notPrevented).toBe(false); // preventDefault was called: the webview never navigates
    expect(followLink).toHaveBeenCalledWith("doc-9", "https://example.com");
    expect(followLink).toHaveBeenCalledWith("doc-9", "docs/a.md");
  });

  it("images are shown as text and nothing is loaded", () => {
    setup({ content: "![logo](https://example.com/logo.png)" });
    const { container } = render(<MarkdownPreview docId="d" />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[logo]")).toBeInTheDocument();
  });

  it("an empty document says there is nothing to preview", () => {
    setup({ content: "" });
    render(<MarkdownPreview docId="d" />);

    expect(screen.getByText("There is nothing to preview yet.")).toBeInTheDocument();
  });
});

describe("MenuPopup submenus", () => {
  it("opens the right submenu even when separators come before it", () => {
    const items: PopupItem[] = [
      { kind: "item", label: "One", enabled: true, onSelect: () => undefined },
      { kind: "separator" },
      {
        kind: "submenu",
        label: "First",
        items: [{ kind: "item", label: "A", enabled: true, onSelect: () => undefined }],
      },
      { kind: "separator" },
      { kind: "separator" },
      {
        kind: "submenu",
        label: "Second",
        items: [{ kind: "item", label: "B", enabled: true, onSelect: () => undefined }],
      },
    ];
    render(<MenuPopup items={items} x={10} y={10} onClose={() => undefined} />);

    fireEvent.mouseEnter(screen.getByText("Second"));

    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.queryByText("A")).toBeNull();
  });

  it("a disabled row shows its reason as a tooltip", () => {
    const items: PopupItem[] = [
      {
        kind: "item",
        label: "Close Saved",
        enabled: false,
        reason: "Every open editor has unsaved changes.",
        onSelect: () => undefined,
      },
    ];
    render(<MenuPopup items={items} x={0} y={0} onClose={() => undefined} />);

    expect(screen.getByRole("menuitem", { name: "Close Saved" })).toHaveAttribute(
      "title",
      "Every open editor has unsaved changes.",
    );
  });
});
