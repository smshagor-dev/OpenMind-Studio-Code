import { useEffect, useSyncExternalStore } from "react";

import { useT } from "../i18n";
import { container } from "../services/container";

/**
 * The MariaDB card's database line: "Database: Ready" once `data/mariadb` holds a database, otherwise "Not set up" with
 * the reason the automatic set-up gave (it is retried by MySQL > Start). Installing MariaDB sets the database up by
 * itself, so this line is how a failed set-up stays visible after the install message is dismissed.
 */
export function RuntimeDatabaseLine({ installed }: { installed: boolean }) {
  const t = useT();
  const mysql = container.mySql;
  const state = useSyncExternalStore(mysql.subscribe, mysql.getState);
  useEffect(() => {
    void mysql.refresh();
  }, [mysql, installed]);
  const status = state.status;
  if (!installed || status === null) return null;
  if (status.initialized) {
    return (
      <div className="runtime-language-tool" data-state="ready">
        <span className="runtime-language-tool__label">{t("runtimes.database")}</span>
        <span className="runtime-language-tool__status">{t("runtimes.databaseReady")}</span>
      </div>
    );
  }
  return (
    <div className="runtime-language-tool" data-state="unavailable">
      <span className="runtime-language-tool__label">{t("runtimes.databaseNotSetUp")}</span>
      <span className="runtime-language-tool__reason">{status.error ?? t("runtimes.databaseOnStart")}</span>
    </div>
  );
}
