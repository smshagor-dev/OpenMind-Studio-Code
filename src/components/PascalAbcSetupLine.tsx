import { useEffect, useState, useSyncExternalStore } from "react";

import { useT } from "../i18n";
import { container } from "../services/container";
import type { RuntimeStatus } from "../services/ipc";
import { pascalAbcSetup, pascalIpc, type PascalStatus } from "../services/pascal/pascalModel";

/**
 * The PascalABC.NET card's requirements: the .NET Framework it runs on (part of Windows, detected, never installed),
 * whether this copy ships the compiler (then Install needs no download), and whether Run Code uses it — with a button
 * that makes it the Pascal compiler (the `pascal.compiler` user setting; Free Pascal stays installed).
 */
export function PascalAbcSetupLine({ runtime }: { runtime: RuntimeStatus }) {
  const t = useT();
  useSyncExternalStore(
    (listener) => container.settings.subscribe(listener),
    () => container.settings.getState(),
  );
  const chosen = container.settings.string("pascal.compiler", "fpc");
  const installedCount = runtime.installed.length;
  const [status, setStatus] = useState<PascalStatus | null>(null);
  useEffect(() => {
    let current = true;
    pascalIpc
      .status()
      .then((next) => {
        if (current) setStatus(next);
      })
      .catch(() => {
        if (current) setStatus(null);
      });
    return () => {
      current = false;
    };
  }, [chosen, installedCount]);
  if (status === null) return null;
  const lines = pascalAbcSetup(status);
  return (
    <div className="runtime-card__setup" aria-label={t("pascal.setup.label")}>
      <p className="runtime-card__setup-parts">
        {lines.map((line) => (
          <span key={line.key} className={line.problem ? "runtime-card__setup-problem" : undefined}>
            {t(line.key, line.values)}
          </span>
        ))}
      </p>
      {status.platformSupported && status.compiler !== "pascalabc" ? (
        <button
          type="button"
          className="button"
          title={t("pascal.setup.useTitle")}
          onClick={() => {
            void container.settings.set("user", "pascal.compiler", "pascalabc");
          }}
        >
          {t("pascal.setup.use")}
        </button>
      ) : null}
    </div>
  );
}
