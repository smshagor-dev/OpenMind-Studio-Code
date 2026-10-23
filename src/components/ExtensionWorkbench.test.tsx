import { createRequire } from "node:module";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionWorkbench } from "./ExtensionWorkbench";
import { extensionWorkbench as service, ExtensionWorkbenchService } from "../services/extensionWorkbench";

interface HostFixture {
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (message: { method: string; params: Record<string, unknown> }) => void): () => void;
}
const require = createRequire(import.meta.url);
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as {
  fixture(t: { after(callback: () => Promise<void>): void }, definitions: Record<string, { code: string; permissions: string[] }>): Promise<HostFixture>;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { service.hide(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); service.handle("workbench/reset", {}); });

describe("extension workbench", () => {
  it("renders a real controller, runs its extension handler and shows the result", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
    const host = await fixture({ after: callback => cleanups.push(callback) }, { "test.ui": { permissions: ["commands"], code: `
      const v = require('vscode');
      exports.activate = () => {
        const c = v.tests.createTestController('ui', 'Arithmetic tests');
        const item = c.createTestItem('addition', 'Adds two numbers'); c.items.add(item);
        c.createRunProfile('Run arithmetic', 1, request => { const run = c.createTestRun(request, 'Arithmetic result');
          if (2 + 2 === 4) run.passed(item); else run.failed(item, new v.TestMessage('Wrong sum')); run.end(); });
      };` } });
    host.onNotification(message => { if (message.method.startsWith("workbench/")) service.handle(message.method, message.params); });
    service.connect(params => host.request("host/workbench", params));
    await host.request("host/activate", { id: "test.ui" });
    render(<ExtensionWorkbench />);
    await act(async () => { await service.show("tests"); });
    expect(screen.getByRole("dialog", { name: "Extension tools" })).toBeVisible();
    expect(screen.getByText("Adds two numbers")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run arithmetic" }));
    await waitFor(() => expect(screen.getByText("passed")).toBeVisible());
    expect(screen.getByText("Arithmetic result · Finished")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Source Control" }));
    await waitFor(() => expect(screen.getByText(/No active extension has registered a source control provider/)).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Close extension tools" }));
    await waitFor(() => expect(service.getState().visible).toBe(false));
  });

  it("discards stale responses after host reset and retains unsaved notebook text", async () => {
    const instance = new ExtensionWorkbenchService();
    let complete: ((value: unknown) => void) | undefined;
    instance.connect(() => new Promise(resolve => { complete = resolve; }));
    instance.handle("workbench/changed", { domain: "notebooks", serializers: ["example"], controllers: [], documents: [
      { uri: "file:///example", notebookType: "example", dirty: true, version: 2, cells: [{ index: 0, value: "keep this", languageId: "python", kind: 2, running: false, outputs: [] }] },
    ] });
    const pending = instance.show("tests"); instance.handle("workbench/reset", {}); complete?.({ controllers: [{ handle: "stale" }], runs: [] }); await pending;
    expect(instance.getState().snapshot.tests.controllers).toHaveLength(0);
    expect(instance.getState().snapshot.notebooks.documents[0]?.cells[0]?.value).toBe("keep this");
    expect(instance.getState().snapshot.notebooks.documents[0]?.unavailable).toBe(true);
    expect(instance.getState().pending).toBe(0);
    instance.handle("workbench/changed", { domain: "notebooks", serializers: [], controllers: [], documents: [] });
    expect(instance.getState().snapshot.notebooks.documents[0]?.cells[0]?.value).toBe("keep this");
    instance.connect(() => Promise.resolve({ serializers: [], controllers: [], documents: [] }));
    await instance.show("notebooks");
    expect(instance.getState().snapshot.notebooks.documents[0]?.cells[0]?.value).toBe("keep this");
  });

  it("shows backend failures without reporting a successful operation", async () => {
    const instance = new ExtensionWorkbenchService(); instance.connect(() => Promise.reject(new Error("Permission denied")));
    expect(await instance.act("debug", "start", {})).toBeUndefined();
    expect(instance.getState().error).toBe("Permission denied"); expect(instance.getState().pending).toBe(0);
  });

  it("waits for pending cell edits before executing and refuses to run after an edit conflict", async () => {
    const instance = new ExtensionWorkbenchService(); const calls: string[] = [];
    let failEdit: ((reason: Error) => void) | undefined;
    instance.connect(params => {
      calls.push(String(params.op));
      if (params.op === "edit") return new Promise((_resolve, reject) => { failEdit = reject; });
      return Promise.resolve(true);
    });
    const edit = instance.act("notebooks", "edit", { uri: "example" });
    const run = instance.act("notebooks", "execute", { uri: "example" });
    expect(calls).toEqual(["edit"]);
    failEdit?.(new Error("Notebook changed")); await edit; await run;
    expect(calls).toEqual(["edit"]);
    await instance.act("notebooks", "save", { uri: "example" });
    expect(calls).toEqual(["edit"]); expect(instance.getState().error).toContain("Resolve the notebook edit");
  });
});
