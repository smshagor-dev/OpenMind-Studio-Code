// The VS Code import of this window, built from the app's own services (kept out of container.ts, which is at its
// size limit, like the update service).
import { container } from "../container";
import { t } from "../../i18n";
import { tauriVsCodeImportIpc } from "./vscodeImportIpc";
import { VsCodeImportService } from "./vscodeImportService";

export const vscodeImport = new VsCodeImportService(tauriVsCodeImportIpc, {
  reloadSettings: () => container.settings.reload(),
  reloadKeybindings: () => container.keybindingsManager.reload(),
  reloadProfiles: () => container.profiles.load(),
  reloadExtensions: () => container.extensions.registry.refresh(),
  reloadSnippets: () => {
    container.extensions.contributions.apply();
  },
  text: (key, params) => t(key, params),
});
