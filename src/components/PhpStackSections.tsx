import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { COMPOSER_ACTIONS } from "../services/composerService";
import { container } from "../services/container";
import type { DatabaseStatus } from "../services/mariaDbService";
import {
  adminAvailability,
  composerChip,
  LOCAL_HOST,
  mariaDbChip,
  phpMyAdminChip,
} from "../services/phpConfigModel";
import type { Availability } from "../services/runtimeService";
import { CredentialsBlock } from "./phpConfig/CredentialsBlock";
import { Card, Facts } from "./phpConfig/parts";
import { t } from "../i18n";

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
        {path ?? t("php.notSet")}
      </code>
      <button
        type="button"
        className="php-view__button php-view__button--small"
        disabled={path === null || path === ""}
        title={path === null ? t("php.nothingToCopy") : t("php.copyNamed", { name: label })}
        aria-label={t("php.copyNamed", { name: label })}
        onClick={() => {
          if (path !== null) void container.ipc.clipboardWriteText(path);
        }}
      >
        {t("common.copy")}
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
  notInstalled: "runtimes.notInstalled",
  needsInit: "php.db.needsInit",
  stopped: "php.status.stopped",
  starting: "php.status.starting",
  running: "php.status.running",
  error: "php.status.error",
};

function portStatus(running: boolean, free: boolean | null, owner: string): string {
  if (running) return t("php.port.inUseBy", { owner });
  if (free === null) return t("extContrib.checking");
  return free ? t("php.port.free") : t("php.port.busy");
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
  const statusText =
    state.busy === "initializing" ? t("php.db.initializing") : t(DATABASE_LABELS[status]);
  return (
    <Card
      title="MariaDB"
      label={t("php.database")}
      chip={mariaDbChip(status)}
      description={t("php.db.description")}
    >
      <Facts
        rows={[
          {
            label: t("extDetails.status"),
            value: (
              <span className={`php-view__db-status php-view__db-status--${status}`}>
                {statusText}
              </span>
            ),
          },
          { label: t("extDetails.version"), value: installed?.version ?? t("runtimes.notInstalled") },
          { label: t("php.bindAddress"), value: t("php.thisComputerOnly", { host: LOCAL_HOST }) },
        ]}
      />
      <PortField
        id="mariadb-port"
        label={t("php.db.port")}
        value={state.port}
        locked={state.server !== null}
        lockedReason={t("php.db.portLocked")}
        status={portStatus(state.server !== null, state.portFree, "MariaDB")}
        bad={state.portFree === false}
        onApply={(text) => db.setPort(text)}
      />
      <div className="php-view__field">
        <span className="php-view__label">{t("php.dataDirectory")}</span>
        <PathValue path={state.dataDir === "" ? null : state.dataDir} label={t("php.dataDirectoryLower")} />
      </div>
      <div className="php-view__field">
        <span className="php-view__label">{t("php.configFile")}</span>
        <PathValue
          path={state.configFile === "" ? null : state.configFile}
          label={t("php.db.configFileLower")}
        />
        {state.configFile === "" ? (
          <span className="php-view__hint">{t("php.db.configCreated")}</span>
        ) : null}
      </div>
      <div className="php-view__field">
        <span className="php-view__label">{t("php.logDirectory")}</span>
        <PathValue path={state.logDir === "" ? null : state.logDir} label={t("php.logDirectoryLower")} />
      </div>
      <div className="php-view__row">
        <StackButton
          label={t("php.db.initialize")}
          availability={db.initializeState()}
          onClick={() => {
            void db.initializeDatabase();
          }}
        />
        <StackButton
          label={t("php.db.start")}
          availability={start}
          primary
          onClick={() => {
            void db.start();
          }}
        />
        <StackButton
          label={t("php.db.stop")}
          availability={db.stopState()}
          onClick={() => {
            void db.stop();
          }}
        />
        <StackButton
          label={t("php.db.restart")}
          availability={db.restartState()}
          onClick={() => {
            void db.restart();
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
          {t("php.db.openLogs")}
        </button>
      </div>
      {!start.enabled && state.server === null ? (
        <div className="php-view__reason" role="note">
          {start.reason}
        </div>
      ) : null}
      {state.error ? <div className="php-view__error">{state.error}</div> : null}
      <CredentialsBlock />
    </Card>
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
  const installedVersion = pma.installedVersion();
  const running = state.server !== null;
  const url = state.server?.url ?? null;
  const admin = adminAvailability({
    installed: installedVersion !== null,
    running,
    dbStatus: container.mariaDb.status(),
    url,
  });
  const open = pma.openState();
  return (
    <Card
      title="phpMyAdmin"
      label="phpMyAdmin"
      chip={phpMyAdminChip({ installed: installedVersion !== null, running })}
      description={t("php.pma.description")}
    >
      <Facts
        rows={[
          {
            label: t("extDetails.status"),
            value: state.server ? (
              <>
                {t("php.pma.runningAt")}{" "}
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
            ) : installedVersion === null ? (
              t("runtimes.notInstalled")
            ) : (
              t("php.status.stopped")
            ),
          },
          { label: t("extDetails.version"), value: installedVersion ?? t("runtimes.notInstalled") },
          { label: t("php.col.address"), value: url ?? t("php.noneUntilRuns") },
        ]}
      />
      <PortField
        id="pma-port"
        label={t("php.pma.port")}
        value={state.port}
        locked={state.server !== null}
        lockedReason={t("php.pma.portLocked")}
        status={portStatus(state.server !== null, state.portFree, "phpMyAdmin")}
        bad={state.portFree === false}
        onApply={(text) => pma.setPort(text)}
      />
      <div className="php-view__row">
        <StackButton
          label={t("php.pma.start")}
          availability={start}
          primary
          onClick={() => {
            void pma.start();
          }}
        />
        <StackButton
          label={t("php.pma.stop")}
          availability={pma.stopState()}
          onClick={() => {
            void pma.stop();
          }}
        />
        <StackButton
          label={t("php.pma.open")}
          availability={open.enabled && !admin.enabled ? admin : open}
          onClick={() => {
            void pma.open();
          }}
        />
        <StackButton
          label={t("php.pma.copyUrl")}
          availability={
            url === null
              ? { enabled: false, reason: t("php.pma.noAddress") }
              : { enabled: true }
          }
          onClick={() => {
            if (url !== null) void container.ipc.clipboardWriteText(url);
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
          {t("php.pma.openLogs")}
        </button>
      </div>
      {!start.enabled && !running ? (
        <div className="php-view__reason" role="note">
          {start.reason}
        </div>
      ) : null}
      {!admin.enabled && installedVersion !== null && admin.reason ? (
        <div className="php-view__reason" role="note">
          {t("php.adminReason", { reason: admin.reason })}
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
        {t("php.pma.loginHint")}
      </span>
    </Card>
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
  const composer = container.composer;
  const composerRuntime = container.runtime
    .getState()
    .runtimes.find((entry) => entry.id === "composer");
  const composerActive = composerRuntime?.installed.find((entry) => entry.active) ?? null;
  const state = composer.getState();
  const availability = composer.availability();
  return (
    <Card
      title="Composer"
      label="Composer"
      chip={composerChip({
        installed: (composerRuntime?.installed.length ?? 0) > 0,
        active: composerActive?.version ?? null,
      })}
      description="Install and update the PHP packages of one project, on OpenMind's PHP."
    >
      <div className="php-view__field">
        <span className="php-view__label">Project folder</span>
        <PathValue path={state.projectRoot} label="Composer project folder" />
        <div className="php-view__row">
          <button
            type="button"
            className="php-view__button"
            onClick={() => {
              void composer.selectProject();
            }}
          >
            Select Project…
          </button>
        </div>
      </div>
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
        Runs in the project folder above (usually one inside the web root) on the active portable
        PHP; its output is in Logs.
      </span>
    </Card>
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
    <section className="php-view__section pcfg-card" aria-label="Logs" ref={sectionRef}>
      <header className="pcfg-card__head">
        <h3>Logs</h3>
      </header>
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
