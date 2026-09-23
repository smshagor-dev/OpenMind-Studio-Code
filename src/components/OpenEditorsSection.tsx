import { container } from "../services/container";
import type { DocumentSnapshot } from "../services/documentService";
import { FileTypeIcon } from "./fileIcons";
import { CloseAllIcon, CloseIcon, NewFileIcon, SaveAllIcon } from "./icons";
import { PaneSection } from "./PaneSection";

interface OpenEditorsSectionProps {
  tabs: DocumentSnapshot[];
  activeId: string | null;
  rootPath: string | null;
  expanded: boolean;
  onToggle: () => void;
}

/** The directory shown dimmed after the file name — relative to the workspace when inside it. */
function describeLocation(path: string | null, rootPath: string | null): string {
  if (!path) return "";
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = separator > 0 ? path.slice(0, separator) : "";
  if (rootPath && dir.toLowerCase().startsWith(rootPath.toLowerCase())) {
    return dir.slice(rootPath.length).replace(/^[\\/]/, "");
  }
  return dir;
}

/** VS Code's "OPEN EDITORS" explorer section: every open tab, with close / dirty indicator. */
export function OpenEditorsSection({
  tabs,
  activeId,
  rootPath,
  expanded,
  onToggle,
}: OpenEditorsSectionProps) {
  const anyDirty = tabs.some((tab) => tab.dirty);
  return (
    <PaneSection
      title="Open Editors"
      expanded={expanded}
      onToggle={onToggle}
      actions={[
        {
          label: "New Untitled Text File",
          icon: <NewFileIcon />,
          onRun: () => {
            container.run("file.new");
          },
        },
        {
          label: "Save All",
          icon: <SaveAllIcon />,
          disabled: !anyDirty,
          onRun: () => {
            container.run("file.saveAll");
          },
        },
        {
          label: "Close All Editors",
          icon: <CloseAllIcon />,
          disabled: tabs.length === 0,
          onRun: () => {
            container.run("workbench.closeAllEditors");
          },
        },
      ]}
    >
      <div className="open-editors" role="listbox" aria-label="Open Editors">
        {tabs.map((tab) => (
          <OpenEditorRow
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            location={describeLocation(tab.path, rootPath)}
          />
        ))}
      </div>
    </PaneSection>
  );
}

function OpenEditorRow({
  tab,
  active,
  location,
}: {
  tab: DocumentSnapshot;
  active: boolean;
  location: string;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      className={active ? "open-editors__row open-editors__row--active" : "open-editors__row"}
      title={tab.path ?? tab.title}
      onClick={() => {
        container.workspace.setActive(tab.id);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) void container.workspace.close(tab.id);
      }}
    >
      <button
        type="button"
        className={
          tab.dirty ? "open-editors__close open-editors__close--dirty" : "open-editors__close"
        }
        aria-label={`Close ${tab.title}`}
        onClick={(event) => {
          event.stopPropagation();
          void container.workspace.close(tab.id);
        }}
      >
        <CloseIcon />
      </button>
      <FileTypeIcon name={tab.title} />
      <span className="open-editors__name">{tab.title}</span>
      <span className="open-editors__description">{location}</span>
    </div>
  );
}
