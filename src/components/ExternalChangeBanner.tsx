import { useState } from "react";

import { container } from "../services/container";
import type { EditorTabView } from "../services/workspaceService";
import "../styles/externalSync.css";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The strip above an editor whose file was changed or deleted on disk by
 * someone else. With unsaved edits the file is never overwritten: the choices
 * are Compare, Reload from Disk (asks first, drops the edits), Keep My Changes
 * (the edits stay; saving will overwrite the file, on purpose) and Save As.
 * A deleted file keeps its text: Save (writes it back), Save As or Close.
 * UI only — `FileSyncService` and `DocumentService` do the work.
 */
export function ExternalChangeBanner({ tab }: { tab: EditorTabView }) {
  const [confirmReload, setConfirmReload] = useState(false);
  if (tab.external === "none") return null;
  const sync = container.fileSync;
  const button = (label: string, run: () => void) => (
    <button type="button" className="ext-banner__button" onClick={run}>
      {label}
    </button>
  );
  return (
    <div className="ext-banner" role="alert" aria-label="File changed on disk">
      {tab.external === "changed" ? (
        <>
          <span className="ext-banner__text">
            File changed on disk while you have unsaved changes.
          </span>
          {button("Compare", () => {
            sync.compare(tab.docId);
          })}
          {button("Reload from Disk", () => {
            setConfirmReload(true);
          })}
          {button("Keep My Changes", () => {
            sync.keepMine(tab.docId);
          })}
          {button("Save As…", () => {
            container.run("file.saveAs");
          })}
        </>
      ) : (
        <>
          <span className="ext-banner__text">
            This file was deleted or moved on disk. Your text is still here.
          </span>
          {button("Save", () => {
            container.run("file.save");
          })}
          {button("Save As…", () => {
            container.run("file.saveAs");
          })}
          {button("Close Tab", () => {
            container.run("file.closeActiveTab");
          })}
        </>
      )}
      {confirmReload ? (
        <ConfirmDialog
          title="Reload from Disk"
          message={`Reload "${tab.title}" from disk? Your unsaved changes will be lost.`}
          confirmLabel="Reload from Disk"
          onConfirm={() => {
            setConfirmReload(false);
            void sync.reloadFromDisk(tab.docId);
          }}
          onCancel={() => {
            setConfirmReload(false);
          }}
        />
      ) : null}
    </div>
  );
}
