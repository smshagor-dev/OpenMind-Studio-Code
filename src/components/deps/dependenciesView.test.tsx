import { ipcWorkspaceFeed } from "../../testUtils/canonicalFeeds";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../../services/eventBus";
import type { AppEvents } from "../../services/events";
import { DependenciesService } from "../../services/deps/dependenciesService";
import { DependencyService } from "../../services/deps/dependencyService";
import type { DepsSnapshot, ProjectDeps } from "../../services/deps/depsIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { DependenciesView } from "./DependenciesView";

/** Clicks, then lets the view's operation settle (it ignores clicks while one is in flight). */
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}
import { DependencySetupCard } from "./DependencySetupCard";

const NONE = { python: null, node: null, php: null, rust: null, java: null, cmake: null, setup: [] };

const PY: ProjectDeps = {
  ...NONE,
  root: "py app",
  name: "py app",
  path: "E:\\My Work\\py app",
  python: {
    manifests: ["requirements.txt"],
    environments: [],
    requirements: [
      { name: "requests", spec: ">=2", installed: "2.34.2" },
      { name: "flask", spec: "", installed: null },
    ],
    missing: ["flask"],
    installed: [{ name: "requests", version: "2.34.2" }],
    skipped: ["-r base.txt"],
    notes: [],
  },
  setup: [{ kind: "pythonNoEnv" }],
};

const WEB: ProjectDeps = {
  ...NONE,
  root: "web app",
  name: "web app",
  path: "E:\\My Work\\web app",
  node: {
    packageManager: null,
    conflict: "Several lock files (package-lock.json, yarn.lock) — choose the package manager this project uses.",
    lockfiles: ["package-lock.json", "yarn.lock"],
    dependencies: [{ name: "left-pad", spec: "^1.3.0", installed: null }],
    devDependencies: [],
    scripts: [
      { name: "dev", command: "vite", runnable: true },
      { name: "x&calc", command: "y", runnable: false },
    ],
    nodeModules: false,
    notes: [],
  },
};

const RUST: ProjectDeps = {
  ...NONE,
  root: "rust app",
  name: "rust app",
  path: "E:\\My Work\\rust app",
  rust: { name: "demo", version: "0.1.0", edition: "2021", dependencies: [], devDependencies: [], features: [], lock: false, workspaceOnly: false },
};

function setup(snapshot: DepsSnapshot) {
  const events = new EventBus<AppEvents>();
  const perform = vi.fn().mockResolvedValue({ status: "cancelled" });
  const dependencies = new DependenciesService({
    actions: { perform },
    events,
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  });
  // The folder's dependencies as the canonical state delivers them.
  const feed = ipcWorkspaceFeed(() => Promise.resolve(snapshot));
  feed.push(snapshot);
  dependencies.useCanonical(feed);
  const deps = new DependencyService({
    ipc: { depsProjectInfo: vi.fn() },
    events,
    confirm: vi.fn(),
    actions: { perform },
    openFile: vi.fn(),
    openRuntimeManager: vi.fn(),
    runActiveInTerminal: vi.fn(),
  });
  const networkState = { failure: null };
  harness.current = { dependencies, deps, network: { subscribe: () => () => undefined, getState: () => networkState } };
  return { dependencies, perform };
}

afterEach(() => {
  cleanup();
  harness.current = null;
});

describe("DependenciesView", () => {
  it("shows each project with only its ecosystems, installed and missing packages", async () => {
    setup({ projects: [PY, WEB, RUST] });
    await act(async () => {
      render(<DependenciesView />);
      await Promise.resolve();
    });
    const py = screen.getByRole("region", { name: "py app" });
    expect(within(py).queryByLabelText("Node.js")).toBeNull();
    expect(within(py).getByText("No project environment — packages go into OpenMind's portable Python.")).toBeInTheDocument();
    expect(within(py).getByText("1 declared package(s) not installed.")).toBeInTheDocument();
    expect(within(py).getAllByText("missing")).toHaveLength(1);
    expect(within(py).getByText("Not read: -r base.txt")).toBeInTheDocument();
    const rust = screen.getByRole("region", { name: "rust app" });
    expect(within(rust).getByRole("button", { name: "cargo check" })).toBeInTheDocument();
  });

  it("every button asks the shared runner (which confirms before anything runs)", async () => {
    const { perform } = setup({ projects: [PY, WEB] });
    await act(async () => {
      render(<DependenciesView />);
      await Promise.resolve();
    });
    const py = screen.getByRole("region", { name: "py app" });
    await click(within(py).getByRole("button", { name: "Create .venv" }));
    expect(perform).toHaveBeenLastCalledWith(
      { base: PY.path, op: { op: "pythonCreateEnv" }, pythonEnv: null, nodeManager: null },
      "Dependencies",
    );
    fireEvent.change(within(py).getByRole("textbox"), { target: { value: "pandas==3.0" } });
    await click(within(py).getByRole("button", { name: "Add" }));
    expect(perform).toHaveBeenLastCalledWith(expect.objectContaining({ op: { op: "pythonAdd", packages: "pandas==3.0", offline: false } }), "Dependencies");
  });

  it("a lock-file conflict is shown and installing waits for a package manager; unsafe script names can't run", async () => {
    const { perform } = setup({ projects: [WEB] });
    await act(async () => {
      render(<DependenciesView />);
      await Promise.resolve();
    });
    const web = screen.getByRole("region", { name: "web app" });
    expect(within(web).getByRole("alert")).toHaveTextContent("Several lock files");
    expect(within(web).getByRole("button", { name: "Install Dependencies" })).toBeDisabled();
    fireEvent.change(within(web).getByRole("combobox", { name: "Package manager:" }), { target: { value: "yarn" } });
    await click(within(web).getByRole("button", { name: "Install Dependencies" }));
    expect(perform).toHaveBeenLastCalledWith(expect.objectContaining({ op: { op: "nodeInstall" }, nodeManager: "yarn" }), "Dependencies");
    expect(within(web).getByRole("button", { name: "Run the \"x&calc\" script" })).toBeDisabled();
    await click(within(web).getByRole("button", { name: "Run the \"dev\" script" }));
    expect(perform).toHaveBeenLastCalledWith(expect.objectContaining({ op: { op: "nodeRunScript", script: "dev" } }), "Dependencies");
  });
});

describe("DependencySetupCard", () => {
  it("offers the setup gap with its action and Not Now, and does nothing by itself", async () => {
    const { dependencies, perform } = setup({ projects: [PY] });
    await act(async () => {
      await dependencies.initialize();
    });
    render(<DependencySetupCard />);
    expect(screen.getByRole("status")).toHaveTextContent("Python project detected in py app. No project environment exists.");
    expect(perform).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
