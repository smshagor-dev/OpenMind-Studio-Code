import { describe, expect, it, vi } from "vitest";

import { emptyContributions, testExtension } from "../testUtils/fakeExtensionsIpc";
import {
  containerKey,
  ExtensionViewsService,
  parseWelcome,
  type TreeNode,
} from "./extensionViewsService";
import type { InstalledExtension } from "./extensionsIpc";

function tasksExtension(enabled = true): InstalledExtension {
  return testExtension({
    enabled,
    manifest: {
      ...testExtension().manifest,
      name: "tasks",
      displayName: "Tasks",
      contributes: {
        ...emptyContributions(),
        views: {
          containers: [
            {
              id: "tasks",
              title: "Tasks",
              icon: "media/tasks.svg",
              views: [
                {
                  id: "tasks.list",
                  name: "List",
                  kind: "tree",
                  welcome: [
                    { contents: "Empty.\n[Add](command:tasks.add)", when: null },
                    { contents: "Open a folder first.", when: "workbenchState == empty" },
                    {
                      contents: "Folder open.",
                      when: "workbenchState != empty && workspaceFolderCount",
                    },
                  ],
                },
                { id: "tasks.board", name: "Board", kind: "webview", welcome: [] },
              ],
            },
          ],
          elsewhere: 0,
          otherContainers: 0,
        },
      },
    },
  });
}

function node(
  handle: string,
  label: string,
  collapsible: 0 | 1 | 2 = 0,
  hasCommand = false,
): TreeNode {
  return { handle, label, description: null, tooltip: null, collapsible, icon: null, hasCommand };
}

function rig(installed: InstalledExtension[] = [tasksExtension()], folder = false) {
  const tree: Record<string, TreeNode[]> = {
    root: [node("h1", "Task 1", 1, true), node("h2", "Group", 1)],
    h1: [node("h3", "Plan")],
    h2: [node("h4", "Inner")],
  };
  const extHostRequest = vi.fn((_method: string, params: unknown) => {
    const p = params as { op: string; handle: string | null };
    if (p.op === "children") return Promise.resolve(tree[p.handle ?? "root"] ?? []);
    if (p.op === "click") return Promise.resolve({ ran: true });
    return Promise.resolve({ ok: true });
  });
  const extReadIcon = vi.fn().mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
  const activateFor = vi.fn().mockResolvedValue([]);
  const hostRequest = vi.fn().mockResolvedValue({ id: "openmind-samples.tasks#wvv-1" });
  const run = vi.fn();
  const errors: string[] = [];
  const views = new ExtensionViewsService({
    ipc: { extHostRequest, extReadIcon },
    registry: { all: () => installed, subscribe: () => () => undefined },
    host: { activateFor, request: hostRequest },
    run,
    onError: (message) => errors.push(message),
    context: () => ({
      workbenchState: folder ? "folder" : "empty",
      workspaceFolderCount: folder ? 1 : 0,
    }),
  });
  return { views, extHostRequest, extReadIcon, activateFor, hostRequest, run, errors, tree };
}

const KEY = containerKey("openmind-samples.tasks", "tasks");

describe("parseWelcome", () => {
  it("turns lone command links into buttons and keeps other links inline", () => {
    expect(
      parseWelcome(
        "No tasks yet.\n\n[Add Task](command:tasks.add?%5B1%5D)\nRead [the docs](https://x.dev).",
      ),
    ).toEqual([
      { kind: "text", parts: [{ text: "No tasks yet." }] },
      { kind: "button", label: "Add Task", command: "tasks.add" },
      {
        kind: "text",
        parts: [{ text: "Read " }, { link: "the docs", target: "https://x.dev" }, { text: "." }],
      },
    ]);
  });
});

describe("ExtensionViewsService", () => {
  it("lists enabled extensions' containers and loads their icons", async () => {
    const { views, extReadIcon } = rig([
      tasksExtension(),
      { ...tasksExtension(false), id: "x.off" },
    ]);
    const [entry] = views.containers();
    expect(views.containers()).toHaveLength(1);
    expect(entry?.key).toBe(KEY);
    expect(entry && views.iconOf(entry)).toBeNull();
    await vi.waitFor(() => {
      expect(entry && views.iconOf(entry)).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    });
    expect(extReadIcon).toHaveBeenCalledTimes(1);
  });

  it("showing a container wakes its views (onView) and loads them once a provider exists", async () => {
    const { views, activateFor, extHostRequest, hostRequest } = rig();
    await views.show(KEY);
    expect(activateFor).toHaveBeenCalledWith({ kind: "view", view: "tasks.list" });
    expect(activateFor).toHaveBeenCalledWith({ kind: "view", view: "tasks.board" });
    // The webview view's provider fills it only now that it is shown (Milestone 18).
    expect(hostRequest).toHaveBeenCalledWith("host/resolveWebviewView", { view: "tasks.board" });
    expect(views.view("tasks.board").registered).toBe(true);
    expect(views.view("tasks.list").registered).toBe(false);

    views.handleEvent("views/registered", { view: "tasks.list" });
    await vi.waitFor(() => {
      expect(views.view("tasks.list").roots?.map((n) => n.label)).toEqual(["Task 1", "Group"]);
    });
    expect(extHostRequest).toHaveBeenCalledWith("host/tree", {
      view: "tasks.list",
      op: "children",
      handle: null,
    });
  });

  it("expands and collapses, clicks run the item's command, and a parent without one toggles", async () => {
    const { views, extHostRequest } = rig();
    views.handleEvent("views/registered", { view: "tasks.list" });
    await views.refresh("tasks.list");
    const [task, group] = views.view("tasks.list").roots ?? [];
    if (!task || !group) throw new Error("roots");

    await views.toggle("tasks.list", task);
    expect(views.isExpanded("tasks.list", task)).toBe(true);
    expect(views.view("tasks.list").children.h1?.map((n) => n.label)).toEqual(["Plan"]);
    await views.toggle("tasks.list", task);
    expect(views.isExpanded("tasks.list", task)).toBe(false);

    await views.click("tasks.list", task);
    expect(extHostRequest).toHaveBeenCalledWith("host/tree", {
      view: "tasks.list",
      op: "click",
      handle: "h1",
    });
    await views.click("tasks.list", group);
    expect(views.isExpanded("tasks.list", group)).toBe(true);
    views.collapseAll("tasks.list");
    expect(views.isExpanded("tasks.list", group)).toBe(false);
  });

  it("follows change, message and title events, and forgets everything when the host resets", async () => {
    const { views, tree } = rig();
    views.handleEvent("views/registered", { view: "tasks.list" });
    await views.refresh("tasks.list");
    tree.root = [node("h5", "Fresh")];
    views.handleEvent("views/changed", { view: "tasks.list", handle: null });
    await vi.waitFor(() => {
      expect(views.view("tasks.list").roots?.[0]?.label).toBe("Fresh");
    });
    views.handleEvent("views/message", { view: "tasks.list", message: "Scanning…" });
    views.handleEvent("views/title", { view: "tasks.list", description: "3 open" });
    expect(views.view("tasks.list")).toMatchObject({ message: "Scanning…", description: "3 open" });
    views.handleEvent("views/reset", {});
    expect(views.view("tasks.list").registered).toBe(false);
  });

  it("a failing provider shows its error, a failing click is reported, and commands run through the app", async () => {
    const { views, extHostRequest, errors, run } = rig();
    extHostRequest.mockRejectedValueOnce(new Error("getChildren exploded"));
    views.handleEvent("views/registered", { view: "tasks.list" });
    await views.refresh("tasks.list");
    expect(views.view("tasks.list").error).toBe("getChildren exploded");

    extHostRequest.mockRejectedValueOnce(new Error("command failed"));
    await views.click("tasks.list", node("h1", "Task 1", 0, true));
    expect(errors).toEqual(["command failed"]);

    views.runCommand("tasks.add");
    expect(run).toHaveBeenCalledWith("tasks.add");
  });

  it("shows the welcome entries whose when clause holds", () => {
    const view = tasksExtension().manifest.contributes.views.containers[0]?.views[0];
    if (!view) throw new Error("view");
    expect(rig(undefined, false).views.welcomeFor(view)).toBe(
      "Empty.\n[Add](command:tasks.add)\nOpen a folder first.",
    );
    expect(rig(undefined, true).views.welcomeFor(view)).toBe(
      "Empty.\n[Add](command:tasks.add)\nFolder open.",
    );
  });

  it("stops activating a container's views once its extension failed to activate", async () => {
    const extension = tasksExtension();
    extension.manifest.contributes.views.containers[0]?.views.push({
      id: "tasks.more",
      name: "More",
      kind: "tree",
      welcome: [],
    });
    const { views, activateFor } = rig([extension]);
    activateFor.mockResolvedValue([{ id: "openmind-samples.tasks", ok: false, error: "boom" }]);
    await views.show(KEY);
    expect(activateFor).toHaveBeenCalledTimes(1);
    // The reason stays on the container, so its side bar can say why nothing shows.
    expect(views.failureOf(KEY)).toBe("boom");
    activateFor.mockResolvedValue([]);
    await views.show(KEY);
    expect(views.failureOf(KEY)).toBeNull();
  });
});
