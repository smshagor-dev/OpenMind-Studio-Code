import * as monaco from "monaco-editor";

let defined = false;

/**
 * Defines the Monaco themes matching the workbench chrome (`styles/theme.css`):
 * VS Code's current default dark (editor #121314, widgets #202122) and Light+.
 * Both inherit Monaco's token colors; only the surfaces change. Called just
 * before an editor is created or the theme is set — defining a theme starts
 * Monaco's global services, which nothing should pay for until an editor exists.
 */
export function defineMonacoThemes(): void {
  if (defined) return;
  defined = true;
  monaco.editor.defineTheme("openmind-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#121314",
      "editorGutter.background": "#121314",
      "minimap.background": "#121314",
      "editor.lineHighlightBackground": "#1a1b1c",
      "editor.lineHighlightBorder": "#00000000",
      "editorLineNumber.foreground": "#6e7071",
      "editorLineNumber.activeForeground": "#bfbfbf",
      "editorWidget.background": "#202122",
      "editorWidget.border": "#2a2b2c",
      "editorSuggestWidget.background": "#202122",
      "editorSuggestWidget.border": "#2a2b2c",
      "editorHoverWidget.background": "#202122",
      "editorHoverWidget.border": "#2a2b2c",
      "input.background": "#191a1b",
      "input.border": "#2a2b2c",
      focusBorder: "#297aa0",
      "scrollbarSlider.background": "#79797933",
      "diffEditor.border": "#2a2b2c",
    },
  });

  monaco.editor.defineTheme("openmind-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {},
  });

  // Monaco's own high-contrast base: black surfaces, bright borders, no soft highlights.
  monaco.editor.defineTheme("openmind-hc", {
    base: "hc-black",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#000000",
      "editorGutter.background": "#000000",
      "minimap.background": "#000000",
      "editorWidget.background": "#000000",
      "editorWidget.border": "#6fc3df",
      focusBorder: "#f38518",
    },
  });
}

/** The Monaco theme for each app theme kind. */
export const MONACO_THEME_MAP: Record<string, string> = {
  dark: "openmind-dark",
  light: "openmind-light",
  "high-contrast": "openmind-hc",
};
