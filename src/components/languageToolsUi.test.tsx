import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LspServerInfo } from "../services/ipc";
import { LanguageToolsPromptService } from "../services/languageTools/languageToolsPrompt";
import type { FileLspStatus } from "../services/lspAvailability";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { LanguageToolsPromptCard } from "./LanguageToolsPromptCard";
import { LanguageServersSection } from "./toolchains/LanguageServersSection";

function fortls(patch: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "fortran",
    name: "fortls",
    languages: ["fortran"],
    note: null,
    contents: "fortls 3.2.2",
    runtime: "pythonModule",
    installed: false,
    bundled: false,
    installSource: null,
    state: "stopped",
    workspace: "C:/w",
    node: null,
    capabilities: null,
    openDocuments: 0,
    pid: null,
    canInstall: true,
    installBlocked: null,
    logPath: "C:/app/logs/lsp/fortran.log",
    logExists: false,
    ...patch,
  };
}

/** A stand-in for the language server service: its list, its install, and a way to change both. */
function fakeLsp(initial: LspServerInfo, ...more: LspServerInfo[]) {
  let list = [initial, ...more];
  let state = { snapshot: null };
  const installing = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    state = { snapshot: null };
    for (const listener of listeners) listener();
  };
  let finish: () => void = () => undefined;
  const lsp = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    servers: () => list,
    refresh: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(true),
    isInstalling: (id: string) => installing.has(id),
    activeFileStatus: (): FileLspStatus => ({
      path: "C:/w/a.f90",
      server: list[0] ?? null,
      outcome: { state: "notInstalled", server: "fortran" },
    }),
    install: vi.fn((id: string) => {
      if (installing.has(id)) return Promise.resolve(false);
      installing.add(id);
      notify();
      return new Promise<boolean>((resolve) => {
        finish = () => {
          installing.delete(id);
          list = list.map((s) => (s.id === id ? { ...s, installed: true, installSource: "download" } : s));
          notify();
          resolve(true);
        };
      });
    }),
    set(next: LspServerInfo) {
      list = [next];
      notify();
    },
    finish: () => {
      finish();
    },
  };
  return lsp;
}

function quiet() {
  const state = { issue: null, failure: null };
  return { subscribe: () => () => undefined, getState: () => state, pendingHint: () => null };
}

afterEach(() => {
  cleanup();
  harness.current = null;
});

const intelephense = (patch: Partial<LspServerInfo> = {}) =>
  fortls({ id: "php", name: "Intelephense", languages: ["php"], contents: "intelephense 1.14", runtime: "node", ...patch });

describe("Runtime Manager > Language Tools tab: language servers", () => {
  it("lists every language server by language with its status", () => {
    const lsp = fakeLsp(
      fortls(),
      intelephense({ installed: true, state: "running", installSource: "download" }),
      fortls({ id: "python", name: "Pyright", contents: "pyright 1.1.414", bundled: true }),
      fortls({ id: "clangd", name: "clangd", contents: "clangd 22", canInstall: false, installBlocked: "Only in the offline bundle." }),
    );
    harness.current = { lsp };
    render(<LanguageServersSection />);
    const card = (name: string) => screen.getByRole("article", { name });
    expect(card("fortls")).toHaveTextContent("Fortran");
    expect(card("fortls")).toHaveTextContent("Missing");
    expect(card("Intelephense")).toHaveTextContent("Running");
    expect(card("Pyright")).toHaveTextContent("Included");
    expect(card("clangd")).toHaveTextContent("Only in the offline bundle.");
    expect(lsp.refresh).toHaveBeenCalled();
  });

  it("Install installs one server and the card updates by itself; a second click starts nothing", async () => {
    const lsp = fakeLsp(fortls());
    harness.current = { lsp };
    render(<LanguageServersSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(lsp.install).toHaveBeenCalledWith("fortran");
    const busy = screen.getByRole("button", { name: "Installing…" });
    expect(busy).toHaveProperty("disabled", true);
    fireEvent.click(busy);
    expect(lsp.install).toHaveBeenCalledTimes(1);
    await act(async () => {
      lsp.finish();
      await Promise.resolve();
    });
    expect(screen.getByRole("article", { name: "fortls" })).toHaveTextContent("Ready");
    // A downloaded server can be removed again.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(lsp.uninstall).toHaveBeenCalledWith("fortran");
  });

  it("Install all missing installs every installable missing server, one after another", async () => {
    const lsp = fakeLsp(
      fortls(),
      intelephense(),
      fortls({ id: "python", name: "Pyright", installed: true, installSource: "download" }),
      fortls({ id: "clangd", name: "clangd", canInstall: false, installBlocked: "Only in the offline bundle." }),
    );
    harness.current = { lsp };
    render(<LanguageServersSection />);
    const all = screen.getByRole("button", { name: "Install all missing (2)" });
    fireEvent.click(all);
    expect(lsp.install).toHaveBeenCalledWith("fortran");
    // The section button and the card being installed both say so.
    expect(screen.getAllByRole("button", { name: "Installing…" })).toHaveLength(2);
    await act(async () => {
      lsp.finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lsp.install).toHaveBeenLastCalledWith("php");
    await act(async () => {
      lsp.finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lsp.install).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Install all missing (0)" })).toHaveProperty("disabled", true);
  });

  it("a server that can't be installed now has a disabled Install with the reason", () => {
    const reason = "Python runtime is not installed yet.";
    harness.current = { lsp: fakeLsp(fortls({ canInstall: false, installBlocked: reason })) };
    render(<LanguageServersSection />);
    const install = screen.getByRole("button", { name: "Install" });
    expect(install).toHaveProperty("disabled", true);
    expect(install).toHaveAttribute("title", reason);
    expect(screen.getByText(reason)).toBeTruthy();
  });
});

describe("editor notification card", () => {
  function setup() {
    const lsp = fakeLsp(fortls());
    const prompt = new LanguageToolsPromptService({ lsp, onActiveChange: () => () => undefined });
    prompt.start();
    harness.current = { lsp, languageTools: prompt, deps: quiet(), network: quiet(), dependencies: quiet() };
    render(<LanguageToolsPromptCard />);
    return { lsp, prompt };
  }

  it("names the language and the missing tool, and Install now installs at once", async () => {
    const { lsp } = setup();
    expect(
      screen.getByText("Fortran language support is incomplete because fortls is not installed."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install now" }));
    expect(lsp.install).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Installing…" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Installing fortls…")).toBeTruthy();
    await act(async () => {
      lsp.finish();
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Dismiss closes it for the session", () => {
    const { lsp, prompt } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      lsp.set(fortls());
    });
    expect(prompt.getState().serverId).toBeNull();
    expect(lsp.install).not.toHaveBeenCalled();
  });
});
