import * as monaco from "monaco-editor";
import { expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MonacoHost } from "./MonacoHost";

it("blocks typing in a read-only pane and restores editing when that pane switches models", () => {
  const locked = monaco.editor.createModel("protected", "plaintext");
  const writable = monaco.editor.createModel("editable", "plaintext");
  let native: monaco.editor.IStandaloneCodeEditor | undefined;
  const mounted = (value: monaco.editor.IStandaloneCodeEditor) => {
    native = value;
    value.updateOptions({ minimap: { enabled: false }, overviewRulerLanes: 0 });
    return () => undefined;
  };
  const view = render(<MonacoHost model={locked} readOnly theme="openmind-dark" onEditorMounted={mounted} />);
  try {
    if (!native) throw Error("The native editor was not mounted.");
    native.trigger("keyboard", "type", { text: "blocked" });
    expect(locked.getValue()).toBe("protected");
    view.rerender(<MonacoHost model={writable} readOnly={false} theme="openmind-dark" onEditorMounted={mounted} />);
    native.trigger("keyboard", "type", { text: "allowed" });
    expect(writable.getValue()).toContain("allowed");
    view.rerender(<MonacoHost model={locked} readOnly theme="openmind-dark" onEditorMounted={mounted} />);
    native.trigger("keyboard", "type", { text: "still blocked" });
    expect(locked.getValue()).toBe("protected");
  } finally {
    view.unmount(); locked.dispose(); writable.dispose();
  }
});
