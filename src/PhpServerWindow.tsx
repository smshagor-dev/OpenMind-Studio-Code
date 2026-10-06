import { useEffect } from "react";

import { applyLanguageSetting, SYSTEM_LANGUAGE, useT } from "./i18n";
import { useToasts } from "./appHooks";
import { ErrorToast } from "./components/ErrorToast";
import { ControlPanel } from "./components/ControlPanel";
import { container } from "./services/container";

/** The label the backend gives the PHP Server window (`php_window_open`). */
export const PHP_WINDOW_LABEL = "php-server";

/**
 * The PHP Server window: its own native window with its own frontend, sharing
 * the backend with the main window (the running server, the installed
 * runtimes and the saved project/port are all backend state). It reloads the
 * server and runtime state whenever it is focused, so what it shows never
 * drifts from what the main window did in the meantime.
 */
export function PhpServerWindow() {
  useT();
  const [toasts, dismissToast] = useToasts();

  useEffect(() => {
    // The PHP window follows the same theme setting as the main window (it applies it to <html> itself).
    void container.theme.initialize();
    void container.runtime.initialize().then(() => container.runtime.refresh());
    void container.php.initialize();
    void container.mariaDb.initialize();
    void container.phpMyAdmin.initialize();
    void container.mySql.initialize();
    void container.composer.initialize();
    void container.controlPanel.initialize();
    // The UI language follows the setting here too (the settings are re-read when this window gets focus).
    const stopLanguage = container.settings.onChange(["workbench.language"], () => {
      void applyLanguageSetting(container.settings.string("workbench.language", SYSTEM_LANGUAGE));
    });
    const refresh = () => {
      void container.settings.reload();
      void container.runtime.refresh();
      void container.php.syncServer();
      void container.php.refreshPort();
      void container.mariaDb.refresh();
      void container.phpMyAdmin.refresh();
      void container.mySql.refresh();
      void container.composer.refreshProject();
      void container.controlPanel.refreshConfigPaths();
    };
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      stopLanguage();
      container.php.dispose();
      container.mariaDb.dispose();
      container.phpMyAdmin.dispose();
      container.mySql.dispose();
      container.composer.dispose();
      container.controlPanel.dispose();
    };
  }, []);

  return (
    <div className="php-window">
      <ControlPanel />
      <ErrorToast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
