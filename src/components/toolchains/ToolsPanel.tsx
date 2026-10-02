import { useEffect, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import type { ToolEntry } from "../../services/toolchains/toolchainIpc";
import { routeState, TOOL_ROUTES, type RouteState } from "../../services/toolchains/toolInstallRoutes";
import {
  missingLine,
  sectionsOf,
  shortPath,
  statusChip,
  versionChip,
  versionCount,
} from "../../services/toolchains/toolchainView";
import "../../styles/toolchains.css";
import { Chip } from "./Chip";
import { LanguageServersSection } from "./LanguageServersSection";
import { ToolDetailsDialog } from "./ToolDetailsDialog";

/**
 * Runtime Manager > Language Tools: the language servers (installable here, one by one or all at once), then the
 * bundled, app-local tools grouped by what they do.
 */
export function ToolsPanel() {
  return (
    <div className="tc-panel">
      <LanguageServersSection />
      <BundledTools />
    </div>
  );
}

function BundledTools() {
  const state = useSyncExternalStore(
    (listener) => container.toolchains.subscribe(listener),
    () => container.toolchains.getState(),
  );
  useEffect(() => {
    void container.toolchains.refresh();
  }, []);

  if (!state.loaded) return <p className="tc-note">Loading…</p>;
  const packs = state.packs;
  if (!packs) {
    return (
      <p className="tc-banner tc-banner--error" role="alert">
        {state.error ?? "The tools couldn't be listed."}
      </p>
    );
  }
  const sections = sectionsOf(packs.tools);
  const active = packs.tools.filter((tool) => tool.status === "active").length;
  return (
    <div className="tc-bundled">
      <header className="tc-summary">
        <div>
          <strong>{active === 0 ? "No tools bundled" : `${String(active)} bundled`}</strong>
          <span className="tc-summary__meta" title={packs.toolsDir}>
            {shortPath(packs.toolsDir, 52)} · {packs.platform}
          </span>
        </div>
        <p className="tc-note">
          Tools live inside OpenMind Studio&apos;s own folder and are listed in
          tools/toolchains.json. Nothing is downloaded here and your system PATH is never changed.
        </p>
      </header>
      {packs.manifestError ? (
        <p className="tc-banner tc-banner--error" role="alert">
          tools/toolchains.json was ignored: {packs.manifestError}
        </p>
      ) : null}
      {packs.warnings.length > 0 ? (
        <ul className="tc-banner tc-banner--warn" aria-label="Manifest warnings">
          {packs.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {state.error ? (
        <p className="tc-banner tc-banner--error" role="alert">
          {state.error}
        </p>
      ) : null}
      {sections.map((section) => (
        <section key={section.id} className="tc-section" aria-label={section.title}>
          <h3 className="tc-section__title">
            {section.title}
            <span className="tc-section__count">{section.tools.length}</span>
          </h3>
          <div className="tc-grid">
            {section.tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </section>
      ))}
      {state.detailsId ? <ToolDetailsDialog /> : null}
    </div>
  );
}

/** The card's chip, line and buttons for how the tool is installed (see `toolInstallRoutes`). */
function installView(tool: ToolEntry): {
  chip: { label: string; tone: string } | null;
  line: string | null;
  canInstall: boolean;
  canRemove: boolean;
  busy: boolean;
  reason: string | null;
} {
  const route = TOOL_ROUTES[tool.id];
  const busy = container.toolInstall.isBusy(tool.id);
  const none = { chip: null, line: null, canInstall: false, canRemove: false, busy, reason: null };
  if (route === undefined) return none;
  if (route.kind === "package") {
    const active = tool.versions.find((version) => version.status === "active");
    if (busy) return { ...none, chip: { label: "Installing", tone: "info" }, line: "Downloading and installing into the app folder…" };
    if (active !== undefined) {
      return { ...none, canRemove: active.installed, line: active.installed ? `Installed from Language Tools: ${active.version}` : null };
    }
    // A listed copy whose program is gone stays "Broken"; installing puts a working one in place.
    if (tool.status === "broken") return { ...none, canInstall: true };
    return {
      ...none,
      chip: { label: "Missing", tone: "warn" },
      line: "Install downloads it into OpenMind Studio's tools folder (pinned and checked); nothing outside the app changes.",
      canInstall: true,
    };
  }
  // A copy shipped with the app (tools/toolchains.json) that is active already wins.
  if (tool.status === "active" && !busy) return none;
  const routed: RouteState | null = routeState(route, container.runtime.getState().runtimes, container.lsp.servers(), busy);
  if (routed === null) return none;
  switch (routed.state) {
    case "installed":
      return { ...none, chip: { label: "Installed", tone: "ok" }, line: routed.detail };
    case "missing":
      return { ...none, chip: { label: "Missing", tone: "warn" }, line: routed.detail, canInstall: true };
    case "installing":
      return { ...none, chip: { label: "Installing", tone: "info" }, line: "Installing…", busy: true };
    case "unavailable":
      return { ...none, chip: { label: "Missing", tone: "warn" }, line: routed.reason, reason: routed.reason };
    case "external":
      return { ...none, chip: { label: "External", tone: "info" }, line: routed.reason };
  }
}

function ToolCard({ tool }: { tool: ToolEntry }) {
  const service = container.toolchains;
  const state = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getState(),
  );
  useSyncExternalStore(container.toolInstall.subscribe, container.toolInstall.getState);
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  useSyncExternalStore(container.lsp.subscribe.bind(container.lsp), () => container.lsp.getState());
  const install = installView(tool);
  const chip = install.chip ?? statusChip(tool);
  const hint = install.line ?? missingLine(tool);
  const verified = state.verified[tool.id];
  const canVerify = tool.versions.length > 0 && state.verifying === null;
  return (
    <article className="tc-card" aria-label={tool.name}>
      <header className="tc-card__head">
        <h4 className="tc-card__name">{tool.name}</h4>
        <Chip label={chip.label} tone={chip.tone} />
      </header>
      <p className="tc-card__summary" title={tool.summary}>
        {tool.summary}
      </p>
      {tool.versions.length > 0 ? (
        <div className="tc-card__meta">
          <span className="tc-card__active">
            {tool.activeVersion ? `Active ${tool.activeVersion}` : "No active version"}
          </span>
          <span className="tc-card__count">{versionCount(tool)}</span>
        </div>
      ) : null}
      {tool.path ? (
        <code className="tc-card__path" title={tool.path}>
          {shortPath(tool.path)}
        </code>
      ) : null}
      {hint ? (
        <p className="tc-card__hint" title={hint}>
          {hint}
        </p>
      ) : null}
      {verified ? (
        <p
          className={`tc-card__verify tc-card__verify--${verified.result.ok ? "ok" : "bad"}`}
          role="status"
          title={verified.result.output ?? verified.result.message}
        >
          {verified.result.ok ? "Verified" : "Verify failed"}: {verified.result.message}
        </p>
      ) : null}
      <footer className="tc-card__actions">
        {install.canInstall || install.reason !== null || install.busy ? (
          <button
            type="button"
            className="tc-card__install"
            disabled={!install.canInstall || install.busy}
            title={install.reason ?? `Install ${tool.name}`}
            onClick={() => void container.toolInstall.install(tool.id, tool.name)}
          >
            {install.busy ? "Installing…" : "Install"}
          </button>
        ) : null}
        {install.canRemove ? (
          <button type="button" onClick={() => void container.toolInstall.remove(tool.id, tool.name)}>
            Remove
          </button>
        ) : null}
        {tool.versions.length > 1 ? (
          <label className="tc-card__select">
            <span className="tc-visually-hidden">{`${tool.name} version`}</span>
            <select
              aria-label={`${tool.name} version`}
              value={tool.activeVersion ?? ""}
              onChange={(event) => {
                void service.setActive(tool.id, event.target.value);
              }}
            >
              {tool.activeVersion === null ? <option value="">Select version</option> : null}
              {tool.versions.map((version) => (
                <option
                  key={version.version}
                  value={version.version}
                  disabled={
                    service.selectBlocker(tool.id, version.version) !== null &&
                    version.status !== "active"
                  }
                >
                  {`${version.version} · ${versionChip(version).label}${version.latest ? " · latest" : ""}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={!canVerify}
          title={
            tool.versions.length === 0
              ? "Nothing bundled to verify"
              : "Check that the program is present and answers"
          }
          onClick={() => {
            void service.verify(tool.id);
          }}
        >
          {state.verifying === tool.id ? "Verifying…" : "Verify"}
        </button>
        <button
          type="button"
          onClick={() => {
            service.openDetails(tool.id);
          }}
        >
          Details
        </button>
      </footer>
    </article>
  );
}
