import { useEffect, useState } from "react";

import appIcon from "../../src-tauri/icons/128x128.png";
import { container } from "../services/container";
import type { AppInfo } from "../services/ipc";

/** The WebView2 (Chromium Edge) version, read from the user agent. */
function webviewVersion(): string {
  return /Edg\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "unknown";
}

/** Help > About: product name and the versions that matter for bug reports. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    container.ipc.appInfo().then(
      (loaded) => {
        if (!cancelled) setInfo(loaded);
      },
      (error: unknown) => {
        container.events.emit("appError", {
          message: `Couldn't read version info: ${String(error)}`,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const details = [
    `Version: ${info?.version ?? "…"}`,
    `Tauri: ${info?.tauriVersion ?? "…"}`,
    `WebView2: ${webviewVersion()}`,
  ].join("\n");

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="modal modal--about"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <img className="modal__icon" src={appIcon} alt="" width={64} height={64} />
        <h2 id="about-title">OpenMind Studio</h2>
        <pre className="modal__details">{details}</pre>
        <div className="modal__actions">
          <button
            type="button"
            className="modal__confirm--primary"
            onClick={() => {
              container.ipc.clipboardWriteText(details).catch(() => undefined);
            }}
          >
            Copy
          </button>
          <button type="button" onClick={onClose} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
