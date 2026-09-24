import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { Availability } from "../services/runtimeService";
import { PHP_CHANNEL, type ComponentView, type StackComponent } from "../services/phpServerService";

/** Components that are part of the plan but not built — listed honestly, with the reason. */
const PLANNED = [
  {
    label: "Apache",
    reason: "Apache isn't available yet — planned after the PHP built-in server.",
  },
  {
    label: "MariaDB",
    reason: "MariaDB isn't available yet — planned after the PHP built-in server.",
  },
  {
    label: "phpMyAdmin",
    reason: "phpMyAdmin isn't available yet — it needs Apache or PHP plus MariaDB.",
  },
] as const;

function usePhp() {
  useSyncExternalStore(
    (listener) => container.php.subscribe(listener),
    () => container.php.getState(),
  );
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getState(),
  );
  return container.php;
}

/** A button that is either live or disabled with its reason as tooltip. */
function Action(props: {
  label: string;
  availability: Availability;
  onClick: () => void;
  primary?: boolean;
}) {
  const { availability } = props;
  return (
    <button
      type="button"
      className={
        props.primary === true ? "php-view__button php-view__button--primary" : "php-view__button"
      }
      disabled={!availability.enabled}
      title={availability.enabled ? props.label : availability.reason}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function ComponentRow({ view }: { view: ComponentView }) {
  const php = usePhp();
  const id: StackComponent = view.id;
  const status =
    view.state === "notInstalled"
      ? "Not installed"
      : view.state === "needsRepair"
        ? `Needs repair${view.version ? ` (${view.version})` : ""}`
        : `Installed${view.version ? ` — ${view.version}` : ""}`;
  return (
    <div className="php-view__component">
      <div className="php-view__component-head">
        <strong>{view.label}</strong>
        <span className={`php-view__status php-view__status--${view.state}`}>{status}</span>
      </div>
      {view.working ? (
        <div className="php-view__progress" role="status">
          {view.progressLabel ?? "Working…"}
        </div>
      ) : null}
      {view.error ? <div className="php-view__error">{view.error}</div> : null}
      <div className="php-view__row">
        <Action
          label={`Install ${view.label}`}
          availability={php.installState(id)}
          primary
          onClick={() => {
            void php.install(id);
          }}
        />
        {id === "php" ? (
          <Action
            label="Repair PHP"
            availability={php.repairState(id)}
            onClick={() => {
              void php.repair(id);
            }}
          />
        ) : null}
        <Action
          label={`Delete ${view.label}`}
          availability={php.deleteState(id)}
          onClick={() => {
            void php.remove(id);
          }}
        />
      </div>
    </div>
  );
}

function ProjectSection() {
  const php = usePhp();
  const { root } = php.getState();
  const workspace = container.workspace.getActiveWorkspace();
  return (
    <section className="php-view__section" aria-label="Project">
      <h3>Project</h3>
      <div className="php-view__field">
        <span className="php-view__label">Document root</span>
        <code className="php-view__value" title={root ?? undefined}>
          {root ?? "No folder selected"}
        </code>
      </div>
      <div className="php-view__row">
        <button
          type="button"
          className="php-view__button"
          disabled={workspace === null}
          title={workspace === null ? "Open a folder first." : "Serve the open workspace folder"}
          onClick={() => {
            void php.useWorkspace();
          }}
        >
          Use Current Workspace
        </button>
        <button
          type="button"
          className="php-view__button"
          onClick={() => {
            void php.selectFolder();
          }}
        >
          Select Folder…
        </button>
      </div>
    </section>
  );
}

function PortSection() {
  const php = usePhp();
  const state = php.getState();
  const [text, setText] = useState(String(state.port));
  const [problem, setProblem] = useState<string | null>(null);
  const locked = state.server !== null;
  const apply = () => {
    void php.setPort(text).then(setProblem);
  };
  const free =
    state.server !== null
      ? "In use by the PHP server"
      : state.portFree === null
        ? "Checking…"
        : state.portFree
          ? "Free"
          : "Busy — another program is using it";
  return (
    <section className="php-view__section" aria-label="Ports">
      <h3>Ports</h3>
      <div className="php-view__field">
        <label className="php-view__label" htmlFor="php-port">
          PHP built-in server
        </label>
        <div className="php-view__row">
          <input
            id="php-port"
            className="php-view__input"
            inputMode="numeric"
            value={text}
            disabled={locked}
            title={locked ? "Stop the server to change its port." : "Port on 127.0.0.1"}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onBlur={apply}
            onKeyDown={(event) => {
              if (event.key === "Enter") apply();
            }}
          />
          <span
            className={
              state.portFree === false
                ? "php-view__status php-view__status--bad"
                : "php-view__status"
            }
          >
            {free}
          </span>
        </div>
        {problem ? <div className="php-view__error">{problem}</div> : null}
        <span className="php-view__hint">
          Bound to 127.0.0.1 only — not reachable from the network.
        </span>
      </div>
    </section>
  );
}

function ServerSection() {
  const php = usePhp();
  const state = php.getState();
  const start = php.startState();
  return (
    <section className="php-view__section" aria-label="Server">
      <h3>Server</h3>
      <div className="php-view__field">
        <span className="php-view__label">Status</span>
        {state.server ? (
          <span className="php-view__status php-view__status--installed">
            Running at{" "}
            <a
              href={state.server.url}
              onClick={(event) => {
                event.preventDefault();
                container.run("php.openBrowser");
              }}
            >
              {state.server.url}
            </a>{" "}
            (pid {state.server.pid})
          </span>
        ) : (
          <span className="php-view__status">Stopped</span>
        )}
      </div>
      <div className="php-view__row">
        <Action
          label="Start Server"
          availability={start}
          primary
          onClick={() => {
            container.run("php.startServer");
          }}
        />
        <Action
          label="Stop Server"
          availability={php.stopState()}
          onClick={() => {
            container.run("php.stopServer");
          }}
        />
        <Action
          label="Restart Server"
          availability={php.restartState()}
          onClick={() => {
            container.run("php.restartServer");
          }}
        />
      </div>
      <div className="php-view__row">
        <Action
          label="Open Browser"
          availability={php.browserState()}
          onClick={() => {
            container.run("php.openBrowser");
          }}
        />
        <button
          type="button"
          className="php-view__button"
          onClick={() => {
            container.run("php.openLogs");
          }}
        >
          Open Logs
        </button>
      </div>
      {!start.enabled && state.server === null ? (
        <div className="php-view__reason" role="note">
          {start.reason}
        </div>
      ) : null}
      {state.error ? <div className="php-view__error">{state.error}</div> : null}
    </section>
  );
}

function LogsSection() {
  usePhp();
  const lines = container.output.getLines(PHP_CHANNEL).slice(-8);
  return (
    <section className="php-view__section" aria-label="Logs">
      <h3>Logs</h3>
      {lines.length === 0 ? (
        <div className="php-view__hint">
          No server output yet. Start the server to see requests here.
        </div>
      ) : (
        <pre className="php-view__log">{lines.join("\n")}</pre>
      )}
    </section>
  );
}

/**
 * The PHP Server side bar view: document root, runtime status for PHP and
 * Composer (installed through the Runtime Manager), the built-in server's
 * controls, its port, and its recent log. UI only — every decision and
 * disabled reason comes from `PhpServerService`.
 */
export function PhpServerView() {
  const php = usePhp();
  useEffect(() => {
    void container.runtime.initialize();
    void container.runtime.refresh();
  }, []);
  return (
    <div className="php-view">
      <ProjectSection />
      <section className="php-view__section" aria-label="Runtime Status">
        <h3>Runtime Status</h3>
        <ComponentRow view={php.component("php")} />
        <ComponentRow view={php.component("composer")} />
        {PLANNED.map((item) => (
          <div
            key={item.label}
            className="php-view__component php-view__component--planned"
            title={item.reason}
          >
            <div className="php-view__component-head">
              <strong>{item.label}</strong>
              <span className="php-view__status">Not available yet</span>
            </div>
            <span className="php-view__hint">{item.reason}</span>
          </div>
        ))}
      </section>
      <ServerSection />
      <PortSection />
      <LogsSection />
    </div>
  );
}
