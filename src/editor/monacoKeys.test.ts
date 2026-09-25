import * as monaco from "monaco-editor";
import { describe, expect, it } from "vitest";

import { monacoActionFor, monacoKeybinding, REMAPPABLE_EDITOR_COMMANDS } from "./monacoKeys";

const { KeyCode, KeyMod } = monaco;

describe("monacoKeybinding", () => {
  it("turns app chords into Monaco's numeric keybindings", () => {
    expect(monacoKeybinding("F12")).toBe(KeyCode.F12);
    expect(monacoKeybinding("Shift+F12")).toBe(KeyMod.Shift | KeyCode.F12);
    expect(monacoKeybinding("Ctrl+S")).toBe(KeyMod.CtrlCmd | KeyCode.KeyS);
    expect(monacoKeybinding("Shift+Alt+F")).toBe(KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF);
    expect(monacoKeybinding("Ctrl+`")).toBe(KeyMod.CtrlCmd | KeyCode.Backquote);
    expect(monacoKeybinding("Ctrl+Alt+Up")).toBe(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.UpArrow);
    expect(monacoKeybinding("Ctrl+5")).toBe(KeyMod.CtrlCmd | KeyCode.Digit5);
    expect(monacoKeybinding("Ctrl+Numpad0")).toBe(KeyMod.CtrlCmd | KeyCode.Numpad0);
  });

  it("chords Monaco can't express are null", () => {
    expect(monacoKeybinding("Ctrl+Hyper+S")).toBeNull();
    expect(monacoKeybinding("Ctrl+Nope")).toBeNull();
  });
});

describe("remappable editor commands", () => {
  it("are the four language features from the spec, each with Monaco's own action id", () => {
    for (const command of [
      "go.toDefinition",
      "go.toReferences",
      "edit.renameSymbol",
      "edit.formatDocument",
    ]) {
      expect(REMAPPABLE_EDITOR_COMMANDS.has(command), command).toBe(true);
    }
    expect(monacoActionFor("go.toDefinition")).toBe("editor.action.revealDefinition");
    expect(monacoActionFor("edit.renameSymbol")).toBe("editor.action.rename");
    expect(monacoActionFor("edit.undo")).toBeNull();
  });
});
