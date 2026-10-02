import { useSyncExternalStore } from "react";

import { useT } from "../i18n";
import { container } from "../services/container";
import type { LspServerInfo } from "../services/ipc";
import { runtimeServers, toolState } from "../services/languageTools/languageToolsModel";

/**
 * The language tools of one Runtime Manager card ("Language Tools: Missing [Install Language Tools]", then
 * "Language Tools: fortls 3.2.2 · Status: Ready"). Installing goes through the Language Tools installer (offline bundle,
 * else npm / pip into the app's own `language-servers` folder); the line updates as soon as the status is read again.
 */
export function RuntimeLanguageTools({ runtimeId }: { runtimeId: string }) {
  const lsp = container.lsp;
  useSyncExternalStore(lsp.subscribe.bind(lsp), () => lsp.getState());
  const servers = runtimeServers(runtimeId, lsp.servers());
  if (servers.length === 0) return null;
  return (
    <div className="runtime-card__language-tools">
      {servers.map((server) => (
        <ToolLine key={server.id} server={server} installing={lsp.isInstalling(server.id)} />
      ))}
    </div>
  );
}

function ToolLine({ server, installing }: { server: LspServerInfo; installing: boolean }) {
  const t = useT();
  const state = toolState(server, installing);
  const absent = state === "missing" || state === "unavailable" || state === "installing";
  return (
    <div className="runtime-language-tool" data-state={state} aria-label={server.name}>
      <span className="runtime-language-tool__label">
        {state === "installing"
          ? t("languageTools.installingRow", { name: server.name })
          : absent
            ? t("languageTools.missing")
            : t("languageTools.present", { contents: server.contents })}
      </span>
      {state === "ready" || state === "running" || state === "included" ? (
        <span className="runtime-language-tool__status">{t(`languageTools.status.${state}`)}</span>
      ) : (
        <button
          type="button"
          className="button button--primary"
          disabled={state !== "missing"}
          title={server.installBlocked ?? t("languageTools.installTitle", { name: server.name, contents: server.contents })}
          onClick={() => void container.lsp.install(server.id)}
        >
          {state === "installing" ? t("languageTools.installing") : t("languageTools.install")}
        </button>
      )}
      {state === "unavailable" && server.installBlocked !== null ? (
        <span className="runtime-language-tool__reason">{server.installBlocked}</span>
      ) : null}
    </div>
  );
}
