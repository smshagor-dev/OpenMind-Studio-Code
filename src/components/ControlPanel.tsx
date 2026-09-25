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
import { PhpServerView } from "./PhpServerView";

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

/** XAMPP colors the module name by state: green running, yellow starting, red error. */
function moduleTone(row: ModuleRow): string {
  if (row.status === "Starting…") return "cp__module cp__module--starting";
  if (row.status === "Error") return "cp__module cp__module--error";
  return row.running ? "cp__module cp__module--running" : "cp__module";
}

function ModuleTableRow({ row }: { row: ModuleRow }) {
  const panel = container.controlPanel;
  const filter = panel.getState().filter;
  return (
    <tr className={row.running ? "cp__row cp__row--running" : "cp__row"} aria-label={row.name}>
      <th scope="row" className={moduleTone(row)} title={row.status}>
        {row.name}
        <span className="cp__sr-only"> — {row.status}</span>
      </th>
      <td className="cp__pid">{row.pid ?? ""}</td>
      <td className="cp__port">{row.ports}</td>
      <td>
        <div className="cp__actions">
          <PanelButton
            label={`${row.toggle.label} ${row.name}`}
            text={row.toggle.label}
            availability={row.toggle.availability}
            onClick={() => {
              void panel.toggle(row.id);
            }}
          />
          <PanelButton
            label={`Admin ${row.name}`}
            text="Admin"
            availability={row.admin}
            onClick={() => {
              void panel.admin(row.id);
            }}
          />
          <PanelButton
            label={`Config ${row.name}`}
            text="Config"
            availability={row.config}
            onClick={() => {
              void panel.config(row.id);
            }}
          />
          <PanelButton
            label={`Logs ${row.name}`}
            text="Logs"
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
    <div className="cp__log" ref={ref} role="log" aria-label="Log" tabIndex={0}>
      {filter !== null ? (
        <div className="cp__log-filter">
          Showing only {MODULE_NAMES[filter]} —{" "}
          <button
            type="button"
            className="cp__link"
            onClick={() => {
              panel.toggleFilter(filter);
            }}
          >
            show all
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
    <nav className="cp__side" aria-label="Control panel">
      <PanelButton
        label="Config"
        icon={<ConfigIcon />}
        className="cp__side-button"
        onClick={() => {
          panel.setPage("config");
        }}
      />
      <PanelButton
        label="Netstat"
        icon={<NetstatIcon />}
        className="cp__side-button"
        onClick={() => {
          panel.setPage("netstat");
        }}
      />
      <PanelButton
        label="Shell"
        icon={<ShellIcon />}
        className="cp__side-button"
        onClick={() => {
          void panel.openShell();
        }}
      />
      <PanelButton
        label="Explorer"
        icon={<ExplorerIcon />}
        className="cp__side-button"
        availability={panel.explorerState()}
        onClick={() => {
          void panel.openExplorer();
        }}
      />
      <PanelButton
        label="Help"
        icon={<HelpIcon />}
        className="cp__side-button"
        onClick={() => {
          panel.setPage("help");
        }}
      />
      <PanelButton
        label="Quit"
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
            <h1 className="cp__title">OpenMind PHP Control Panel</h1>
          </header>
          <fieldset className="cp__modules">
            <legend>Modules</legend>
            <table className="cp__table">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>PID(s)</th>
                  <th>Port(s)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {panel.rows().map((row) => (
                  <ModuleTableRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </fieldset>
        </div>
        <SideButtons />
      </div>
      <LogView />
    </div>
  );
}

function SubPage(props: { title: string; children: ReactNode; actions?: ReactNode }) {
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
          Back
        </button>
        <h2>{props.title}</h2>
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
    ? "Reading listening ports…"
    : `Listening TCP ports${loadedAt ? ` as of ${loadedAt}` : ""}. Rows from OpenMind's own servers are marked.`;
  return (
    <SubPage
      title="Netstat"
      actions={
        <PanelButton
          label="Refresh"
          availability={
            loading ? { enabled: false, reason: "Reading the port list…" } : { enabled: true }
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
            <th>Port</th>
            <th>Address</th>
            <th>PID</th>
            <th>Process</th>
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

function HelpPage() {
  return (
    <SubPage title="Help">
      <ul className="cp__help">
        <li>
          <b>Start / Stop</b> starts or stops that module. Nothing starts by itself.
        </li>
        <li>
          The PHP server is not tied to one project: it serves the <b>web root</b> (the app&apos;s{" "}
          <code>htdocs</code> folder unless you choose another), and every folder inside it is its
          own site at <code>http://127.0.0.1:8000/&lt;folder&gt;/</code>. The root page lists them.
        </li>
        <li>
          <b>Admin</b> opens the module in your browser (MariaDB is managed through phpMyAdmin).
        </li>
        <li>
          <b>Config</b> in a row opens that module&apos;s config file in Notepad. The <b>Config</b>{" "}
          button on the right opens the web root, ports, PHP versions, Composer (with its own
          project folder) and the MariaDB password.
        </li>
        <li>
          <b>Logs</b> shows only that module&apos;s lines in the log below; click again for all.
        </li>
        <li>
          <b>Netstat</b> lists the TCP ports that are listening on this computer, with their
          process. <b>Shell</b> opens a console with the portable PHP, Composer, Python, Node and
          Git first on PATH, in the web root. <b>Explorer</b> opens the web root.
        </li>
        <li>
          <b>Quit</b> closes this window; the servers keep running. Closing the main OpenMind Studio
          window while a server runs hides the app in the system tray (servers keep running). The
          tray icon brings it back, has <b>Stop All Servers</b>, and <b>Quit OpenMind Studio</b>{" "}
          stops everything.
        </li>
        <li>
          Everything listens on 127.0.0.1 only. No Windows service, admin rights or PATH change.
        </li>
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
      <SubPage title="Configuration">
        <PhpServerView />
      </SubPage>
    );
  }
  if (page === "netstat") return <NetstatPage />;
  if (page === "help") return <HelpPage />;
  return <MainPage />;
}
