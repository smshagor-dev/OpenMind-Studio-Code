import { useEffect, useRef } from "react";

import { container } from "../services/container";
import { TRUST_WARNING, displayName, pointLines } from "../services/extensionModel";
import type { PendingInstall } from "../services/extensionService";

/** The confirmation before a `.vsix` is installed: what it is, what it contributes, and the trust warning. */
export function ExtensionInstallDialog({ pending }: { pending: PendingInstall }) {
  const service = container.extensions.service;
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  const { extension, replaces } = pending;
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        service.cancelInstall();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          service.cancelInstall();
        }
      }}
    >
      <div
        className="modal ext-install"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ext-install-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="ext-install-title">
          Install {displayName(extension)} {extension.manifest.version}?
        </h2>
        <p className="ext-install__warning" role="note">
          {TRUST_WARNING}
        </p>
        <p>
          {extension.id}
          {extension.manifest.description ? ` — ${extension.manifest.description}` : ""}
        </p>
        {replaces ? (
          <p>
            Version {replaces.manifest.version} is installed; installing replaces it
            {replaces.enabled ? "." : " (it stays disabled)."}
          </p>
        ) : null}
        <p>{extension.runtimeRequirement ?? "It has no code: it only contributes data."}</p>
        <ul className="ext-plain-list">
          {pointLines(extension).map((line) => (
            <li key={line.point}>
              {line.point} ({String(line.count)}) — {line.status}
            </li>
          ))}
        </ul>
        <div className="modal__actions">
          <button
            ref={confirmRef}
            type="button"
            className="modal__confirm--primary"
            onClick={() => {
              void service.confirmInstall();
            }}
          >
            Install
          </button>
          <button
            type="button"
            onClick={() => {
              service.cancelInstall();
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
