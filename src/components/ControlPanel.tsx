import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import appIcon from "../../src-tauri/icons/32x32.png";
import { container } from "../services/container";
import type { ModuleRow } from "../services/controlPanelService";
import { MODULE_NAMES } from "../services/controlPanelService";
import type { Availability } from "../services/runtimeService";
import "../styles/controlPanel.css";
import {
  ConfigIcon,
  ExplorerIcon,
  HelpIcon,
  NetstatIcon,
  QuitIcon,
  ShellIcon,
} from "./controlPanelIcons";
import { ConfigChips } from "./phpConfig/ConfigHeader";
import { PhpServerView } from "./PhpServerView";
import { t } from "../i18n";

/** Re-renders when the panel or any module service changes. */
function usePanel() {
  useSyncExternalStore(
    (listener) => container.controlPanel.subscribe(listener),
    () => container.controlPanel.getState(),
  );
  useSyncExternalStore(
    (listener) => container.php.subscribe(listener),
    () => container.php.getState(),
  );
  useSyncExternalStore(
    (listener) => container.mariaDb.subscribe(listener),
    () => container.mariaDb.getState(),
  );
  useSyncExternalStore(
    (listener) => container.phpMyAdmin.subscribe(listener),
    () => container.phpMyAdmin.getState(),
  );
  useSyncExternalStore(container.mySql.subscribe, container.mySql.getState);
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  return container.controlPanel;
}

function PanelButton(props: {
  label: string;
  /** What the button shows when shorter than its accessible label. */
  text?: string;
  availability?: Availability;
  onClick: () => void;
  active?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const availability = props.availability ?? { enabled: true };
  const classes = ["cp__button"];
  if (props.className !== undefined) classes.push(props.className);
  if (props.active === true) classes.push("cp__button--active");
  return (
    <button
      type="button"
      className={classes.join(" ")}
      disabled={!availability.enabled}
      title={availability.enabled ? props.label : availability.reason}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.text ?? props.label}</span>
    </button>
  );
}

const STATUS_KEYS: Record<string, string> = {
  Running: "php.status.running",
  "Starting…": "php.status.starting",
  "Stopping…": "php.status.stopping",
  "Initializing…": "php.status.initializing",
  "Not installed": "runtimes.notInstalled",
  Error: "php.status.error",
  Stopped: "php.status.stopped",
};

/** A module's status word in the UI language (the service keeps the English value). */
function statusText(status: string): string {
  const key = STATUS_KEYS[status];
  return key === undefined ? status : t(key);
}

/** "PHP" and "MySQL" are names: never translated. */
function moduleName(name: string): string {
  return name;
}

/** XAMPP colors the module name by state: green running, yellow while busy, red error. */
function moduleTone(row: ModuleRow): string {
  if (["Starting…", "Stopping…", "Initializing…"].includes(row.status)) {
    return "cp__module cp__module--starting";
  }
  if (row.status === "Error") return "cp__module cp__module--error";
  return row.running ? "cp__module cp__module--running" : "cp__module";
}

function toggleText(label: "Start" | "Stop"): string {
  return label === "Start" ? t("php.start") : t("php.stop");
}

function ModuleTableRow({ row }: { row: ModuleRow }) {
  const panel = container.controlPanel;
  const filter = panel.getState().filter;
  return (
    <tr
      className={row.running ? "cp__row cp__row--running" : "cp__row"}
      aria-label={moduleName(row.name)}
    >
      <th scope="row" className={moduleTone(row)} title={statusText(row.status)}>
        {moduleName(row.name)}
        <span className="cp__sr-only"> — {statusText(row.status)}</span>
      </th>
      <td className="cp__pid">{row.pid ?? ""}</td>
      <td className="cp__port">{row.ports}</td>
      <td>
        <div className="cp__actions">
          <PanelButton
            label={`${toggleText(row.toggle.label)} ${moduleName(row.name)}`}
            text={toggleText(row.toggle.label)}
            availability={row.toggle.availability}
            onClick={() => {
              void panel.toggle(row.id);
            }}
          />
          <PanelButton
            label={row.id === "mysql" ? t("php.mysql.openAdmin") : `${t("php.admin")} ${moduleName(row.name)}`}
            text={t("php.admin")}
            availability={row.admin}
            onClick={() => {
              void panel.admin(row.id);
            }}
          />
          <PanelButton
            label={`${t("php.config")} ${moduleName(row.name)}`}
            text={t("php.config")}
            availability={row.config}
            onClick={() => {
              void panel.config(row.id);
            }}
          />
          <PanelButton
            label={`${t("php.logs")} ${moduleName(row.name)}`}
            text={t("php.logs")}
            active={filter === row.id}
            onClick={() => {
              panel.toggleFilter(row.id);
            }}
          />
        </div>
      </td>
    </tr>
  );
}

/** Under the table: what MySQL is made of and where it listens, or why it isn't running. */
function MySqlNote() {
  usePanel();
  const mysql = container.mySql;
  const error = mysql.error();
  if (error !== null) {
    return (
      <p className="cp__note cp__note--error" role="alert">
        {t("php.mysql.problem", { error })}
      </p>
    );
  }
  const details = mysql.details();
  if (details === "") return null;
  const status = mysql.getState().status;
  return (
    <p className="cp__note" title={t("php.mysql.detailsTitle")}>
      {t("php.mysql.details", { details })}
      {status?.state === "running" && status.autoLogin ? ` · ${t("php.mysql.credentials")}` : ""}
    </p>
  );
}

function LogView() {
  const panel = usePanel();
  const lines = panel.visibleLines();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);
  const filter = panel.getState().filter;
  return (
    <div className="cp__log" ref={ref} role="log" aria-label={t("php.log")} tabIndex={0}>
      {filter !== null ? (
        <div className="cp__log-filter">
          {t("php.showingOnly", { name: moduleName(MODULE_NAMES[filter]) })}{" "}
          <button
            type="button"
            className="cp__link"
            onClick={() => {
              panel.toggleFilter(filter);
            }}
          >
            {t("php.showAll")}
          </button>
        </div>
      ) : null}
      {lines.map((line) => (
        <div key={line.id} className="cp__log-line">
          <span className="cp__log-time">{line.time}</span>{" "}
          <span className="cp__log-tag">[{line.tag}]</span>{" "}
          <span className="cp__log-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function SideButtons() {
  const panel = usePanel();
  return (
    <nav className="cp__side" aria-label={t("php.controlPanel")}>
      <PanelButton
        label={t("php.config")}
        icon={<ConfigIcon />}
        className="cp__side-button"
        onClick={() => {
          panel.setPage("config");
        }}
      />
      <PanelButton
        label={t("php.netstat")}
        icon={<NetstatIcon />}
        className="cp__side-button"
        onClick={() => {
          panel.setPage("netstat");
        }}
      />
      <PanelButton
        label={t("php.shell")}
        icon={<ShellIcon />}
        className="cp__side-button"
        onClick={() => {
          void panel.openShell();
        }}
      />
      <PanelButton
        label={t("php.explorer")}
        icon={<ExplorerIcon />}
        className="cp__side-button"
        availability={panel.explorerState()}
        onClick={() => {
          void panel.openExplorer();
        }}
      />
      <PanelButton
        label={t("php.help")}
        icon={<HelpIcon />}
        className="cp__side-button"
        onClick={() => {
          panel.setPage("help");
        }}
      />
      <PanelButton
        label={t("php.quit")}
        icon={<QuitIcon />}
        className="cp__side-button"
        onClick={() => {
          void panel.quit();
        }}
      />
    </nav>
  );
}

/** XAMPP's layout: logo + title and the "Modules" box on the left, the side buttons on the right, the log below. */
function MainPage() {
  const panel = usePanel();
  return (
    <div className="cp__main">
      <div className="cp__top">
        <div className="cp__left">
          <header className="cp__header">
            <img className="cp__logo" src={appIcon} alt="" width={32} height={32} />
            <h1 className="cp__title">{t("php.title")}</h1>
          </header>
          <fieldset className="cp__modules">
            <legend>{t("php.modules")}</legend>
            <table className="cp__table">
              <thead>
                <tr>
                  <th>{t("php.col.module")}</th>
                  <th>{t("php.col.pids")}</th>
                  <th>{t("php.col.ports")}</th>
                  <th>{t("keys.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {panel.rows().map((row) => (
                  <ModuleTableRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
            <MySqlNote />
          </fieldset>
        </div>
        <SideButtons />
      </div>
      <LogView />
    </div>
  );
}

function SubPage(props: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const panel = container.controlPanel;
  return (
    <div className="cp__subpage">
      <header className="cp__subhead">
        <button
          type="button"
          className="cp__button"
          onClick={() => {
            panel.setPage("main");
          }}
        >
          {t("php.back")}
        </button>
        <div className="cp__titleblock">
          <h2>{props.title}</h2>
          {props.subtitle ? <p className="pcfg-subtitle">{props.subtitle}</p> : null}
        </div>
        {props.actions}
      </header>
      <div className="cp__subbody">{props.children}</div>
    </div>
  );
}

function NetstatPage() {
  const panel = usePanel();
  const { rows, loading, error, loadedAt } = panel.getState().netstat;
  const note = loading
    ? t("php.netstat.reading")
    : loadedAt
      ? t("php.netstat.asOf", { time: loadedAt })
      : t("php.netstat.note");
  return (
    <SubPage
      title={t("php.netstat")}
      actions={
        <PanelButton
          label={t("common.refresh")}
          availability={
            loading ? { enabled: false, reason: t("php.netstat.readingList") } : { enabled: true }
          }
          onClick={() => {
            void panel.refreshNetstat();
          }}
        />
      }
    >
      {error ? <div className="cp__error">{error}</div> : null}
      <p className="cp__hint">{note}</p>
      <table className="cp__table cp__table--net">
        <thead>
          <tr>
            <th>{t("php.col.port")}</th>
            <th>{t("php.col.address")}</th>
            <th>{t("php.col.pid")}</th>
            <th>{t("php.col.process")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const owner = panel.ownerOf(row.pid);
            return (
              <tr
                key={`${row.address}:${String(row.port)}:${String(row.pid)}`}
                className={owner ? "cp__row cp__row--running" : "cp__row"}
              >
                <td>{row.port}</td>
                <td>{row.address}</td>
                <td>{row.pid}</td>
                <td>{owner ? `${owner} (${row.process ?? "?"})` : (row.process ?? "")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SubPage>
  );
}

const HELP_KEYS = [
  "php.help.startStop",
  "php.help.mysql",
  "php.help.webRoot",
  "php.help.admin",
  "php.help.config",
  "php.help.logs",
  "php.help.netstat",
  "php.help.quit",
  "php.help.local",
];

function HelpPage() {
  return (
    <SubPage title={t("php.help")}>
      <ul className="cp__help">
        {HELP_KEYS.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </SubPage>
  );
}

/**
 * The PHP Server window, XAMPP-control-panel style: a module table, the side
 * buttons and a log. Installing versions, the web root and ports live
 * behind the Config button. UI only — `ControlPanelService` decides everything.
 */
export function ControlPanel() {
  const panel = usePanel();
  const page = panel.getState().page;
  if (page === "config") {
    return (
      <SubPage
        title={t("php.configuration")}
        subtitle={t("php.configurationSubtitle")}
        actions={<ConfigChips />}
      >
        <PhpServerView />
      </SubPage>
    );
  }
  if (page === "netstat") return <NetstatPage />;
  if (page === "help") return <HelpPage />;
  return <MainPage />;
}
