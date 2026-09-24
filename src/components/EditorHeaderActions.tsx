import { useCallback, useState } from "react";

import { container } from "../services/container";
import { buildEditorActionsMenu } from "../services/editorHeaderMenu";
import { EllipsisIcon, LockIcon, SplitEditorIcon } from "./icons";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";

interface EditorHeaderActionsProps {
  groupId: string;
  locked: boolean;
  hasTabs: boolean;
}

/**
 * The top-right actions of an editor group: split, and the ⋯ menu. Anything
 * that can't work for this group's editor is disabled with its reason in the
 * ⋯ menu; the buttons themselves only appear once the group has an editor.
 */
export function EditorHeaderActions({ groupId, locked, hasTabs }: EditorHeaderActionsProps) {
  const [moreAnchor, setMoreAnchor] = useState<DOMRect | null>(null);
  const closeMore = useCallback(() => {
    setMoreAnchor(null);
  }, []);
  useDismissOnOutside(moreAnchor !== null, closeMore);

  if (!hasTabs && !locked) {
    return null;
  }

  return (
    <div className="editor-header-actions" role="toolbar" aria-label="Editor actions">
      {locked ? (
        <span className="editor-header-actions__lock" title="This group is locked">
          <LockIcon />
        </span>
      ) : null}
      <button
        type="button"
        className="editor-header-actions__button"
        title="Split Editor Right (Ctrl+\)"
        aria-label="Split Editor Right"
        disabled={!hasTabs}
        onClick={() => {
          container.run("editor.splitRight");
        }}
      >
        <SplitEditorIcon />
      </button>
      <button
        type="button"
        className="editor-header-actions__button"
        title="More Actions..."
        aria-label="More Actions"
        aria-haspopup="menu"
        onMouseDown={(event) => {
          event.stopPropagation();
          setMoreAnchor(moreAnchor ? null : event.currentTarget.getBoundingClientRect());
        }}
      >
        <EllipsisIcon />
      </button>
      {moreAnchor ? (
        <MenuPopup
          items={buildEditorActionsMenu(
            {
              workspace: container.workspace,
              groups: container.editorGroups,
              openEditors: container.openEditors,
              previews: container.previews,
              associations: container.associations,
              markdown: container.markdown,
              editor: container.editor,
              layout: container.layout,
              run: container.run,
            },
            groupId,
          )}
          x={Math.max(0, moreAnchor.right - 240)}
          y={moreAnchor.bottom + 2}
          ariaLabel="Editor actions"
          onClose={closeMore}
        />
      ) : null}
    </div>
  );
}
