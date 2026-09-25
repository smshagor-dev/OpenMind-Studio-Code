import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { KeybindingsManager } from "./keybindingsManager";
import type { SettingsService } from "./settingsService";

export interface PreferenceFileDeps {
  events: EventBus<AppEvents>;
  settings: SettingsService;
  keybindings: KeybindingsManager;
  /** The current text of an open document. */
  contentOf: (docId: string) => string;
}

/**
 * Saving `settings.json`, the workspace's `.openmind/settings.json` or `keybindings.json` in a normal
 * editor tab applies it: the files are read again, and the user is told what was wrong with them.
 * Returns the function that stops listening.
 */
export function watchPreferenceFiles(deps: PreferenceFileDeps): () => void {
  const { events, settings, keybindings, contentOf } = deps;
  return events.on("documentSaved", ({ id, path }) => {
    void (async () => {
      const issues = await settings.handleSaved(path, contentOf(id));
      if (issues !== null) {
        const errors = issues.filter((issue) => issue.severity === "error");
        const warnings = issues.filter((issue) => issue.severity === "warning");
        if (errors.length > 0) {
          const first = errors[0];
          // A syntax error already says where it is.
          const message = first?.message ?? "";
          const where =
            first?.line == null || message.includes("line ") ? "" : ` (line ${String(first.line)})`;
          events.emit("appError", {
            message: `Settings saved with ${String(errors.length)} problem${errors.length === 1 ? "" : "s"}: ${message}${where}`,
          });
        } else if (warnings.length > 0) {
          events.emit("appNotice", {
            message: `Settings applied. ${warnings[0]?.message ?? ""}`,
          });
        } else {
          events.emit("appNotice", { message: "Settings applied." });
        }
        return;
      }
      if (await keybindings.handleSaved(path)) {
        const error = keybindings.getState().error;
        if (error === null) events.emit("appNotice", { message: "Keyboard shortcuts applied." });
        else events.emit("appError", { message: `Keyboard shortcuts not applied: ${error}` });
      }
    })();
  });
}
