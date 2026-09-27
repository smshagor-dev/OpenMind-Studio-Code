import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import {
  parseWelcome,
  type ContainerEntry,
  type TreeNode,
} from "../services/extensionViewsService";
import type { ExtensionViewContribution } from "../services/extensionsIpc";
import "../styles/extensionViews.css";
import { ChevronIcon, CollapseAllIcon, RefreshIcon } from "./icons";
import { PaneSection } from "./PaneSection";
import { WebviewFrame } from "./WebviewPanels";

function useViews() {
  const views = container.extensions.views;
  useSyncExternalStore(
    (listener) => views.subscribe(listener),
    () => views.getVersion(),
  );
  return views;
}

/** A product icon (`ThemeIcon`) drawn as a small glyph; the common ones get their own shape. */
function ThemeGlyph({ name }: { name: string }) {
  const shape: Record<string, React.ReactNode> = {
    file: <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" />,
    folder: <path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13z" />,
    "circle-outline": <circle cx="8" cy="8" r="4.5" />,
    "circle-filled": <circle cx="8" cy="8" r="4.5" fill="currentColor" />,
    check: <path d="M3 8.5l3 3 7-7" />,
    pass: <path d="M3 8.5l3 3 7-7" />,
    error: <path d="M4 4l8 8M12 4l-8 8" />,
    warning: <path d="M8 2l6.5 12h-13zM8 6v4M8 12v.5" />,
    info: <path d="M8 7v5M8 4.5v.5" />,
  };
  return (
    <svg className="ext-tree__glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
        {shape[name] ?? <circle cx="8" cy="8" r="2" fill="currentColor" />}
      </g>
    </svg>
  );
}

function NodeIcon({ node, extensionId }: { node: TreeNode; extensionId: string }) {
  const views = useViews();
  if (node.icon?.file !== undefined) {
    const url = views.fileIcon(extensionId, node.icon.file);
    return url ? (
      <img className="ext-tree__icon" src={url} alt="" draggable={false} />
    ) : (
      <span className="ext-tree__icon" />
    );
  }
  if (node.icon?.theme !== undefined) return <ThemeGlyph name={node.icon.theme} />;
  return null;
}

function TreeRows(props: {
  viewId: string;
  nodes: TreeNode[];
  depth: number;
  extensionId: string;
}) {
  const views = useViews();
  const state = views.view(props.viewId);
  return (
    <>
      {props.nodes.map((node) => {
        const expanded = views.isExpanded(props.viewId, node);
        const children = state.children[node.handle];
        return (
          <li key={node.handle} role="none">
            <div
              className="ext-tree__row"
              role="treeitem"
              aria-level={props.depth + 1}
              aria-expanded={node.collapsible === 0 ? undefined : expanded}
              tabIndex={0}
              title={node.tooltip ?? node.label}
              style={{ paddingLeft: 8 + props.depth * 8 }}
              onClick={() => void views.click(props.viewId, node)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void views.click(props.viewId, node);
                if (event.key === "ArrowRight" && node.collapsible !== 0 && !expanded) {
                  void views.toggle(props.viewId, node);
                }
                if (event.key === "ArrowLeft" && expanded) void views.toggle(props.viewId, node);
              }}
            >
              <span
                className="ext-tree__twistie"
                onClick={(event) => {
                  event.stopPropagation();
                  void views.toggle(props.viewId, node);
                }}
              >
                {node.collapsible === 0 ? null : <ChevronIcon expanded={expanded} />}
              </span>
              <NodeIcon node={node} extensionId={props.extensionId} />
              <span className="ext-tree__label">{node.label}</span>
              {node.description ? (
                <span className="ext-tree__description">{node.description}</span>
              ) : null}
            </div>
            {expanded && children && children.length > 0 ? (
              <ul role="group" className="ext-tree__group">
                <TreeRows
                  viewId={props.viewId}
                  nodes={children}
                  depth={props.depth + 1}
                  extensionId={props.extensionId}
                />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

function Welcome({ text }: { text: string }) {
  const views = useViews();
  return (
    <div className="ext-view-welcome">
      {parseWelcome(text).map((line, index) =>
        line.kind === "button" ? (
          <button
            key={index}
            type="button"
            className="ext-view-welcome__button"
            onClick={() => {
              views.runCommand(line.command);
            }}
          >
            {line.label}
          </button>
        ) : (
          <p key={index}>
            {line.parts.map((part, i) =>
              "text" in part ? (
                <span key={i}>{part.text}</span>
              ) : part.target.startsWith("command:") ? (
                <button
                  key={i}
                  type="button"
                  className="ext-link"
                  onClick={() => {
                    views.runCommand(part.target.slice("command:".length).split("?")[0] ?? "");
                  }}
                >
                  {part.link}
                </button>
              ) : /^https?:\/\//.test(part.target) ? (
                <button
                  key={i}
                  type="button"
                  className="ext-link"
                  onClick={() => void container.ipc.openExternalUrl(part.target)}
                >
                  {part.link}
                </button>
              ) : (
                <span key={i}>{part.link}</span>
              ),
            )}
          </p>
        ),
      )}
    </div>
  );
}

/**
 * A webview view: the extension's page in the same sandboxed frame as a webview panel (no same-origin, scripts only
 * when asked for, CSP first, no remote content). The extension hears when it becomes visible or hidden.
 */
function WebviewViewBody({ entry, view }: { entry: ContainerEntry; view: ExtensionViewContribution }) {
  const { webviews } = container.extensions;
  const state = useSyncExternalStore(
    (listener) => webviews.subscribe(listener),
    () => webviews.getState(),
  );
  const page = state.panels.find((panel) => panel.placement === "view" && panel.view === view.id);
  const pageId = page?.id ?? null;
  useEffect(() => {
    if (pageId === null) return undefined;
    webviews.setViewVisible(pageId, true);
    return () => {
      webviews.setViewVisible(pageId, false);
    };
  }, [pageId, webviews]);
  if (!page) {
    return (
      <p className="ext-view-note">
        {state.providers.includes(view.id)
          ? "Loading…"
          : `${entry.extensionName} hasn't registered a provider for this view.`}
      </p>
    );
  }
  return (
    <div className="ext-webview-view">
      {page.blocked.length > 0 ? (
        <p className="ext-view-note" role="status">
          Some content was blocked (remote content and files outside the view's resource roots are never loaded).
        </p>
      ) : null}
      <WebviewFrame panel={page} visible focusSeq={0} />
    </div>
  );
}

function ViewBody({ entry, view }: { entry: ContainerEntry; view: ExtensionViewContribution }) {
  const views = useViews();
  const state = views.view(view.id);
  const welcome = views.welcomeFor(view);
  if (view.kind === "webview") {
    return state.error !== null ? (
      <p className="ext-view-note ext-view-note--error">{state.error}</p>
    ) : (
      <WebviewViewBody entry={entry} view={view} />
    );
  }
  if (state.error !== null)
    return <p className="ext-view-note ext-view-note--error">{state.error}</p>;
  if (!state.registered) {
    return welcome ? (
      <Welcome text={welcome} />
    ) : (
      <p className="ext-view-note">
        {`${entry.extensionName} hasn't registered a data provider for this view.`}
      </p>
    );
  }
  if (state.roots === null) return <p className="ext-view-note">Loading…</p>;
  return (
    <>
      {state.message ? <p className="ext-view-note">{state.message}</p> : null}
      {state.roots.length === 0 ? (
        welcome ? (
          <Welcome text={welcome} />
        ) : null
      ) : (
        <ul className="ext-tree" role="tree" aria-label={view.name}>
          <TreeRows
            viewId={view.id}
            nodes={state.roots}
            depth={0}
            extensionId={entry.extensionId}
          />
        </ul>
      )}
    </>
  );
}

function ViewSection({
  entry,
  view,
  only,
}: {
  entry: ContainerEntry;
  view: ExtensionViewContribution;
  only: boolean;
}) {
  const views = useViews();
  const [expanded, setExpanded] = useState(true);
  const state = views.view(view.id);
  const title = state.description ? `${view.name} — ${state.description}` : view.name;
  return (
    <PaneSection
      title={title}
      expanded={expanded}
      grow={only || view.kind === "tree"}
      onToggle={() => {
        setExpanded(!expanded);
      }}
      actions={
        view.kind === "tree" && state.registered
          ? [
              { label: "Refresh", icon: <RefreshIcon />, onRun: () => void views.refresh(view.id) },
              {
                label: "Collapse All",
                icon: <CollapseAllIcon />,
                onRun: () => {
                  views.collapseAll(view.id);
                },
              },
            ]
          : []
      }
    >
      <ViewBody entry={entry} view={view} />
    </PaneSection>
  );
}

/** An extension's activity bar container in the side bar: one section per contributed view. */
export function ExtensionContainerView({ viewKey }: { viewKey: string }) {
  const views = useViews();
  const entry = views.find(viewKey);
  useEffect(() => {
    void views.show(viewKey);
    return () => {
      views.hide(viewKey);
    };
  }, [views, viewKey]);
  if (!entry) return null;
  if (entry.container.views.length === 0) {
    return <p className="ext-view-note">{`${entry.extensionName} contributes no views here.`}</p>;
  }
  // Why the extension can't run (no Node.js allowed yet...): said here, not only in a passing toast.
  const failure = views.failureOf(viewKey);
  const problem =
    container.extensions.service.runtimeProblem() ??
    (failure === null ? null : `${entry.extensionName} couldn't start: ${failure}`);
  return (
    <div className="ext-container-view">
      {problem !== null ? (
        <div className="ext-view-problem" role="alert">
          <p>{problem}</p>
          <button
            type="button"
            className="ext-view-welcome__button"
            onClick={() => void container.layout.showView("extensions")}
          >
            Show in Extensions
          </button>
        </div>
      ) : null}
      {entry.container.views.map((view) => (
        <ViewSection
          key={view.id}
          entry={entry}
          view={view}
          only={entry.container.views.length === 1}
        />
      ))}
    </div>
  );
}
