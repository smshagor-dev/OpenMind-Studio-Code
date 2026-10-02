import { useEffect, useState, useSyncExternalStore } from "react";

import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { LspServerInfo } from "../../services/ipc";
import {
  installAllMissing,
  installableServers,
  serverLanguage,
  toolState,
  type ToolState,
} from "../../services/languageTools/languageToolsModel";
import { removeBlocked } from "../../services/lspAvailability";
import { Chip } from "./Chip";

const CHIP_TONE: Record<ToolState, string> = {
  missing: "warn",
  unavailable: "warn",
  installing: "info",
  included: "info",
  ready: "ok",
  running: "ok",
};

/**
 * Runtime Manager > Language Tools: every language server OpenMind can give a language — its language, what it
 * contains, whether it is missing, included with the app, installing, ready or running — with Install (and Install all
 * missing) and Remove. Installing goes through the Language Tools installer: the offline bundle when the app carries
 * the server, otherwise npm / pip into the app's own `language-servers` folder (proxy-aware; nothing outside it).
 */
export function LanguageServersSection() {
  const t = useT();
  const lsp = container.lsp;
  useSyncExternalStore(lsp.subscribe.bind(lsp), () => lsp.getState());
  const [installingAll, setInstallingAll] = useState(false);
  useEffect(() => {
    void lsp.refresh();
  }, [lsp]);
  const servers = lsp.servers();
  const missing = installableServers(servers, (id) => lsp.isInstalling(id));
  return (
    <section className="tc-section" aria-label={t("langServers.title")}>
      <h3 className="tc-section__title">
        {t("langServers.title")}
        <span className="tc-section__count">{servers.length}</span>
        <button
          type="button"
          className="button button--primary tc-section__action"
          disabled={missing.length === 0 || installingAll}
          title={missing.length === 0 ? t("langServers.nothingMissing") : missing.map((s) => s.name).join(", ")}
          onClick={() => {
            setInstallingAll(true);
            void installAllMissing(lsp).finally(() => {
              setInstallingAll(false);
            });
          }}
        >
          {installingAll
            ? t("langServers.installingAll")
            : t("langServers.installAll", { count: missing.length })}
        </button>
      </h3>
      <p className="tc-note">{t("langServers.note")}</p>
      {servers.length === 0 ? <p className="tc-note">{t("langServers.loading")}</p> : null}
      <div className="tc-grid">
        {servers.map((server) => (
          <ServerCard key={server.id} server={server} installing={lsp.isInstalling(server.id)} />
        ))}
      </div>
    </section>
  );
}

function ServerCard({ server, installing }: { server: LspServerInfo; installing: boolean }) {
  const t = useT();
  const lsp = container.lsp;
  const state = toolState(server, installing);
  const removal = removeBlocked(server);
  return (
    <article className="tc-card" aria-label={server.name}>
      <header className="tc-card__head">
        <h4 className="tc-card__name">{serverLanguage(server)}</h4>
        <Chip label={t(`langServers.state.${state}`)} tone={CHIP_TONE[state]} />
      </header>
      <p className="tc-card__summary" title={server.note ?? server.contents}>
        {server.name} · {server.contents}
      </p>
      {state === "unavailable" && server.installBlocked !== null ? (
        <p className="tc-card__hint" title={server.installBlocked}>
          {server.installBlocked}
        </p>
      ) : null}
      {state === "included" ? <p className="tc-card__hint">{t("langServers.includedHint")}</p> : null}
      <footer className="tc-card__actions">
        {state === "missing" || state === "unavailable" || state === "installing" ? (
          <button
            type="button"
            disabled={state !== "missing"}
            title={server.installBlocked ?? t("languageTools.installTitle", { name: server.name, contents: server.contents })}
            onClick={() => void lsp.install(server.id)}
          >
            {state === "installing" ? t("languageTools.installing") : t("langServers.install")}
          </button>
        ) : null}
        {(state === "ready" || state === "running") && removal === null ? (
          <button type="button" onClick={() => void lsp.uninstall(server.id)}>
            {t("langServers.remove")}
          </button>
        ) : null}
      </footer>
    </article>
  );
}
