import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { App } from "./App";
import { PHP_WINDOW_LABEL, PhpServerWindow } from "./PhpServerWindow";
import "./styles/app.css";

/** Both windows load this same page; the window's label decides which screen it shows. */
function isPhpServerWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === PHP_WINDOW_LABEL;
  } catch {
    return false; // not inside Tauri (tests, a plain browser)
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("root element not found");
}

createRoot(rootElement).render(
  <StrictMode>{isPhpServerWindow() ? <PhpServerWindow /> : <App />}</StrictMode>,
);
