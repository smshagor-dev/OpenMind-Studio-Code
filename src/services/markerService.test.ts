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
});
