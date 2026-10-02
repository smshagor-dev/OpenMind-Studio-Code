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
import { RuntimeLanguageTools } from "./RuntimeLanguageTools";

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
function fakeLsp(initial: LspServerInfo) {
  let list = [initial];
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
          list = list.map((s) => (s.id === id ? { ...s, installed: true } : s));
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

describe("Runtime Manager card: language tools", () => {
  it("shows Missing with an Install Language Tools button, and installs with one click", async () => {
    const lsp = fakeLsp(fortls());
    harness.current = { lsp };
    render(<RuntimeLanguageTools runtimeId="fortran" />);
    expect(screen.getByText("Language Tools: Missing")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Install Language Tools" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(lsp.install).toHaveBeenCalledWith("fortran");
    // Installing: the button can't start a second install.
    const busy = screen.getByRole("button", { name: "Installing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Language Tools: installing fortls…")).toBeTruthy();
    fireEvent.click(busy);
    expect(lsp.install).toHaveBeenCalledTimes(1);
    // Done: the line updates by itself (no restart, no reopening).
    await act(async () => {
      lsp.finish();
      await Promise.resolve();
    });
    expect(screen.getByText("Language Tools: fortls 3.2.2")).toBeTruthy();
    expect(screen.getByText("Status: Ready")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows installed, running and bundled tools without a button", () => {
    const lsp = fakeLsp(fortls({ installed: true, state: "running" }));
    harness.current = { lsp };
    render(<RuntimeLanguageTools runtimeId="fortran" />);
    expect(screen.getByText("Status: Running")).toBeTruthy();
    act(() => {
      lsp.set(fortls({ bundled: true }));
    });
    expect(screen.getByText("Language Tools: fortls 3.2.2")).toBeTruthy();
    expect(screen.getByText(/Status: Included/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says why a missing tool can't be installed now, with the button disabled", () => {
    const reason = "Python runtime is not installed yet.";
    harness.current = { lsp: fakeLsp(fortls({ canInstall: false, installBlocked: reason })) };
    render(<RuntimeLanguageTools runtimeId="fortran" />);
    expect(screen.getByText("Language Tools: Missing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Language Tools" })).toHaveProperty("disabled", true);
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it("shows nothing on a runtime without a registered language tool (Pascal)", () => {
    harness.current = { lsp: fakeLsp(fortls()) };
    const { container } = render(<RuntimeLanguageTools runtimeId="pascal" />);
    expect(container.innerHTML).toBe("");
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
