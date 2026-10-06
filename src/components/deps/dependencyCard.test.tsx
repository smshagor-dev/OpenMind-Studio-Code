import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "../../i18n";
import { EventBus } from "../../services/eventBus";
import type { AppEvents } from "../../services/events";
import { DependencyService } from "../../services/deps/dependencyService";
import type { ProjectInfo } from "../../services/deps/depsIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { DependencyCard } from "./DependencyCard";

const INFO: ProjectInfo = {
  pythonProject: "E:\\work",
  requirementsTxt: "E:\\work\\requirements.txt",
  pyprojectToml: null,
  pythonTarget: "openmindPython",
  nodeProject: "E:\\work",
  packageJson: "E:\\work\\package.json",
};

function setup(info: ProjectInfo = INFO, networkFailure: unknown = null) {
  const host = {
    ipc: {
      depsProjectInfo: vi.fn().mockResolvedValue(info),
    },
    events: new EventBus<AppEvents>(),
    confirm: vi.fn().mockResolvedValue(null),
    actions: { perform: vi.fn().mockResolvedValue({ status: "cancelled" }) },
    openFile: vi.fn(),
    openRuntimeManager: vi.fn(),
    runActiveInTerminal: vi.fn(),
  };
  const deps = new DependencyService(host);
  // One state object, like the real service (a new object per read would re-render forever).
  const networkState = { failure: networkFailure };
  const network = { subscribe: () => () => undefined, getState: () => networkState };
  harness.current = { deps, network };
  return { deps, host };
}

async function show(r: ReturnType<typeof setup>, text: string, fromRunCode = false) {
  act(() => {
    r.deps.report(text, "E:\\work\\main.py", "Terminal", fromRunCode);
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);

afterEach(() => {
  cleanup();
  i18n.setLanguage("en");
  harness.current = null;
});

describe("DependencyCard", () => {
  it("a missing Python package offers OpenMind Python, the wheelhouse and requirements.txt; install asks first", async () => {
    const r = setup();
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'requests'", true);
    expect(screen.getByRole("alert")).toHaveTextContent("Terminal: Python package/module is missing: requests");
    expect(buttons()).toEqual([
      "Install requests into OpenMind Python",
      "Install from Offline Wheelhouse",
      "Install requirements.txt",
      "Edit requirements.txt",
      "Open Runtime Manager",
      "Run in Terminal",
      "×",
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install requests into OpenMind Python" }));
      await Promise.resolve();
    });
    // The card hands the install to the shared runner (which plans, confirms and runs it).
    expect(r.host.actions.perform).toHaveBeenCalledWith(
      { base: "E:\\work\\main.py", op: { op: "pythonAdd", packages: "requests", offline: false } },
      "Dependency helper",
    );
  });

  it("tkinter never offers pip: it explains Tcl/Tk support and points to the Runtime Manager", async () => {
    const r = setup();
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'tkinter'");
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Python GUI (Tkinter / Tcl/Tk) support is missing.");
    expect(card).toHaveTextContent("Tkinter is part of Python's standard library, but this Python build does not include Tcl/Tk GUI support.");
    expect(buttons()).toEqual(["Open Runtime Manager", "×"]);
    expect(card.textContent).not.toMatch(/pip install|Install tkinter/);
  });

  it("a standard-library module (sqlite3) is a Python build component, not a pip package", async () => {
    const r = setup();
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'sqlite3'");
    expect(screen.getByRole("alert")).toHaveTextContent("sqlite3 is part of Python itself");
    expect(buttons()).toEqual(["Open Runtime Manager", "×"]);
  });

  it("without OpenMind Python or a venv, no install is offered — only the Runtime Manager", async () => {
    const r = setup({ ...INFO, pythonTarget: null });
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'pandas'");
    expect(screen.getByRole("alert")).toHaveTextContent("packages are never installed into your own Python");
    expect(buttons()).toEqual(["Open Runtime Manager", "×"]);
  });

  it("the project's venv is named when it has one", async () => {
    const r = setup({ ...INFO, pythonTarget: "projectVenv", requirementsTxt: null });
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'flask'");
    expect(screen.getByRole("button", { name: "Install flask into the project's .venv" })).toBeInTheDocument();
  });

  it("Node: npm install for the module and for package.json", async () => {
    const r = setup();
    render(<DependencyCard />);
    await show(r, "Error: Cannot find module 'lodash'");
    expect(buttons()).toEqual(["npm install lodash", "npm install (package.json)", "Open Runtime Manager", "×"]);
  });

  it("a missing compiler points to the Runtime Manager; Rust is external; a header is only reported", async () => {
    const r = setup();
    const { unmount } = render(<DependencyCard />);
    await show(r, "javac : The term 'javac' is not recognized");
    expect(screen.getByRole("alert")).toHaveTextContent("Install Java JDK from the Runtime Manager");
    expect(buttons()).toEqual(["Open Runtime Manager", "×"]);
    unmount();
    const rust = setup();
    render(<DependencyCard />);
    await show(rust, "'rustc' is not recognized as an internal or external command,");
    expect(screen.getByRole("alert")).toHaveTextContent("Rust (rustup) is installed outside OpenMind");
    expect(buttons()).toEqual(["×"]);
    cleanup();
    const header = setup();
    render(<DependencyCard />);
    await show(header, "main.c:1:10: fatal error: curl/curl.h: No such file or directory");
    expect(screen.getByRole("alert")).toHaveTextContent("OpenMind never downloads libraries by itself");
    expect(buttons()).toEqual(["×"]);
  });

  it("stays out of the way while the network card is up", async () => {
    const r = setup(INFO, { problem: "proxyAuthRequired" });
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'requests'");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is translated (Russian)", async () => {
    const r = setup();
    i18n.setLanguage("ru");
    render(<DependencyCard />);
    await show(r, "ModuleNotFoundError: No module named 'tkinter'");
    expect(screen.getByRole("alert")).toHaveTextContent("Нет поддержки графики Python (Tkinter / Tcl/Tk).");
  });
});
