import { useEffect, useSyncExternalStore } from "react";

import { t, useT } from "../i18n";
import { DataScopePanel } from "./DataScopePanel";
import type { DataScopeApi } from "./dataScopeApi";
import type { DataScopeDialogService } from "./dataScopeDialogService";

/** File > Preferences > Data Scope...: the same choice as the first-run window, from the workbench. */
export function DataScopeDialog({ service, api }: { service: DataScopeDialogService; api: DataScopeApi }) {
  useT();
  const open = useSyncExternalStore(service.subscribe, service.isOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") service.close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, service]);
  if (!open) return null;
  const close = () => {
    service.close();
  };
  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal modal--data-scope"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-scope-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="data-scope-title">{t("dataScope.workbenchTitle")}</h2>
        <DataScopePanel api={api} context="workbench" onClose={close} />
      </div>
    </div>
  );
}
