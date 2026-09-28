import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import { NetworkStatusButton } from "./network/NetworkDialog";
import { container } from "../services/container";
import { PANEL_TABS, PANEL_TAB_LABELS, type PanelTab } from "../services/panelService";
import { CloseIcon } from "./icons";
import { MenuPopup } from "./MenuPopup";
import {
  DebugConsolePanel,
  OutputActions,
  OutputPanel,
  PortsPanel,
  ProblemsPanel,
} from "./PanelViews";
import { TerminalView } from "./TerminalView";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { t } from "../i18n";

interface BottomPanelProps {
  themeKind: string;
}

/**
 * VS Code's bottom panel: Problems, Output, Debug Console, Terminal and Ports
 * tabs, the actions of whichever is showing, and a resize handle. The terminal
 * sessions stay mounted while another tab (or the whole panel) is hidden so
 * their scrollback survives.
 */
export function BottomPanel({ themeKind }: BottomPanelProps) {
  const panel = useSyncExternalStore(
    (listener) => container.panel.subscribe(listener),
    () => container.panel.getState(),
  );
  const sessionCount = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState().sessions.length,
  );
  const drag = useRef<{ y: number; height: number } | null>(null);

  if (!panel.visible && sessionCount === 0) {
    return null;
  }

  return (
    <section
      className={panel.visible ? "terminal-panel" : "terminal-panel terminal-panel--hidden"}
      style={{ height: panel.height }}
      aria-label={t("panel.panel")}
    >
      <div
        className="terminal-panel__sash"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("panel.resize")}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, height: panel.height };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            container.panel.previewHeight(drag.current.height + (drag.current.y - event.clientY));
          }
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          void container.panel.commitHeight();
        }}
      />
      <div className="terminal-panel__header">
        <div className="panel-tabs" role="tablist" aria-label={t("panel.tabs")}>
          {PANEL_TABS.map((tab) => (
            <PanelTabButton key={tab} tab={tab} active={tab === panel.activeTab} />
          ))}
        </div>
        <div className="terminal-panel__actions">
          <PanelActions tab={panel.activeTab} />
          <button
            type="button"
            className="terminal-panel__action"
            title={t("panel.close")}
            aria-label={t("panel.hide")}
            onClick={() => {
              void container.panel.hide();
            }}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="terminal-panel__body">
        {panel.activeTab === "problems" ? <ProblemsPanel /> : null}
        {panel.activeTab === "output" ? <OutputPanel /> : null}
        {panel.activeTab === "debugConsole" ? <DebugConsolePanel /> : null}
        {panel.activeTab === "ports" ? <PortsPanel /> : null}
        <TerminalView themeKind={themeKind} visible={panel.activeTab === "terminal"} />
      </div>
    </section>
  );
}

function PanelTabButton({ tab, active }: { tab: PanelTab; active: boolean }) {
  const problemCount = useSyncExternalStore(
    (listener) => container.markers.subscribe(listener),
    () => {
      const counts = container.markers.getCounts();
      return counts.errors + counts.warnings;
    },
  );
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "panel-tab panel-tab--active" : "panel-tab"}
      onClick={() => {
        void container.panel.setActiveTab(tab);
      }}
    >
      {t(PANEL_TAB_LABELS[tab])}
      {tab === "problems" && problemCount > 0 ? (
        <span className="panel-tab__badge">{problemCount}</span>
      ) : null}
    </button>
  );
}

/** The header actions for the tab that is showing. */
function PanelActions({ tab }: { tab: PanelTab }) {
  if (tab === "terminal") return <TerminalActions />;
  if (tab === "output") return <OutputActions />;
  return null;
}

function TerminalActions() {
  const state = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState(),
  );
  const [shellMenu, setShellMenu] = useState<DOMRect | null>(null);
  const closeShellMenu = useCallback(() => {
    setShellMenu(null);
  }, []);
  useDismissOnOutside(shellMenu !== null, closeShellMenu);

  return (
    <>
      <NetworkStatusButton />
      <button
        type="button"
        className="terminal-panel__action"
        title={t("terminal.new")}
        aria-label={t("terminal.new")}
        onClick={() => {
          container.run("terminal.new");
        }}
      >
        +
      </button>
      {state.shells.length > 1 ? (
        <button
          type="button"
          className="terminal-panel__action"
          title={t("terminal.launchProfile")}
          aria-label={t("terminal.selectShell")}
          onMouseDown={(event) => {
            event.stopPropagation();
            setShellMenu(shellMenu ? null : event.currentTarget.getBoundingClientRect());
          }}
        >
          ▾
        </button>
      ) : null}
      <button
        type="button"
        className="terminal-panel__action"
        title={t("terminal.clear")}
        aria-label={t("terminal.clear")}
        disabled={state.activeId === null}
        onClick={() => {
          container.run("terminal.clear");
        }}
      >
        ⌫
      </button>
      {shellMenu ? (
        <MenuPopup
          items={state.shells.map((shell) => ({
            kind: "item" as const,
            label: shell.label,
            enabled: true,
            onSelect: () => {
              container.run("terminal.new", shell.kind);
            },
          }))}
          x={shellMenu.left}
          y={shellMenu.bottom + 2}
          ariaLabel={t("terminal.shells")}
          onClose={closeShellMenu}
          autoFocus
        />
      ) : null}
    </>
  );
}
