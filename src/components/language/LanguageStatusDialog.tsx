import { useEffect, useSyncExternalStore } from "react";

import "../../styles/language.css";

import { container } from "../../services/container";
import type { ProjectStatus } from "../../services/language/languageIpc";
import { LEVEL_LABELS, syntaxNote } from "../../services/language/languageRegistry";
import {
  CATEGORY_LABELS,
  CONFIDENCE_LABELS,
  formatOptionLine,
  groupCommands,
  lspLine,
  toolLine,
  type StatusLine,
} from "../../services/language/languageView";

function useLanguageState() {
  useSyncExternalStore(
    (listener) => container.language.support.subscribe(listener),
    () => container.language.support.getState(),
  );
  useSyncExternalStore(
    (listener) => container.lsp.subscribe(listener),
    () => container.lsp.getState(),
  );
  return container.language.support.getState();
}

function Lines({ lines, empty }: { lines: StatusLine[]; empty: string }) {
  if (lines.length === 0) return <p className="lang-muted">{empty}</p>;
  return (
    <ul className="lang-lines">
      {lines.map((line) => (
        <li key={line.label} className={`lang-line lang-line--${line.tone}`}>
          <span className="lang-line__dot" aria-hidden="true" />
          <span className="lang-line__label">{line.label}</span>
          <span className="lang-line__detail">{line.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function CurrentFile() {
  const state = useLanguageState();
  const active = container.language.activeText();
  const file = state.file;
  if (active?.path == null) {
    return (
      <p className="lang-muted">
        Open a saved text file to see its language, language server, formatter and linter.
      </p>
    );
  }
  if (file === null || file.path.toLowerCase() !== active.path.replace(/\\/g, "/").toLowerCase()) {
    return <p className="lang-muted">{state.fileError ?? "Looking up this file…"}</p>;
  }
  const language = file.language;
  const servers = container.lsp.servers();
  return (
    <>
      <p className="lang-file" title={file.path}>
        {file.path.split("/").pop()}
      </p>
      {language === null ? (
        <p className="lang-muted">
          Unknown language: OpenMind has no support entry for this file type, so there is no
          highlighting, language server or formatter for it.
        </p>
      ) : (
        <>
          <p>
            <strong>{language.name}</strong> · {language.group}
          </p>
          <p className="lang-chips" aria-label="Support levels">
            {language.levels.map((level) => (
              <span key={level} className="lang-chip">
                {LEVEL_LABELS[level]}
              </span>
            ))}
          </p>
          <p className="lang-muted">{syntaxNote(language)}</p>
          <h4>Language server</h4>
          <Lines
            lines={file.lsp.map((candidate) => lspLine(candidate, servers))}
            empty="No language server is known for this language."
          />
          <h4>Formatters</h4>
          <Lines
            lines={file.formatters.map(formatOptionLine)}
            empty="No formatter is known for this language."
          />
          <h4>Linters</h4>
          <Lines
            lines={file.linters.map(formatOptionLine)}
            empty="No linter is known for this language."
          />
        </>
      )}
    </>
  );
}

function ProjectCommands({ project }: { project: ProjectStatus }) {
  const service = container.language.projects;
  const groups = groupCommands(project.commandStatus);
  if (groups.length === 0) {
    return <p className="lang-muted">No commands are known for this project.</p>;
  }
  const blocked = project.commandStatus.filter((command) => !command.available);
  return (
    <>
      {groups.map(([category, commands]) => (
        <div
          key={category}
          className="lang-commands"
          role="group"
          aria-label={CATEGORY_LABELS[category]}
        >
          <span className="lang-commands__label">{CATEGORY_LABELS[category]}</span>
          {commands.map((command) => {
            const state = service.availability(command);
            return (
              <button
                key={command.id}
                type="button"
                className="lang-command"
                disabled={!state.enabled}
                title={state.reason ?? service.describe(command)}
                onClick={() => {
                  void service.runCommand(command);
                }}
              >
                {command.label}
              </button>
            );
          })}
        </div>
      ))}
      {blocked.length > 0 ? (
        <ul className="lang-reasons" aria-label="Unavailable commands">
          {blocked.map((command) => (
            <li key={command.id}>
              <strong>{command.label}:</strong> {command.reason ?? "unavailable"}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function ProjectCard({ project }: { project: ProjectStatus }) {
  return (
    <section className="lang-project" aria-label={project.title}>
      <h4>
        {project.title}
        <span className="lang-muted">
          {" "}
          · {project.root === "" ? "the open folder" : project.root}
        </span>
      </h4>
      <p>{project.summary}</p>
      <p className="lang-chips" aria-label="Detected">
        {project.detections.map((detection) => (
          <span key={detection.id} className="lang-chip" title={detection.evidence}>
            {detection.name} · {CONFIDENCE_LABELS[detection.confidence]}
          </span>
        ))}
      </p>
      {project.ambiguous ? (
        <p className="lang-warn" role="note">
          This project could be more than one thing; every candidate is listed and none is assumed.
        </p>
      ) : null}
      {project.notes.map((note) => (
        <p key={note} className="lang-muted" role="note">
          {note}
        </p>
      ))}
      <Lines lines={project.toolStatus.map(toolLine)} empty="No tools are needed." />
      <ProjectCommands project={project} />
    </section>
  );
}

function Projects() {
  const state = useLanguageState();
  if (state.scanError !== null) return <p className="lang-warn">{state.scanError}</p>;
  if (state.workspace === null) {
    return (
      <p className="lang-muted">
        {state.scanning ? "Looking at the folder…" : "Open a folder to detect its projects."}
      </p>
    );
  }
  if (state.workspace.projects.length === 0) {
    return (
      <p className="lang-muted">
        No project detected in this folder (Unknown project type). OpenMind looks for files such as
        package.json, Cargo.toml, go.mod, pubspec.yaml, composer.json, pom.xml, a Gradle build or a
        .csproj.
      </p>
    );
  }
  return (
    <>
      {state.workspace.projects.map((project) => (
        <ProjectCard key={project.root} project={project} />
      ))}
    </>
  );
}

function Toolchains() {
  const state = useLanguageState();
  const tools = state.workspace?.tools ?? [];
  return (
    <Lines lines={tools.map(toolLine)} empty="Open a folder to check the tools on this computer." />
  );
}

/**
 * The Project & Language Status window: the current file's language and tools, every project detected in the open
 * folder with its commands (each disabled with its reason when a tool or platform is missing), and the toolchains on
 * this computer. UI only; nothing here runs until a command button is clicked.
 */
export function LanguageStatusDialog() {
  const open = useSyncExternalStore(
    (listener) => container.language.ui.subscribe(listener),
    () => container.language.ui.isOpen(),
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") container.language.ui.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!open) return null;
  const scanning = container.language.support.getState().scanning;
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        container.language.ui.setOpen(false);
      }}
    >
      <div
        className="modal modal--wide lang-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lang-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="lang-title">Project &amp; Language Status</h2>
        <p className="lang-muted">
          What OpenMind found in this folder and on this computer. Looking never runs, installs or
          downloads anything; a command runs in the terminal only when you click it.
        </p>
        <h3>Current file</h3>
        <CurrentFile />
        <h3>Projects</h3>
        <Projects />
        <h3>Tools on this computer</h3>
        <Toolchains />
        <div className="modal__actions">
          <button
            type="button"
            disabled={scanning}
            onClick={() => {
              container.run("language.refresh");
            }}
          >
            {scanning ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="modal__confirm--primary"
            onClick={() => {
              container.language.ui.setOpen(false);
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
