import { useEffect, useSyncExternalStore } from "react";

import "../../styles/dependencies.css";
import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { Dep, DepsOp, ProjectDeps } from "../../services/deps/depsIpc";
import { ActionButton, NodeSection, PythonSection } from "./dependencySections";

type Run = (op: DepsOp) => void;

function PlainList({ title, deps }: { title: string; deps: Dep[] }) {
  if (deps.length === 0) return null;
  return (
    <details className="deps-view__list">
      <summary>{`${title} (${String(deps.length)})`}</summary>
      <ul>
        {deps.map((dep) => (
          <li key={dep.name} className="deps-view__dep">
            <span className="deps-view__dep-name">{dep.name}</span>
            <span className="deps-view__muted">{dep.spec}</span>
            {dep.installed !== null ? <span className="deps-view__chip">{dep.installed}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PhpSection({ project, run }: { project: ProjectDeps; run: Run }) {
  const t = useT();
  const php = project.php;
  if (php === null) return null;
  return (
    <div className="deps-view__eco" aria-label="Composer">
      <h4>PHP (Composer)</h4>
      <div className="deps-view__line">{php.vendor ? t("deps.view.vendorPresent") : t("deps.view.vendorMissing")}</div>
      <div className="deps-view__buttons">
        <ActionButton label={t("deps.view.installDependencies")} onClick={() => { run({ op: "composerInstall" }); }} />
        <ActionButton label="dump-autoload" onClick={() => { run({ op: "composerDumpAutoload" }); }} />
      </div>
      <PlainList title={t("deps.view.dependencies")} deps={php.require} />
      <PlainList title={t("deps.view.devDependencies")} deps={php.requireDev} />
      <PlainList title={t("deps.view.platform")} deps={php.platform} />
      <ComposerPackage run={run} />
    </div>
  );
}

function ComposerPackage({ run }: { run: Run }) {
  const t = useT();
  return (
    <form
      className="deps-view__add"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const text = (key: string) => {
          const value = form.get(key);
          return typeof value === "string" ? value : "";
        };
        const name = text("package").trim();
        const action = text("action") || "require";
        if (name === "") return;
        const op: DepsOp =
          action === "remove"
            ? { op: "composerRemove", package: name }
            : action === "update"
              ? { op: "composerUpdate", package: name }
              : { op: "composerRequire", package: name, dev: action === "requireDev" };
        run(op);
        event.currentTarget.reset();
      }}
    >
      <input name="package" type="text" placeholder="vendor/package" aria-label="vendor/package" spellCheck={false} />
      <select name="action" className="deps-view__select" aria-label={t("deps.confirm.action")}>
        <option value="require">{t("deps.view.add")}</option>
        <option value="requireDev">{t("deps.view.addDev")}</option>
        <option value="update">{t("deps.view.update")}</option>
        <option value="remove">{t("deps.view.remove")}</option>
      </select>
      <button type="submit" className="deps-view__action">{t("deps.view.go")}</button>
    </form>
  );
}

function BuildSection({ project, run }: { project: ProjectDeps; run: Run }) {
  const t = useT();
  const { rust, java, cmake } = project;
  return (
    <>
      {rust !== null ? (
        <div className="deps-view__eco" aria-label="Rust">
          <h4>Rust (Cargo)</h4>
          <div className="deps-view__line">
            {[rust.name, rust.version, rust.edition === null ? null : `edition ${rust.edition}`].filter(Boolean).join(" · ") ||
              (rust.workspaceOnly ? t("deps.view.cargoWorkspace") : "")}
          </div>
          <div className="deps-view__buttons">
            {(["check", "build", "test", "run"] as const).map((command) => (
              <ActionButton key={command} label={`cargo ${command}`} onClick={() => { run({ op: "cargo", command }); }} />
            ))}
          </div>
          <PlainList title={t("deps.view.dependencies")} deps={rust.dependencies} />
          <PlainList title={t("deps.view.devDependencies")} deps={rust.devDependencies} />
          {rust.features.length > 0 ? <p className="deps-view__note">{t("deps.view.features", { list: rust.features.join(", ") })}</p> : null}
        </div>
      ) : null}
      {java !== null ? (
        <div className="deps-view__eco" aria-label="Java">
          <h4>Java ({[java.maven ? "Maven" : null, java.gradle ? "Gradle" : null].filter(Boolean).join(" + ")})</h4>
          <div className="deps-view__buttons">
            {java.maven
              ? (["compile", "test", "package"] as const).map((goal) => (
                  <ActionButton key={goal} label={`mvn ${goal}`} onClick={() => { run({ op: "maven", goal }); }} />
                ))
              : null}
            {java.gradle
              ? (["build", "test"] as const).map((task) => (
                  <ActionButton key={task} label={`${java.gradleWrapper ? "gradlew" : "gradle"} ${task}`} onClick={() => { run({ op: "gradle", task }); }} />
                ))
              : null}
          </div>
          {java.gradle && !java.gradleWrapper ? <p className="deps-view__note">{t("deps.view.noWrapper")}</p> : null}
        </div>
      ) : null}
      {cmake !== null ? (
        <div className="deps-view__eco" aria-label="CMake">
          <h4>C/C++ (CMake)</h4>
          <div className="deps-view__buttons">
            <ActionButton label={t("deps.view.configure")} onClick={() => { run({ op: "cmakeConfigure", preset: null }); }} />
            {cmake.presets.map((preset) => (
              <ActionButton key={preset} label={t("deps.view.configurePreset", { preset })} onClick={() => { run({ op: "cmakeConfigure", preset }); }} />
            ))}
            <ActionButton label={t("deps.view.build")} disabled={!cmake.configured} title={cmake.configured ? undefined : t("deps.view.configureFirst")} onClick={() => { run({ op: "cmakeBuild" }); }} />
            <ActionButton label={t("deps.view.clean")} disabled={!cmake.configured} title={cmake.configured ? undefined : t("deps.view.configureFirst")} onClick={() => { run({ op: "cmakeClean" }); }} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ProjectBlock({ project, busy }: { project: ProjectDeps; busy: boolean }) {
  const run: Run = (op) => {
    if (!busy) void container.dependencies.run(project, op);
  };
  return (
    <section className="deps-view__project" aria-label={project.name}>
      <h3 title={project.path}>
        {project.name}
        {project.root !== "" ? <span className="deps-view__muted"> {project.root}</span> : null}
      </h3>
      <PythonSection project={project} run={run} />
      <NodeSection project={project} run={run} />
      <PhpSection project={project} run={run} />
      <BuildSection project={project} run={run} />
    </section>
  );
}

/**
 * The Dependencies side bar view: each project of the open folder with only the ecosystems it uses. Reading is local;
 * every button asks the backend for the exact command and shows it before anything runs.
 */
export function DependenciesView() {
  const t = useT();
  const state = useSyncExternalStore(container.dependencies.subscribe, container.dependencies.getState);
  useEffect(() => {
    void container.dependencies.refresh();
  }, []);
  const projects = state.snapshot?.projects ?? [];
  return (
    <div className="deps-view">
      <div className="deps-view__toolbar">
        <button type="button" className="deps-view__action" disabled={state.loading} onClick={() => void container.dependencies.refresh()}>
          {state.loading ? t("deps.view.reading") : t("deps.view.refresh")}
        </button>
      </div>
      {state.error !== null ? <p className="deps-view__warn" role="alert">{state.error}</p> : null}
      {state.snapshot !== null && projects.length === 0 ? <p className="deps-view__empty">{t("deps.view.empty")}</p> : null}
      {projects.map((project) => (
        <ProjectBlock key={project.path} project={project} busy={state.busy} />
      ))}
    </div>
  );
}
