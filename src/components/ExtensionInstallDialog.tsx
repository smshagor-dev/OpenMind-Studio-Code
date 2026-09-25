import { useEffect, useRef } from "react";

import { container } from "../services/container";
import {
  PERMISSION_LIMITS_NOTE,
  TRUST_WARNING,
  displayName,
  permissionLines,
  pointLines,
} from "../services/extensionModel";
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
        <dl className="ext-install__facts">
          <dt>Name</dt>
          <dd>{displayName(extension)}</dd>
          <dt>Publisher</dt>
          <dd>{extension.manifest.publisher}</dd>
          <dt>Version</dt>
          <dd>{extension.manifest.version}</dd>
        </dl>
        <p>{extension.manifest.description ?? ""}</p>
        {replaces ? (
          <p>
            Version {replaces.manifest.version} is installed; installing replaces it
            {replaces.enabled ? "." : " (it stays disabled)."}
          </p>
        ) : null}
        <p>{extension.runtimeRequirement ?? "It has no code: it only contributes data."}</p>
        <h3 className="ext-install__heading">Permissions</h3>
        <ul className="ext-plain-list" aria-label="Permissions">
          {permissionLines(extension).map((line) => (
            <li key={line.name} data-risk={line.highRisk}>
              <strong>{line.label}</strong>
              {line.highRisk ? <span className="ext-risk"> High risk</span> : null}
              <span className="ext-note">
                {" "}
                {line.description} ({line.origin === "inferred" ? "implied by what it contributes" : "requested"})
              </span>
            </li>
          ))}
          {permissionLines(extension).length === 0 ? <li>None: it needs no permission.</li> : null}
        </ul>
        <p className="ext-note">{PERMISSION_LIMITS_NOTE}</p>
        <h3 className="ext-install__heading">Contribution points</h3>
        <ul className="ext-plain-list" aria-label="Contribution points">
          {pointLines(extension).map((line) => (
            <li key={line.point}>
              {line.point} ({String(line.count)}) — {line.status}
              {line.status === "Not supported" ? (
                <span className="ext-note"> This contribution point is not supported yet.</span>
              ) : null}
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
