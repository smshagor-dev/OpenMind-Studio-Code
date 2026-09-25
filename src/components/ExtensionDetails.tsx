import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import {
  API_SUBSET_NOTE,
  describeActivation,
  PERMISSION_LIMITS_NOTE,
  displayName,
  hostStateText,
  permissionLines,
  pointLines,
  runtimeStatus,
} from "../services/extensionModel";
import type { InstalledExtension } from "../services/extensionsIpc";

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
          Close
        </button>
      </header>
      <dl>
        <Field label="Name">{extension.manifest.name}</Field>
        <Field label="Display name">{extension.manifest.displayName ?? "—"}</Field>
        <Field label="Publisher">{extension.manifest.publisher}</Field>
        <Field label="Version">{extension.manifest.version}</Field>
        <Field label="Description">{extension.manifest.description ?? "—"}</Field>
        <Field label="Status">{extension.enabled ? "Enabled" : "Disabled"}</Field>
        <Field label="Installed path">
          <span className="ext-path" title={extension.path}>
            {extension.path}
          </span>
        </Field>
        <Field label="Runtime requirement">
          {extension.runtimeRequirement ?? "None"}
          {runtime ? <span className="ext-field__sub"> {runtime.text}</span> : null}
        </Field>
        <Field label="Extension host">{snapshot ? hostStateText(snapshot.host) : "—"}</Field>
        <Field label="Activations">{String(activity.activationCount)}</Field>
        <Field label="Last activation">{activity.lastActivation ?? "Never"}</Field>
        <Field label="Last error">{activity.lastError ?? "None"}</Field>
      </dl>
      <h4>Activation events</h4>
      {extension.activationEvents.length === 0 ? (
        <p className="ext-note">None declared.</p>
      ) : (
        <ul className="ext-plain-list">
          {extension.activationEvents.map((event) => (
            <li key={event}>{describeActivation(event)}</li>
          ))}
        </ul>
      )}
      <h4>Permissions</h4>
      {permissionLines(extension).length === 0 ? (
        <p className="ext-note">None requested or implied.</p>
      ) : (
        <ul className="ext-plain-list" aria-label="Permissions">
          {permissionLines(extension).map((line) => (
            <li key={line.name} data-risk={line.highRisk}>
              <strong>{line.label}</strong> — {line.accepted ? "granted" : "not granted"}
              {line.highRisk ? <span className="ext-risk"> High risk</span> : null}
              <span className="ext-note"> {line.description}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="ext-note">{PERMISSION_LIMITS_NOTE}</p>
      <h4>Contribution points</h4>
      {lines.length === 0 ? (
        <p className="ext-note">This extension contributes nothing.</p>
      ) : (
        <ul className="ext-plain-list" aria-label="Contribution points">
          {lines.map((line) => (
            <li key={line.point} data-support={line.status}>
              <strong>{line.point}</strong> ({String(line.count)}) — {line.status}
              {line.note ? <span className="ext-note"> {line.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {extension.warnings.length > 0 ? (
        <>
          <h4>Warnings</h4>
          <ul className="ext-plain-list">
            {extension.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="ext-note">{API_SUBSET_NOTE}</p>
      <div className="ext-details__actions">
        <button
          type="button"
          className="ext-button"
          onClick={() => {
            service.openFolder(extension.id);
          }}
        >
          Open Extension Folder
        </button>
        <button
          type="button"
          className="ext-button"
          onClick={() => {
            void service.showLogs();
          }}
        >
          Show Logs
        </button>
      </div>
    </section>
  );
}
