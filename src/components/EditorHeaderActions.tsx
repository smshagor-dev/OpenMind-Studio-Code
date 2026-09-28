import { useCallback, useState } from "react";

import { container } from "../services/container";
import { buildEditorActionsMenu } from "../services/editorHeaderMenu";
import { EllipsisIcon, LockIcon, SplitEditorIcon } from "./icons";
import { RunCodeButton, RunCodeDropdown, RunStatusIndicator } from "./RunCodeControls";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { t } from "../i18n";

interface EditorHeaderActionsProps {
  groupId: string;
  locked: boolean;
  hasTabs: boolean;
  /** Run Code acts on the active group's editor, so only that group shows its controls. */
  active: boolean;
}

/**
 * The top-right actions of an editor group: split, and the ⋯ menu. Anything
 * that can't work for this group's editor is disabled with its reason in the
 * ⋯ menu; the buttons themselves only appear once the group has an editor.
 */
export function EditorHeaderActions({
  groupId,
  locked,
  hasTabs,
  active,
}: EditorHeaderActionsProps) {
  const [moreAnchor, setMoreAnchor] = useState<DOMRect | null>(null);
  const closeMore = useCallback(() => {
    setMoreAnchor(null);
  }, []);
  useDismissOnOutside(moreAnchor !== null, closeMore);

  if (!hasTabs && !locked) {
    return null;
  }

  return (
    <div className="editor-header-actions" role="toolbar" aria-label={t("editor.actions")}>
      {active && hasTabs ? (
        <>
          <RunStatusIndicator />
          <RunCodeButton />
          <RunCodeDropdown />
          <span className="editor-header-actions__divider" aria-hidden="true" />
        </>
      ) : null}
      {locked ? (
        <span className="editor-header-actions__lock" title={t("editor.groupLocked")}>
          <LockIcon />
        </span>
      ) : null}
      <button
        type="button"
        className="editor-header-actions__button"
        title={t("editor.splitRightTitle")}
        aria-label={t("editor.splitRight")}
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
        title={t("common.moreActionsTitle")}
        aria-label={t("common.moreActions")}
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
          ariaLabel={t("editor.actions")}
          onClose={closeMore}
        />
      ) : null}
    </div>
  );
}
