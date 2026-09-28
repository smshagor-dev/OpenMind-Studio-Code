import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import {
  describeActivation,
  canGrantOutsideWorkspace,
  outsideWorkspaceBlock,
  displayName,
  hostStateText,
  permissionLines,
  pointLines,
  runtimeStatus,
} from "../services/extensionModel";
import type { InstalledExtension } from "../services/extensionsIpc";
import { ExtensionContributes } from "./ExtensionContributes";
import { t } from "../i18n";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ext-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Everything about one installed extension: identity, where it lives, what it contributes and what is wrong. */
export function ExtensionDetails({ extension }: { extension: InstalledExtension }) {
  const { registry, service } = container.extensions;
  const state = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getState(),
  );
  const snapshot = state.snapshot;
  const activity = registry.activityOf(extension.id);
  const runtime = snapshot ? runtimeStatus(extension, snapshot.host, snapshot.node) : null;
  const lines = pointLines(extension);
  return (
    <section className="ext-details" aria-label={`${displayName(extension)} details`}>
      <header>
        <h3>{displayName(extension)}</h3>
        <button
          type="button"
          className="ext-link"
          onClick={() => {
            service.select(null);
          }}
        >
          {t("common.close")}
        </button>
      </header>
      <dl>
        <Field label={t("extDetails.id")}>
          <code>{extension.id}</code>
        </Field>
        <Field label={t("extDetails.name")}>{extension.manifest.name}</Field>
        <Field label={t("extDetails.displayName")}>{extension.manifest.displayName ?? "—"}</Field>
        <Field label={t("extDetails.publisher")}>{extension.manifest.publisher}</Field>
        <Field label={t("extDetails.version")}>{extension.manifest.version}</Field>
        <Field label={t("extDetails.description")}>{extension.manifest.description ?? "—"}</Field>
        <Field label={t("extDetails.status")}>{extension.enabled ? t("extDetails.enabled") : t("extensions.disabled")}</Field>
        <Field label={t("extDetails.path")}>
          <span className="ext-path" title={extension.path}>
            {extension.path}
          </span>
        </Field>
        <Field label={t("extDetails.runtime")}>
          {extension.runtimeRequirement ?? t("common.none")}
          {runtime ? <span className="ext-field__sub"> {runtime.text}</span> : null}
        </Field>
        <Field label={t("extDetails.host")}>{snapshot ? hostStateText(snapshot.host) : "—"}</Field>
        <Field label={t("extDetails.activations")}>{String(activity.activationCount)}</Field>
        <Field label={t("extDetails.lastActivation")}>{activity.lastActivation ?? t("common.never")}</Field>
        <Field label={t("extDetails.lastError")}>{activity.lastError ?? t("common.none")}</Field>
      </dl>
      <h4>{t("extDetails.activationEvents")}</h4>
      {extension.activationEvents.length === 0 ? (
        <p className="ext-note">{t("extDetails.noneDeclared")}</p>
      ) : (
        <ul className="ext-plain-list">
          {extension.activationEvents.map((event) => (
            <li key={event}>{describeActivation(event)}</li>
          ))}
        </ul>
      )}
      <h4>{t("extensions.install.permissions")}</h4>
      {permissionLines(extension).length === 0 ? (
        <p className="ext-note">{t("extDetails.noPermissions")}</p>
      ) : (
        <ul className="ext-plain-list" aria-label={t("extensions.install.permissions")}>
          {permissionLines(extension).map((line) => (
            <li key={line.name} data-risk={line.highRisk}>
              <strong>{line.label}</strong> — {line.accepted ? t("extDetails.granted") : t("extDetails.notGranted")}
              {line.highRisk ? <span className="ext-risk"> {t("extensions.install.highRisk")}</span> : null}
              <span className="ext-note"> {line.description}</span>
            </li>
          ))}
        </ul>
      )}
      {outsideWorkspaceBlock(activity.lastError) ? (
        <p className="ext-banner ext-banner--problem" role="alert">
          {outsideWorkspaceBlock(activity.lastError)}
        </p>
      ) : null}
      {canGrantOutsideWorkspace(extension) ? (
        <p className="ext-note">
          {t("extDetails.outsideNotGranted")}
        </p>
      ) : null}
      {canGrantOutsideWorkspace(extension) ? (
        <p>
          <button
            type="button"
            className="ext-button"
            title={t("extDetails.grantTitle")}
            onClick={() => {
              service.requestGrantOutsideWorkspace(extension.id);
            }}
          >
            {t("extDetails.grantButton")}
          </button>
        </p>
      ) : null}
      <p className="ext-note">{t("extensions.permissionLimits")}</p>
      <ExtensionContributes extension={extension} activity={activity} />
      <h4>{t("extensions.install.points")}</h4>
      {lines.length === 0 ? (
        <p className="ext-note">{t("extDetails.contributesNothing")}</p>
      ) : (
        <ul className="ext-plain-list" aria-label={t("extensions.install.points")}>
          {lines.map((line) => (
            <li key={line.point} data-support={line.support}>
              <strong>{line.point}</strong> ({String(line.count)}) — {line.status}
              {line.note ? <span className="ext-note"> {line.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {extension.warnings.length > 0 ? (
        <>
          <h4>{t("extDetails.warnings")}</h4>
          <ul className="ext-plain-list">
            {extension.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="ext-note">{t("extDetails.apiSubset")}</p>
      <div className="ext-details__actions">
        <button
          type="button"
          className="ext-button"
          onClick={() => {
            service.openFolder(extension.id);
          }}
        >
          {t("extensions.openExtensionFolder")}
        </button>
        <button
          type="button"
          className="ext-button"
          onClick={() => {
            void service.showLogs();
          }}
        >
          {t("extDetails.showLogs")}
        </button>
      </div>
    </section>
  );
}
