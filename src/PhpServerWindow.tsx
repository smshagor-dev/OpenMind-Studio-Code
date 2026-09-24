import { useEffect } from "react";

import { useToasts } from "./appHooks";
import { ErrorToast } from "./components/ErrorToast";
import { PhpServerView } from "./components/PhpServerView";
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
  const [toasts, dismissToast] = useToasts();

  useEffect(() => {
    let cancelled = false;
    void container.ipc.themeGet().then((theme) => {
      if (!cancelled) document.documentElement.dataset.theme = theme;
    });
    void container.runtime.initialize().then(() => container.runtime.refresh());
    void container.php.initialize();
    const refresh = () => {
      void container.runtime.refresh();
      void container.php.syncServer();
      void container.php.refreshPort();
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      container.php.dispose();
    };
  }, []);

  return (
    <div className="php-window">
      <PhpServerView />
      <ErrorToast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
