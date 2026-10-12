import { useSyncExternalStore } from "react";

import { t, useT } from "../../i18n";
import { updates } from "../../services/updates";
import { statusText } from "../../services/updates/updateModel";

/** The update in the status bar: nothing while up to date; downloading / ready / a problem worth knowing about. */
export function UpdateStatusItem() {
  useT();
  const { info } = useSyncExternalStore(updates.subscribe, updates.getState);
  const text = statusText(info);
  if (text === null) return null;
  return (
    <button
      type="button"
      className={`statusbar__item${text.prominent ? " statusbar__item--update" : ""}`}
      title={t("update.tooltip")}
      onClick={() => {
        updates.openDialog();
      }}
    >
      {t(text.key, text.params)}
    </button>
  );
}
