import { useEffect, useRef } from "react";

import { container } from "../services/container";
import { displayName, permissionLines, pointLines } from "../services/extensionModel";
import type { PendingInstall } from "../services/extensionService";
import { t } from "../i18n";

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
          {t("extensions.install.title", { name: displayName(extension), version: extension.manifest.version })}
        </h2>
        <p className="ext-install__warning" role="note">
          {t("extensions.trustWarning")}
        </p>
        <dl className="ext-install__facts">
          <dt>{t("extensions.install.name")}</dt>
          <dd>{displayName(extension)}</dd>
          <dt>{t("extensions.install.publisher")}</dt>
          <dd>{extension.manifest.publisher}</dd>
          <dt>{t("extensions.install.version")}</dt>
          <dd>{extension.manifest.version}</dd>
        </dl>
        <p>{extension.manifest.description ?? ""}</p>
        {replaces ? (
          <p>
            {t(replaces.enabled ? "extensions.install.replaces" : "extensions.install.replacesDisabled", {
              version: replaces.manifest.version,
            })}
          </p>
        ) : null}
        <p>{extension.runtimeRequirement ?? t("extensions.install.noCode")}</p>
        <h3 className="ext-install__heading">{t("extensions.install.permissions")}</h3>
        <ul className="ext-plain-list" aria-label={t("extensions.install.permissions")}>
          {permissionLines(extension).map((line) => (
            <li key={line.name} data-risk={line.highRisk}>
              <strong>{line.label}</strong>
              {line.highRisk ? <span className="ext-risk"> {t("extensions.install.highRisk")}</span> : null}
              <span className="ext-note">
                {" "}
                {line.description} ({line.origin === "inferred" ? t("extensions.install.implied") : t("extensions.install.requested")})
              </span>
            </li>
          ))}
          {permissionLines(extension).length === 0 ? <li>{t("extensions.install.noPermissions")}</li> : null}
        </ul>
        <p className="ext-note">{t("extensions.permissionLimits")}</p>
        <h3 className="ext-install__heading">{t("extensions.install.points")}</h3>
        <ul className="ext-plain-list" aria-label={t("extensions.install.points")}>
          {pointLines(extension).map((line) => (
            <li key={line.point}>
              {line.point} ({String(line.count)}) — {line.status}
              {line.support === "unsupported" ? (
                <span className="ext-note"> {t("extensions.pointUnsupported")}</span>
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
            {t("extensions.installButton")}
          </button>
          <button
            type="button"
            onClick={() => {
              service.cancelInstall();
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
