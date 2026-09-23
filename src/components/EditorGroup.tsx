import type { Recents } from "../appHooks";
import { MonacoHost } from "../editor/MonacoHost";
import { container } from "../services/container";
import type { DocumentSnapshot } from "../services/documentService";
import { Breadcrumbs } from "./Breadcrumbs";
import { StartPage } from "./StartPage";
import { TabBar } from "./TabBar";

const MONACO_THEME_MAP: Record<string, string> = {
  dark: "vs-dark",
  light: "vs",
};

interface EditorGroupProps {
  ready: boolean;
  tabs: DocumentSnapshot[];
  activeTab: DocumentSnapshot | null;
  rootPath: string | null;
  breadcrumbsVisible: boolean;
  themeKind: string;
  recents: Recents;
}

/** The editor area: tabs, breadcrumbs, then the active editor (or the Welcome page with no editors open). */
export function EditorGroup(props: EditorGroupProps) {
  const { tabs, activeTab } = props;
  return (
    <main className="editor-group" aria-label="editor area">
      <TabBar
        tabs={tabs}
        activeId={activeTab?.id ?? null}
        onSelect={(id) => {
          container.workspace.setActive(id);
        }}
        onClose={(id) => void container.workspace.close(id)}
      />
      {activeTab && props.breadcrumbsVisible ? (
        <Breadcrumbs path={activeTab.path} title={activeTab.title} rootPath={props.rootPath} />
      ) : null}
      <EditorContent
        ready={props.ready}
        activeId={activeTab?.id ?? null}
        themeKind={props.themeKind}
        recents={props.recents}
      />
    </main>
  );
}

interface EditorContentProps {
  ready: boolean;
  activeId: string | null;
  themeKind: string;
  recents: Recents;
}

function EditorContent({ ready, activeId, themeKind, recents }: EditorContentProps) {
  if (!ready) {
    return <div className="editor-group__content" />;
  }
  if (activeId === null) {
    return (
      <div className="editor-group__content">
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
      </div>
    );
  }
  return (
    <div className="editor-group__content">
      <MonacoHost
        model={container.buffers.get(activeId) ?? null}
        theme={MONACO_THEME_MAP[themeKind] ?? "vs-dark"}
        onEditorMounted={(editor) => container.editor.attach(editor)}
      />
    </div>
  );
}
