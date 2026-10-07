import { t, useT } from "../i18n";
import { DataScopePanel } from "./DataScopePanel";
import type { DataScopeApi } from "./dataScopeApi";

/**
 * The first window of a portable copy whose data scope was never chosen (a fresh copy, or one from before data scopes
 * existed). It is shown before any database is opened; after the choice the app restarts into the workbench.
 */
export function DataScopeSetupPage({ api }: { api: DataScopeApi }) {
  useT();
  return (
    <main className="data-scope-setup">
      <h1 className="data-scope-setup__heading">{t("dataScope.title")}</h1>
      <DataScopePanel api={api} context="setup" />
    </main>
  );
}
