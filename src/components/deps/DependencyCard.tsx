import { useSyncExternalStore } from "react";

import "../../styles/deps.css";
import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { DependencyState } from "../../services/deps/dependencyService";

function Action({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

/** What the card says about the issue (one or two sentences). */
function useMessage(state: DependencyState): { text: string; hint: string | null } {
  const t = useT();
  const issue = state.issue;
  switch (issue?.kind) {
    case "pythonPackage":
      return {
        text: t("deps.python.missing", { module: issue.module }),
        hint:
          state.info !== null && state.info.pythonTarget === null
            ? t("deps.python.noTarget")
            : issue.guessed
              ? t("deps.python.guessed", { package: issue.package })
              : null,
      };
    case "pythonComponent":
      return issue.tk
        ? { text: t("deps.tk.title"), hint: t("deps.tk.explain") }
        : { text: t("deps.stdlib.title", { module: issue.module }), hint: t("deps.stdlib.explain") };
    case "nodePackage":
      return { text: t("deps.node.missing", { module: issue.module }), hint: null };
    case "toolMissing":
      return issue.runtime !== null
        ? { text: t("deps.tool.missing", { tool: issue.tool }), hint: t("deps.tool.install", { label: issue.label }) }
        : { text: t("deps.tool.missing", { tool: issue.tool }), hint: t("deps.tool.external", { label: issue.label }) };
    case "headerMissing":
      return { text: t("deps.header.missing", { header: issue.header }), hint: t("deps.header.explain") };
    default:
      return { text: "", hint: null };
  }
}

/**
 * The dependency helper's card: what is missing and safe ways to get it. Installs open a confirmation with the exact
 * command first; nothing is installed from here without it.
 */
export function DependencyCard() {
  const t = useT();
  const state = useSyncExternalStore(container.deps.subscribe, container.deps.getState);
  const network = useSyncExternalStore(container.network.subscribe, container.network.getState);
  const { text, hint } = useMessage(state);
  const issue = state.issue;
  // A network failure explains more (a proxy that needs a password makes everything "missing"): it goes first.
  if (issue === null || network.failure !== null) return null;
  const deps = container.deps;
  const info = state.info;
  const actions: { label: string; run: () => void }[] = [];
  if (issue.kind === "pythonPackage" && (info === null || info.pythonTarget !== null)) {
    const into = info?.pythonTarget === "projectVenv" ? t("deps.action.intoVenv") : t("deps.action.intoOpenMind");
    actions.push({ label: t("deps.action.pip", { package: issue.package, into }), run: () => void deps.install("pip") });
    actions.push({ label: t("deps.action.pipOffline"), run: () => void deps.install("pipOffline") });
    if (info?.requirementsTxt) {
      actions.push({ label: t("deps.action.requirements"), run: () => void deps.install("pipRequirements") });
      actions.push({ label: t("deps.action.editRequirements"), run: () => { deps.openRequirements(); } });
    }
  }
  if (issue.kind === "nodePackage") {
    actions.push({ label: t("deps.action.npm", { package: issue.package }), run: () => void deps.install("npm") });
    if (info?.packageJson) actions.push({ label: t("deps.action.npmProject"), run: () => void deps.install("npmProject") });
  }
  const runtimeHelp =
    issue.kind === "pythonComponent" ||
    (issue.kind === "pythonPackage" && info !== null && info.pythonTarget === null) ||
    (issue.kind === "toolMissing" && issue.runtime !== null);
  if (runtimeHelp || issue.kind === "pythonPackage" || issue.kind === "nodePackage") {
    actions.push({ label: t("deps.action.runtimeManager"), run: () => { deps.openRuntimeManager(); } });
  }
  if (state.fromRunCode) actions.push({ label: t("run.interactive.terminal"), run: () => { deps.runInTerminal(); } });
  return (
    <div className="dependency-card" role="alert" aria-label={t("deps.title")}>
      <p className="dependency-card__text">
        {state.source !== "" ? `${state.source}: ` : ""}
        {text}
      </p>
      {hint !== null ? <p className="dependency-card__hint">{hint}</p> : null}
      {state.error !== null ? <p className="dependency-card__error">{state.error}</p> : null}
      <div className="dependency-card__actions">
        {actions.map((action) => (
          <Action key={action.label} label={action.label} disabled={state.busy} onClick={action.run} />
        ))}
        <button
          type="button"
          className="dependency-card__dismiss"
          aria-label={t("common.dismiss")}
          onClick={() => {
            deps.dismiss();
          }}
        >
          &times;
        </button>
      </div>
    </div>
  );
}
