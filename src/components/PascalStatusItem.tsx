import { useSyncExternalStore } from "react";

import { t } from "../i18n";
import { container } from "../services/container";
import { compilerName, compilerOf } from "../services/pascal/pascalModel";

/**
 * "Free Pascal" or "PascalABC.NET" next to the language name while a Pascal file is in front: the compiler Run Code
 * builds it with. A click opens the Pascal settings, where the compiler is chosen.
 */
export function PascalStatusItem({ languageId }: { languageId: string }) {
  useSyncExternalStore(
    (listener) => container.settings.subscribe(listener),
    () => container.settings.getState(),
  );
  if (languageId !== "pascal") return null;
  const name = compilerName(compilerOf(container.settings.string("pascal.compiler", "fpc")));
  return (
    <button
      type="button"
      className="statusbar__item"
      title={t("status.pascalTitle", { compiler: name })}
      onClick={() => {
        container.preferencesPage.open("settings", { category: "Pascal" });
      }}
    >
      {name}
    </button>
  );
}
