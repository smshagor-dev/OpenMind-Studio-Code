import type { Recents } from "../appHooks";
import { MonacoHost } from "../editor/MonacoHost";
import { container } from "../services/container";
import type { EditorGroupView as GroupView } from "../services/workspaceService";
import { Breadcrumbs } from "./Breadcrumbs";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { EditorHeaderActions } from "./EditorHeaderActions";
import { MarkdownPreview } from "./MarkdownPreview";
import { StartPage } from "./StartPage";
import { TabBar } from "./TabBar";

const MONACO_THEME_MAP: Record<string, string> = {
  dark: "vs-dark",
  light: "vs",
};

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
          tabs={group.tabs}
          activeId={group.activeTabId}
          onSelect={(id) => {
            container.workspace.activateTab(group.id, id);
          }}
          onClose={(id) => void container.workspace.closeTab(group.id, id)}
          onKeepOpen={(id) => {
            container.workspace.pinTab(group.id, id);
          }}
        />
        <EditorHeaderActions
          groupId={group.id}
          locked={group.locked}
          hasTabs={group.tabs.length > 0}
          active={active}
        />
      </div>
      {activeTab && props.breadcrumbsVisible ? (
        <Breadcrumbs path={activeTab.path} title={activeTab.title} rootPath={props.rootPath} />
      ) : null}
      {activeTab && activeTab.kind === "text" ? <ExternalChangeBanner tab={activeTab} /> : null}
      <GroupContent {...props} docId={activeTab?.docId ?? null} kind={activeTab?.kind ?? null} />
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
}: EditorGroupViewProps & { docId: string | null; kind: "text" | "markdownPreview" | null }) {
  if (!ready) {
    return <div className="editor-group__content" />;
  }
  if (docId === null || kind === null) {
    return (
      <div className="editor-group__content">
        {showWelcome ? (
          <StartPage
            recentFiles={recents.files}
            recentFolders={recents.folders}
            pinnedFolders={recents.pinnedFolders}
            onNewFile={() => {
              container.run("file.new");
            }}
            onOpenFile={() => {
              container.run("file.open");
            }}
            onOpenFolder={() => {
              container.run("file.openFolder");
            }}
            onOpenRecentFile={(path) => void container.workspace.openPath(path)}
            onOpenRecentFolder={(path) => void container.workspace.openFolder(path)}
            onUnpinFolder={(path) => void container.workspace.unpinFolder(path)}
          />
        ) : (
          <p className="editor-group__empty">Open a file to show it in this group.</p>
        )}
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
        theme={MONACO_THEME_MAP[themeKind] ?? "vs-dark"}
        onEditorMounted={(editor) => {
          const detach = container.editor.attach(editor);
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
