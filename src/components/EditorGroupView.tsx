import { useEffect, useRef } from "react";
import type { Recents } from "../appHooks";
import { MonacoHost } from "../editor/MonacoHost";
import { container } from "../services/container";
import { openTabMenu } from "../services/editorMenu";
import type { EditorKind } from "../services/editorGroupService";
import type { EditorGroupView as GroupView } from "../services/workspaceService";
import { Breadcrumbs } from "./Breadcrumbs";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { EditorHeaderActions } from "./EditorHeaderActions";
import { FilePreviewView } from "./FilePreviewView";
import { MarkdownPreview } from "./MarkdownPreview";
import { TabBar } from "./TabBar";
import { useWelcome } from "./useWelcome";
import { EditorWatermark, WelcomeContent, WelcomeTab } from "./WelcomeEditor";
import { MONACO_THEME_MAP } from "../editor/monacoThemes";

interface EditorGroupViewProps {
  group: GroupView;
  active: boolean;
  /** Only the first, only group shows the Welcome page when nothing is open. */
  showWelcome: boolean;
  ready: boolean;
  rootPath: string | null;
  breadcrumbsVisible: boolean;
  themeKind: string;
  recents: Recents;
}

/**
 * One editor group: its tabs and header actions, breadcrumbs, then the active
 * editor — Monaco for a text tab, the rendered preview for a Markdown preview
 * tab — or the Welcome page when the only group has nothing open. Focusing
 * anything in the group makes it the active group.
 */
export function EditorGroupView(props: EditorGroupViewProps) {
  const { group, active } = props;
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
  const welcome = useWelcome();
  const welcomeTab = props.showWelcome && welcome.open && (group.tabs.length === 0 || welcome.foreground);
  const previous = useRef({ ready: props.ready, activeId: group.activeTabId });
  useEffect(() => {
    if (previous.current.ready && props.ready && previous.current.activeId !== group.activeTabId) container.welcome.close();
    previous.current = { ready: props.ready, activeId: group.activeTabId };
  }, [props.ready, group.activeTabId]);
  return (
    <main
      className={active ? "editor-group editor-group--active" : "editor-group"}
      aria-label={active ? "editor area" : "editor group"}
      data-group-id={group.id}
      onMouseDownCapture={() => {
        container.workspace.setActiveGroup(group.id);
      }}
    >
      <div className="editor-group__header">
        <TabBar
          leading={welcomeTab ? <WelcomeTab active /> : null}
          tabs={group.tabs}
          activeId={welcomeTab ? null : group.activeTabId}
          onSelect={(id) => {
            container.welcome.close();
            container.workspace.activateTab(group.id, id);
          }}
          onClose={(id) => void container.workspace.closeTab(group.id, id)}
          onKeepOpen={(id) => {
            container.workspace.pinTab(group.id, id);
          }}
          onDetach={(id, at) => void container.editorWindows.moveToNewWindow(group.id, id, at)}
          onTabContextMenu={(id, x, y) => {
            openTabMenu(group.id, id, x, y);
          }}
        />
        <EditorHeaderActions
          groupId={group.id}
          locked={group.locked}
          hasTabs={group.tabs.length > 0}
          active={active}
        />
      </div>
      {!welcomeTab && activeTab && props.breadcrumbsVisible ? (
        <Breadcrumbs
          path={activeTab.path}
          title={activeTab.title}
          rootPath={props.rootPath}
          docId={activeTab.docId}
        />
      ) : null}
      {!welcomeTab && activeTab && activeTab.kind === "text" ? <ExternalChangeBanner tab={activeTab} /> : null}
      {welcomeTab && props.ready ? <div className="editor-group__content"><WelcomeContent recents={props.recents} /></div> : <GroupContent {...props} docId={activeTab?.docId ?? null} kind={activeTab?.kind ?? null} />}
    </main>
  );
}

function GroupContent({
  group,
  ready,
  showWelcome,
  themeKind,
  recents,
  docId,
  kind,
}: EditorGroupViewProps & { docId: string | null; kind: EditorKind | null }) {
  if (!ready) {
    return <div className="editor-group__content" />;
  }
  if (docId === null || kind === null) {
    return (
      <div className="editor-group__content">
        {showWelcome ? (
          <EmptyFirstGroup recents={recents} />
        ) : (
          <p className="editor-group__empty">Open a file to show it in this group.</p>
        )}
      </div>
    );
  }
  if (kind === "filePreview") {
    return (
      <div className="editor-group__content">
        <FilePreviewView key={`${group.id}:${docId}`} docId={docId} />
      </div>
    );
  }
  if (kind === "markdownPreview") {
    return (
      <div className="editor-group__content">
        <MarkdownPreview key={`${group.id}:${docId}`} docId={docId} />
      </div>
    );
  }
  return (
    <div className="editor-group__content">
      <MonacoHost
        model={container.buffers.get(docId) ?? null}
        theme={MONACO_THEME_MAP[themeKind] ?? "openmind-dark"}
        onEditorMounted={(editor) => {
          const detach = container.editor.attach(editor, {
            groupId: group.id,
            active: () => container.workspace.getState().activeGroupId === group.id,
            viewColumn: () => container.editorGroups.getState().groups.findIndex(value => value.id === group.id) + 1,
          });
          const focus = editor.onDidFocusEditorWidget(() => {
            container.workspace.setActiveGroup(group.id);
          });
          return () => {
            focus.dispose();
            detach();
          };
        }}
      />
    </div>
  );
}

/** The only group with nothing open: the Welcome tab's page, or the watermark once it is closed. */
function EmptyFirstGroup({ recents }: { recents: Recents }) {
  const welcome = useWelcome();
  return welcome.open ? <WelcomeContent recents={recents} /> : <EditorWatermark />;
}


