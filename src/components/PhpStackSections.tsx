import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { COMPOSER_ACTIONS } from "../services/composerService";
import { container } from "../services/container";
import type { DatabaseStatus } from "../services/mariaDbService";
import type { Availability } from "../services/runtimeService";

/** A button that is live, or disabled with its reason as tooltip. */
export function StackButton(props: {
  label: string;
  availability: Availability;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        props.primary === true ? "php-view__button php-view__button--primary" : "php-view__button"
      }
      disabled={!props.availability.enabled}
      title={props.availability.enabled ? props.label : props.availability.reason}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

/** A long path: ellipsized in one line, full text in the tooltip, with a Copy button. */
export function PathValue({ path, label }: { path: string | null; label: string }) {
  return (
    <div className="php-view__path-row">
      <code className="php-view__path" title={path ?? undefined}>
        {path ?? "Not set"}
      </code>
      <button
        type="button"
        className="php-view__button php-view__button--small"
        disabled={path === null || path === ""}
        title={path === null ? "Nothing to copy yet." : `Copy ${label}`}
        aria-label={`Copy ${label}`}
        onClick={() => {
          if (path !== null) void container.ipc.clipboardWriteText(path);
        }}
      >
        Copy
      </button>
    </div>
  );
}

/** A port input that validates on blur/Enter and explains a bad value. */
function PortFieldInner(props: {
  id: string;
  label: string;
  value: number;
  locked: boolean;
  lockedReason: string;
  status: string;
  bad: boolean;
  onApply: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState(String(props.value));
  const [problem, setProblem] = useState<string | null>(null);
  const apply = () => {
    void props.onApply(text).then(setProblem);
  };
  return (
    <div className="php-view__field">
      <label className="php-view__label" htmlFor={props.id}>
        {props.label}
      </label>
      <div className="php-view__row">
        <input
          id={props.id}
          className="php-view__input"
          inputMode="numeric"
          value={text}
          disabled={props.locked}
          title={props.locked ? props.lockedReason : "Port on 127.0.0.1"}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={apply}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
          }}
        />
        <span className={props.bad ? "php-view__status php-view__status--bad" : "php-view__status"}>
          {props.status}
        </span>
      </div>
      {problem ? <div className="php-view__error">{problem}</div> : null}
    </div>
  );
}

/** Remounts when the saved port changes, so the text box always starts from it. */
function PortField(props: Parameters<typeof PortFieldInner>[0]) {
  return <PortFieldInner key={props.value} {...props} />;
}

const DATABASE_LABELS: Record<DatabaseStatus, string> = {
  notInstalled: "Not installed",
  needsInit: "Stopped — not initialized",
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  error: "Error",
};

function portStatus(running: boolean, free: boolean | null, owner: string): string {
  if (running) return `In use by ${owner}`;
  if (free === null) return "Checking…";
  return free ? "Free" : "Busy — another program is using it";
}

export function DatabaseSection() {
  useSyncExternalStore(
    (listener) => container.mariaDb.subscribe(listener),
    () => container.mariaDb.getState(),
  );
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  const db = container.mariaDb;
  const state = db.getState();
  const status = db.status();
  const start = db.startState();
  const installed = db.installed();
  return (
    <section className="php-view__section" aria-label="Database">
      <h3>Database</h3>
      <dl className="php-view__facts">
        <dt>Status</dt>
        <dd className={`php-view__db-status php-view__db-status--${status}`}>
          {state.busy === "initializing" ? "Initializing…" : DATABASE_LABELS[status]}
        </dd>
        <dt>Version</dt>
        <dd>{installed?.version ?? "Not installed"}</dd>
        <dt>Host</dt>
        <dd>127.0.0.1 (this computer only)</dd>
        <dt>Username</dt>
        <dd>root</dd>
        <dt>Password</dt>
        <dd>
          {state.passwordVisible && state.password ? (
            <code className="php-view__secret">{state.password}</code>
          ) : (
            db.passwordStatusLabel()
          )}
        </dd>
      </dl>
      <PortField
        id="mariadb-port"
        label="MariaDB port"
        value={state.port}
        locked={state.server !== null}
        lockedReason="Stop MariaDB to change its port."
        status={portStatus(state.server !== null, state.portFree, "MariaDB")}
        bad={state.portFree === false}
        onApply={(text) => db.setPort(text)}
      />
      <div className="php-view__field">
        <span className="php-view__label">Data directory</span>
        <PathValue path={state.dataDir === "" ? null : state.dataDir} label="data directory" />
      </div>
      <div className="php-view__row">
        <StackButton
          label="Initialize Database"
          availability={db.initializeState()}
          onClick={() => {
            void db.initializeDatabase();
          }}
        />
        <StackButton
          label="Start MariaDB"
          availability={start}
          primary
          onClick={() => {
            void db.start();
          }}
        />
        <StackButton
          label="Stop MariaDB"
          availability={db.stopState()}
          onClick={() => {
            void db.stop();
          }}
        />
        <StackButton
          label="Restart MariaDB"
          availability={db.restartState()}
          onClick={() => {
            void db.restart();
          }}
        />
      </div>
      <div className="php-view__row">
        <StackButton
          label={state.passwordVisible ? "Hide Password" : "Show Password"}
          availability={db.passwordState()}
          onClick={() => {
            void db.togglePassword();
          }}
        />
        <StackButton
          label="Copy Password"
          availability={db.passwordState()}
          onClick={() => {
            void db.copyPassword();
          }}
        />
        <button
          type="button"
          className="php-view__button"
          onClick={() => {
            void db.openLogs();
            selectLog("MariaDB");
          }}
        >
          Open MariaDB Logs
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

export function PhpMyAdminSection() {
  useSyncExternalStore(
    (listener) => container.phpMyAdmin.subscribe(listener),
    () => container.phpMyAdmin.getState(),
  );
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  useSyncExternalStore(
    (listener) => container.mariaDb.subscribe(listener),
    () => container.mariaDb.getState(),
  );
  const pma = container.phpMyAdmin;
  const state = pma.getState();
  const start = pma.startState();
  const note = pma.databaseNote();
  const notice = pma.restartNotice();
  return (
    <section className="php-view__section" aria-label="phpMyAdmin">
      <h3>phpMyAdmin</h3>
      <dl className="php-view__facts">
        <dt>Status</dt>
        <dd>
          {state.server ? (
            <>
              Running at{" "}
              <a
                href={state.server.url ?? undefined}
                onClick={(event) => {
                  event.preventDefault();
                  void pma.open();
                }}
              >
                {state.server.url}
              </a>
            </>
          ) : pma.installedVersion() === null ? (
            "Not installed"
          ) : (
            "Stopped"
          )}
        </dd>
        <dt>Version</dt>
        <dd>{pma.installedVersion() ?? "Not installed"}</dd>
      </dl>
      <PortField
        id="pma-port"
        label="phpMyAdmin port"
        value={state.port}
        locked={state.server !== null}
        lockedReason="Stop phpMyAdmin to change its port."
        status={portStatus(state.server !== null, state.portFree, "phpMyAdmin")}
        bad={state.portFree === false}
        onApply={(text) => pma.setPort(text)}
      />
      <div className="php-view__row">
        <StackButton
          label="Start phpMyAdmin"
          availability={start}
          primary
          onClick={() => {
            void pma.start();
          }}
        />
        <StackButton
          label="Stop phpMyAdmin"
          availability={pma.stopState()}
          onClick={() => {
            void pma.stop();
          }}
        />
        <StackButton
          label="Open phpMyAdmin"
          availability={pma.openState()}
          onClick={() => {
            void pma.open();
          }}
        />
        <button
          type="button"
          className="php-view__button"
          onClick={() => {
            void pma.openLogs();
            selectLog("phpMyAdmin");
          }}
        >
          Open phpMyAdmin Logs
        </button>
      </div>
      {!start.enabled && state.server === null ? (
        <div className="php-view__reason" role="note">
          {start.reason}
        </div>
      ) : null}
      {note ? (
        <div className="php-view__notice" role="status">
          {note}
        </div>
      ) : null}
      {notice ? (
        <div className="php-view__notice" role="status">
          {notice}
        </div>
      ) : null}
      {state.error ? <div className="php-view__error">{state.error}</div> : null}
      <span className="php-view__hint">
        Log in with user root and the MariaDB password above. Served on 127.0.0.1 only.
      </span>
    </section>
  );
}

export function ComposerSection() {
  useSyncExternalStore(
    (listener) => container.composer.subscribe(listener),
    () => container.composer.getState(),
  );
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  useSyncExternalStore(
    (listener) => container.php.subscribe(listener),
    () => container.php.getState(),
  );
  const composer = container.composer;
  const state = composer.getState();
  const availability = composer.availability();
  return (
    <section className="php-view__section" aria-label="Composer">
      <h3>Composer</h3>
      <div className="php-view__row">
        {COMPOSER_ACTIONS.map((entry) => (
          <StackButton
            key={entry.action}
            label={entry.label}
            availability={availability}
            onClick={() => {
              void composer.run(entry.action);
            }}
          />
        ))}
        <StackButton
          label="Stop Composer"
          availability={composer.stopState()}
          onClick={() => {
            void composer.stop();
          }}
        />
      </div>
      {state.running ? (
        <div className="php-view__progress" role="status">
          Running composer {state.runningAction ?? ""}…
        </div>
      ) : null}
      {!availability.enabled && state.running === null ? (
        <div className="php-view__reason" role="note">
          {availability.reason}
        </div>
      ) : null}
      {state.lastResult ? <div className="php-view__hint">{state.lastResult}</div> : null}
      {state.error ? <div className="php-view__error">{state.error}</div> : null}
      <span className="php-view__hint">
        Runs in the project folder above on the active portable PHP; its output is in Logs.
      </span>
    </section>
  );
}

let logChannel = "PHP Server";
const logListeners = new Set<() => void>();
function subscribeLog(listener: () => void): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}
/** Which service log the Logs section shows (view state only). */
function selectLog(name: string): void {
  logChannel = name;
  for (const listener of logListeners) listener();
}

const LOG_CHANNELS = ["PHP Server", "MariaDB", "phpMyAdmin", "Composer"] as const;

/** The four service logs, one at a time, in a panel that scrolls inside itself. */
export function LogsSection() {
  useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getState(),
  );
  const channel = useSyncExternalStore(subscribeLog, () => logChannel);
  const lines = container.output.getLines(channel).slice(-300);
  const sectionRef = useRef<HTMLElement | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length, channel]);
  useEffect(() => {
    sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [channel]);
  return (
    <section className="php-view__section" aria-label="Logs" ref={sectionRef}>
      <h3>Logs</h3>
      <div className="php-view__row" role="tablist" aria-label="Log channel">
        {LOG_CHANNELS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === channel}
            className={
              name === channel
                ? "php-view__button php-view__button--small php-view__button--primary"
                : "php-view__button php-view__button--small"
            }
            onClick={() => {
              selectLog(name);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {lines.length === 0 ? (
        <div className="php-view__hint">No {channel} output yet.</div>
      ) : (
        <pre className="php-view__log" ref={logRef} tabIndex={0}>
          {lines.join("\n")}
        </pre>
      )}
    </section>
  );
}
