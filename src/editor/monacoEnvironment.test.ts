import { afterEach, describe, expect, it, vi } from "vitest";

import { editorWorkerUrl, installMonacoEnvironment } from "./monacoEnvironment";

interface Environment {
  getWorker: (workerId: string, label: string) => unknown;
}

describe("Monaco environment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the worker url under the app base", () => {
    expect(editorWorkerUrl("/")).toBe("/monaco-workers/editor.worker.js");
  });

  it("starts the bundled editor worker for the editor service only", () => {
    const created: { url: string; name: string }[] = [];
    class FakeWorker {
      readonly name: string;
      constructor(url: string, options: { name: string }) {
        created.push({ url, name: options.name });
        this.name = options.name;
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const target: { MonacoEnvironment?: unknown } = {};
    installMonacoEnvironment(target, "/");
    const environment = target.MonacoEnvironment as Environment;

    expect(environment.getWorker("workerMain.js", "editorWorkerService")).toBeInstanceOf(
      FakeWorker,
    );
    expect(created).toEqual([
      { url: "/monaco-workers/editor.worker.js", name: "editorWorkerService" },
    ]);
    // Language-service workers keep Monaco's default handling.
    expect(environment.getWorker("workerMain.js", "TypeScriptWorker")).toBeUndefined();
    expect(created).toHaveLength(1);
  });
});
