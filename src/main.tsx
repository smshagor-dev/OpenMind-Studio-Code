import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { installMonacoEnvironment } from "./editor/monacoEnvironment";
import { initLanguage, type UiLanguage } from "./i18n";
import { StartupErrorPage } from "./startupError/StartupErrorPage";
import { STARTUP_ERROR_WINDOW_LABEL, tauriStartupErrorApi } from "./startupError/startupErrorApi";
import "./styles/app.css";

installMonacoEnvironment(self, import.meta.env.BASE_URL);

// Must match `PHP_WINDOW_LABEL` in PhpServerWindow.tsx (not imported: that module pulls in the PHP window's services).
const PHP_WINDOW_LABEL = "php-server";

function windowLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null; // not inside Tauri (tests, a plain browser)
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("root element not found");
}
const root = createRoot(rootElement);
const render = (screen: ReactNode) => {
  root.render(<StrictMode>{screen}</StrictMode>);
};

/**
 * Every window loads this same page and its label decides the screen. The workbench and the PHP window are imported
 * only for their own windows: their modules build services that talk to the backend as soon as they load, which the
 * start-up error window (no database, no app state) must not do.
 */
function start() {
  const label = windowLabel();
  if (label === STARTUP_ERROR_WINDOW_LABEL) {
    render(<StartupErrorPage api={tauriStartupErrorApi} />);
  } else if (label === PHP_WINDOW_LABEL) {
    void import("./PhpServerWindow").then(({ PhpServerWindow }) => {
      render(<PhpServerWindow />);
    });
  } else {
    void import("./App").then(({ App }) => {
      render(<App />);
    });
  }
}

// The UI language (the user's setting, else the PC's language, else English) is known before the first screen draws.
void initLanguage(() => invoke<UiLanguage>("ui_language")).finally(start);
