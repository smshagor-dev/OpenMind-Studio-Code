import { useSyncExternalStore } from "react";

import { t } from "../i18n";
import { container } from "../services/container";

/** The editor languages that are x86 assembly. */
const ASSEMBLY_LANGUAGES = new Set(["nasm", "gas"]);

/**
 * "x86-64" (or "x86") next to the language name while an assembly file is in front: the architecture Run Code builds
 * for and asm-lsp checks against. A click opens the Assembly settings.
 */
export function AssemblyStatusItem({ languageId }: { languageId: string }) {
  useSyncExternalStore(
    (listener) => container.settings.subscribe(listener),
    () => container.settings.getState(),
  );
  if (!ASSEMBLY_LANGUAGES.has(languageId)) return null;
  const arch = container.settings.string("assembly.architecture", "x86-64");
  const syntax = languageId === "gas" ? "GAS" : "NASM";
  return (
    <button
      type="button"
      className="statusbar__item"
      title={t("status.assemblyTitle", { syntax, arch })}
      onClick={() => {
        container.preferencesPage.open("settings", { category: "Assembly" });
      }}
    >
      {syntax} · {arch}
    </button>
  );
}
