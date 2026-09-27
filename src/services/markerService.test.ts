import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkerService } from "./markerService";

function marker(severity: monaco.MarkerSeverity): monaco.editor.IMarkerData {
  return {
    severity,
    message: "m",
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 2,
  };
}

describe("MarkerService", () => {
  const models: monaco.editor.ITextModel[] = [];
  afterEach(() => {
    for (const model of models.splice(0)) model.dispose();
  });

  it("counts errors and warnings across models and notifies on change", async () => {
    const service = new MarkerService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    const model = monaco.editor.createModel("x");
    models.push(model);

    monaco.editor.setModelMarkers(model, "test", [
      marker(monaco.MarkerSeverity.Error),
      marker(monaco.MarkerSeverity.Warning),
      marker(monaco.MarkerSeverity.Warning),
      marker(monaco.MarkerSeverity.Info),
    ]);

    // Monaco debounces marker-change events, so the recount lands asynchronously.
    await vi.waitFor(() => {
      expect(service.getCounts()).toEqual({ errors: 1, warnings: 2 });
    });
    expect(listener).toHaveBeenCalled();
    monaco.editor.setModelMarkers(model, "test", []);
    unsubscribe();
  });

  it("lists problems grouped by document, errors first, labelled by the resolver", async () => {
    const service = new MarkerService();
    const first = monaco.editor.createModel("a", "markdown");
    const second = monaco.editor.createModel("b", "markdown");
    models.push(first, second);
    service.setResourceResolver((uri) =>
      uri === first.uri.toString() ? { title: "first.md", path: "C:/p/first.md" } : null,
    );
    const unsubscribe = service.subscribe(() => undefined);

    monaco.editor.setModelMarkers(second, "t", [marker(monaco.MarkerSeverity.Warning)]);
    monaco.editor.setModelMarkers(first, "t", [
      { ...marker(monaco.MarkerSeverity.Warning), startLineNumber: 3 },
      { ...marker(monaco.MarkerSeverity.Error), message: "bad", startLineNumber: 9 },
    ]);

    await vi.waitFor(() => {
      expect(service.getProblemFiles()).toHaveLength(2);
    });
    const [top, other] = service.getProblemFiles();
    expect(top).toMatchObject({ title: "first.md", path: "C:/p/first.md" });
    expect(top?.problems.map((p) => [p.severity, p.line])).toEqual([
      ["error", 9],
      ["warning", 3],
    ]);
    expect(other?.path).toBeNull();
    monaco.editor.setModelMarkers(first, "t", []);
    monaco.editor.setModelMarkers(second, "t", []);
    await vi.waitFor(() => {
      expect(service.getProblemFiles()).toEqual([]);
    });
    unsubscribe();
  });
});

describe("external problems (task output)", () => {
  it("are listed per file and counted, and an owner's list is replaced or cleared", () => {
    const service = new MarkerService();
    const off = service.subscribe(() => undefined);
    const problem = { severity: "error" as const, message: "bad", source: "typescript", line: 3, column: 7, endLine: 3, endColumn: 8 };
    service.setExternal("task:build", [{ path: "C:/w/src/a.ts", title: "a.ts", problems: [problem] }]);
    expect(service.getCounts().errors).toBeGreaterThanOrEqual(1);
    const file = service.getProblemFiles().find((f) => f.uri === "external:task:build:C:/w/src/a.ts");
    expect(file?.path).toBe("C:/w/src/a.ts");
    expect(file?.problems[0]?.message).toBe("bad");
    service.setExternal("task:build", []);
    expect(service.getProblemFiles().some((f) => f.uri.startsWith("external:"))).toBe(false);
    off();
  });
});
