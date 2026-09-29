import { useState } from "react";

import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { Dep, DepsOp, ProjectDeps } from "../../services/deps/depsIpc";

type Run = (op: DepsOp) => void;

export function ActionButton({ label, onClick, disabled, title }: { label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="deps-view__action" disabled={disabled} title={title} onClick={onClick}>
      {label}
    </button>
  );
}

/** One declared package: its requirement, installed version (or "missing") and, when given, row actions. */
function DepRow({ dep, actions }: { dep: Dep; actions?: { label: string; run: () => void }[] }) {
  const t = useT();
  return (
    <li className="deps-view__dep">
      <span className="deps-view__dep-name">{dep.name}</span>
      {dep.spec !== "" ? <span className="deps-view__muted">{dep.spec}</span> : null}
      {dep.installed !== null ? (
        <span className="deps-view__chip">{dep.installed}</span>
      ) : (
        <span className="deps-view__chip deps-view__chip--missing">{t("deps.view.missing")}</span>
      )}
      {actions?.map((action) => (
        <button key={action.label} type="button" className="deps-view__row-action" onClick={action.run}>
          {action.label}
        </button>
      ))}
    </li>
  );
}

function DepList({ title, deps, row }: { title: string; deps: Dep[]; row?: (dep: Dep) => { label: string; run: () => void }[] }) {
  if (deps.length === 0) return null;
  return (
    <details className="deps-view__list" open={deps.length <= 12}>
      <summary>{`${title} (${String(deps.length)})`}</summary>
      <ul>
        {deps.map((dep) => (
          <DepRow key={dep.name} dep={dep} actions={row?.(dep)} />
        ))}
      </ul>
    </details>
  );
}

/** "Add a package" input: the name is checked by the backend before anything is shown or run. */
function AddPackage({ placeholder, devLabel, offlineLabel, onAdd }: {
  placeholder: string;
  devLabel?: string;
  offlineLabel?: string;
  onAdd: (name: string, flag: boolean) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [flag, setFlag] = useState(false);
  const submit = () => {
    if (name.trim() === "") return;
    onAdd(name.trim(), flag);
    setName("");
  };
  return (
    <div className="deps-view__add">
      <input
        type="text"
        value={name}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      {devLabel !== undefined || offlineLabel !== undefined ? (
        <label className="deps-view__flag">
          <input type="checkbox" checked={flag} onChange={(event) => { setFlag(event.target.checked); }} />
          {devLabel ?? offlineLabel}
        </label>
      ) : null}
      <ActionButton label={t("deps.view.add")} disabled={name.trim() === ""} onClick={submit} />
    </div>
  );
}

export function PythonSection({ project, run }: { project: ProjectDeps; run: Run }) {
  const t = useT();
  const python = project.python;
  const state = container.dependencies.getState();
  if (python === null) return null;
  const choice = state.pythonEnv[project.path] ?? python.environments[0]?.name ?? "openmind";
  const env = python.environments.find((candidate) => candidate.name === choice) ?? null;
  const hasPyproject = python.manifests.includes("pyproject.toml");
  return (
    <div className="deps-view__eco" aria-label="Python">
      <h4>Python</h4>
      <div className="deps-view__line">
        {env === null
          ? t("deps.view.pythonOpenMind")
          : t("deps.view.pythonEnv", { name: env.name, version: env.version ?? "?", base: env.fromOpenmind ? t("deps.view.openmindBase") : t("deps.view.otherBase") })}
      </div>
      {python.environments.length > 0 ? (
        <select
          className="deps-view__select"
          aria-label={t("deps.view.pythonTarget")}
          value={choice}
          onChange={(event) => {
            container.dependencies.setPythonEnv(project, event.target.value);
          }}
        >
          {python.environments.map((candidate) => (
            <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
          ))}
          <option value="openmind">{t("deps.view.openmindPython")}</option>
        </select>
      ) : null}
      <div className="deps-view__buttons">
        {python.environments.length === 0 ? <ActionButton label={t("deps.view.createVenv")} onClick={() => { run({ op: "pythonCreateEnv" }); }} /> : null}
        {python.manifests.includes("requirements.txt") ? (
          <ActionButton label={t("deps.view.installRequirements")} onClick={() => { run({ op: "pythonInstallRequirements" }); }} />
        ) : null}
        {hasPyproject ? <ActionButton label={t("deps.view.installPyproject")} onClick={() => { run({ op: "pythonInstallPyproject" }); }} /> : null}
      </div>
      {python.missing.length > 0 ? <div className="deps-view__warn">{t("deps.view.missingCount", { count: python.missing.length })}</div> : null}
      <DepList title={t("deps.view.declared")} deps={python.requirements} />
      <DepList
        title={t("deps.view.installed")}
        deps={python.installed.map((p) => ({ name: p.name, spec: "", installed: p.version }))}
        row={(dep) => [
          { label: t("deps.view.update"), run: () => { run({ op: "pythonUpdate", package: dep.name }); } },
          { label: t("deps.view.remove"), run: () => { run({ op: "pythonRemove", package: dep.name }); } },
        ]}
      />
      <AddPackage
        placeholder={t("deps.view.addPython")}
        offlineLabel={t("deps.view.offline")}
        onAdd={(packages, offline) => { run({ op: "pythonAdd", packages, offline }); }}
      />
      {[...python.notes, ...python.skipped.map((line) => t("deps.view.skipped", { line }))].map((note) => (
        <p key={note} className="deps-view__note">{note}</p>
      ))}
    </div>
  );
}

export function NodeSection({ project, run }: { project: ProjectDeps; run: Run }) {
  const t = useT();
  const node = project.node;
  if (node === null) return null;
  const chosen = container.dependencies.getState().nodeManager[project.path] ?? node.packageManager;
  const rows = (dep: Dep) => [
    { label: t("deps.view.update"), run: () => { run({ op: "nodeUpdate", package: dep.name }); } },
    { label: t("deps.view.remove"), run: () => { run({ op: "nodeRemove", package: dep.name }); } },
  ];
  return (
    <div className="deps-view__eco" aria-label="Node.js">
      <h4>Node.js</h4>
      {node.conflict !== null ? <div className="deps-view__warn" role="alert">{node.conflict}</div> : null}
      <div className="deps-view__line">
        {t("deps.view.packageManager")}{" "}
        <select
          className="deps-view__select"
          aria-label={t("deps.view.packageManager")}
          value={chosen ?? ""}
          onChange={(event) => {
            container.dependencies.setNodeManager(project, event.target.value);
          }}
        >
          {chosen === null ? <option value="">{t("deps.view.choose")}</option> : null}
          {["npm", "pnpm", "yarn"].map((manager) => (
            <option key={manager} value={manager}>{manager}</option>
          ))}
        </select>
        {node.lockfiles.length > 0 ? <span className="deps-view__muted"> {node.lockfiles.join(", ")}</span> : null}
      </div>
      <div className="deps-view__buttons">
        <ActionButton label={t("deps.view.installDependencies")} disabled={chosen === null} title={chosen === null ? node.conflict ?? undefined : undefined} onClick={() => { run({ op: "nodeInstall" }); }} />
      </div>
      <DepList title={t("deps.view.dependencies")} deps={node.dependencies} row={rows} />
      <DepList title={t("deps.view.devDependencies")} deps={node.devDependencies} row={rows} />
      <AddPackage
        placeholder={t("deps.view.addNode")}
        devLabel={t("deps.view.dev")}
        onAdd={(pkg, dev) => { run({ op: "nodeAdd", package: pkg, dev }); }}
      />
      {node.scripts.length > 0 ? (
        <details className="deps-view__list" open>
          <summary>{`${t("deps.view.scripts")} (${String(node.scripts.length)})`}</summary>
          <ul>
            {node.scripts.map((script) => (
              <li key={script.name} className="deps-view__dep" title={script.command}>
                <button
                  type="button"
                  className="deps-view__row-action"
                  disabled={!script.runnable}
                  title={script.runnable ? t("deps.view.runScript", { name: script.name }) : t("deps.view.scriptUnsafe")}
                  aria-label={t("deps.view.runScript", { name: script.name })}
                  onClick={() => { run({ op: "nodeRunScript", script: script.name }); }}
                >
                  ▶
                </button>
                <span className="deps-view__dep-name">{script.name}</span>
                <span className="deps-view__muted">{script.command}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {node.notes.map((note) => (
        <p key={note} className="deps-view__note">{note}</p>
      ))}
    </div>
  );
}
