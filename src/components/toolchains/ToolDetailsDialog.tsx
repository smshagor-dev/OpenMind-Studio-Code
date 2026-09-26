import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import {
  formatSize,
  missingLine,
  statusChip,
  versionChip,
} from "../../services/toolchains/toolchainView";
import { Chip } from "./Chip";

const CATEGORY_LABELS: Record<string, string> = {
  runtime: "Runtime",
  packageManager: "Package manager",
  languageServer: "Language server",
  formatter: "Formatter",
  linter: "Linter",
  debugger: "Debugger",
  vcs: "Version control",
  databaseTool: "Database tool",
  helperTool: "Helper tool",
  sdk: "SDK",
};

/** Everything about one tool: all versions, where it lives, what uses it and the full explanation. */
export function ToolDetailsDialog() {
  const service = container.toolchains;
  const state = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getState(),
  );
  const tool = state.detailsId ? service.tool(state.detailsId) : undefined;
  if (!tool) return null;
  const chip = statusChip(tool);
  const hint = missingLine(tool);
  const verified = state.verified[tool.id];
  const source =
    tool.status === "external"
      ? "External (installed by you; OpenMind only looks for it)"
      : tool.versions.length > 0
        ? "Bundled with OpenMind Studio (app-local)"
        : "Not bundled";
  return (
    <div
      className="modal-overlay tc-details-overlay"
      onClick={() => {
        service.closeDetails();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          service.closeDetails();
        }
      }}
    >
      <div
        className="modal tc-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-details-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="tc-details__head">
          <h2 id="tc-details-title">{tool.name}</h2>
          <Chip label={chip.label} tone={chip.tone} />
        </header>
        <div className="tc-details__body">
          <p className="tc-details__text">{tool.details}</p>
          <dl className="tc-facts">
            <dt>Category</dt>
            <dd>{CATEGORY_LABELS[tool.category] ?? tool.category}</dd>
            <dt>Source</dt>
            <dd>{source}</dd>
            <dt>Active version</dt>
            <dd>{tool.activeVersion ?? "None"}</dd>
            <dt>Program</dt>
            <dd className="tc-facts__path">{tool.path ?? "—"}</dd>
            <dt>Used by</dt>
            <dd>{tool.usedBy.join(", ")}</dd>
            <dt>Command</dt>
            <dd>
              <code>{tool.command}</code>
            </dd>
          </dl>
          {tool.versions.length > 0 ? (
            <>
              <h3 className="tc-details__sub">
                Versions ({String(tool.versions.length)} of up to {String(tool.maxVersions)})
              </h3>
              <ul className="tc-versions">
                {tool.versions.map((version) => (
                  <li key={version.version} className="tc-versions__row">
                    <span className="tc-versions__name">{version.version}</span>
                    <Chip {...versionChip(version)} />
                    {version.latest ? <Chip label="Latest" tone="info" /> : null}
                    <span className="tc-versions__meta">
                      {[formatSize(version.sizeBytes), version.license]
                        .filter((part): part is string => part !== null)
                        .join(" · ")}
                    </span>
                    <code className="tc-versions__path" title={version.path}>
                      {version.path}
                    </code>
                    {version.licenseUrl ? (
                      <span className="tc-versions__license">License: {version.licenseUrl}</span>
                    ) : null}
                    <button
                      type="button"
                      disabled={service.selectBlocker(tool.id, version.version) !== null}
                      title={service.selectBlocker(tool.id, version.version) ?? "Use this version"}
                      onClick={() => {
                        void service.setActive(tool.id, version.version);
                      }}
                    >
                      Use
                    </button>
                  </li>
                ))}
              </ul>
              {tool.ignoredVersions > 0 ? (
                <p className="tc-note">
                  {String(tool.ignoredVersions)} older version
                  {tool.ignoredVersions === 1 ? " is" : "s are"} ignored: at most{" "}
                  {String(tool.maxVersions)} are kept.
                </p>
              ) : null}
            </>
          ) : null}
          {hint ? <p className="tc-banner tc-banner--warn">{hint}</p> : null}
          {verified ? (
            <p
              className={`tc-banner tc-banner--${verified.result.ok ? "ok" : "error"}`}
              role="status"
            >
              {verified.result.ok ? "Verified" : "Verify failed"}: {verified.result.message}
              {verified.result.output ? ` (${verified.result.output})` : null} ·{" "}
              {new Date(verified.at).toLocaleTimeString()}
            </p>
          ) : (
            <p className="tc-note">Not verified in this session.</p>
          )}
        </div>
        <div className="modal__actions">
          <button
            type="button"
            disabled={tool.versions.length === 0 || state.verifying !== null}
            onClick={() => {
              void service.verify(tool.id);
            }}
          >
            {state.verifying === tool.id ? "Verifying…" : "Verify"}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              service.closeDetails();
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
