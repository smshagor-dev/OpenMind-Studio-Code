import { useState, useSyncExternalStore } from "react";

import { useT } from "../i18n";
import { assemblySetup, installAssemblyToolchain } from "../services/assembly/assemblyToolchain";
import { container } from "../services/container";
import type { RuntimeStatus } from "../services/ipc";

/**
 * The Assembly card's complete setup: what the toolchain, its x86 part (only when the architecture is x86) and the
 * optional asm-lsp language server are right now, and one *Install Assembly Toolchain* click that adds whatever is
 * missing. The card's own Install (version picker) installs the toolchain — with the x86 part when x86 is chosen.
 */
export function AssemblySetupLine({ runtime }: { runtime: RuntimeStatus }) {
  const t = useT();
  useSyncExternalStore(
    (listener) => container.lsp.subscribe(listener),
    () => container.lsp.getState(),
  );
  useSyncExternalStore(
    (listener) => container.settings.subscribe(listener),
    () => container.settings.getState(),
  );
  const [busy, setBusy] = useState(false);
  const setup = assemblySetup(
    runtime,
    container.lsp.servers(),
    container.settings.string("assembly.architecture", "x86-64"),
    container.settings.bool("assembly.enableLanguageServer", true),
  );
  const working = busy || container.runtime.getState().working[runtime.id] !== undefined;
  return (
    <div className="runtime-card__setup" aria-label={t("assembly.setup.label")}>
      <p className="runtime-card__setup-parts">
        <span>{t(`assembly.setup.toolchain.${setup.toolchain}`)}</span>
        {setup.x86 !== "notNeeded" ? <span>{t(`assembly.setup.x86.${setup.x86}`)}</span> : null}
        <span>{t(`assembly.setup.lsp.${setup.languageServer}`)}</span>
      </p>
      <button
        type="button"
        className="button"
        disabled={!setup.incomplete || working}
        title={setup.incomplete ? t("assembly.setup.installTitle") : t("assembly.setup.complete")}
        onClick={() => {
          setBusy(true);
          void installAssemblyToolchain({
            runtime: container.runtime,
            lsp: container.lsp,
            settings: container.settings,
          }).finally(() => {
            setBusy(false);
          });
        }}
      >
        {working ? t("runtimes.installing") : t("run.missing.install", { name: t("assembly.toolchain") })}
      </button>
    </div>
  );
}
