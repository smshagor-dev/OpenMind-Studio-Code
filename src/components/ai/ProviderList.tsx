import { useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { PROVIDER_KIND_LABELS, type AiProviderView } from "../../services/ai/aiProviderService";
import { ConfirmDialog } from "../ConfirmDialog";
import { t } from "../../i18n";

function statusOf(provider: AiProviderView): string {
  if (!provider.available) return provider.unavailableReason ?? t("ai.unavailable");
  return container.ai.providers.configIssue(provider) ?? t("ai.ready");
}

function keyState(provider: AiProviderView): string {
  if (provider.hasKey) return t("ai.keySaved");
  return provider.needsKey ? t("ai.noKey") : t("ai.noKeyNeeded");
}

/** Name, Online/Local label, kind, key state, status and the last connection test of one provider. */
function ProviderSummary({
  provider,
  isDefault,
}: {
  provider: AiProviderView;
  isDefault: boolean;
}) {
  const test = container.ai.providers.getState().tests[provider.id];
  return (
    <>
      <div className="ai-provider__head">
        <strong className="ai-provider__name">{provider.name}</strong>
        <span className={provider.local ? "ai-badge ai-badge--local" : "ai-badge ai-badge--online"}>
          {provider.local ? t("ai.local") : t("ai.online")} · {provider.host}
        </span>
        {isDefault ? <span className="ai-badge">{t("keys.source.default")}</span> : null}
      </div>
      <p className="ai-provider__meta">
        {PROVIDER_KIND_LABELS[provider.kind]}
        {provider.sourceName === null
          ? ""
          : ` · ${t("ai.fromExtension", { name: provider.sourceName })}`}
        {" · "}
        {keyState(provider)}
      </p>
      <p className="ai-provider__status" role="status">
        {statusOf(provider)}
      </p>
      {test && test.status !== "idle" ? (
        <p
          className={test.status === "failed" ? "ai-note ai-note--error" : "ai-note"}
          role="status"
        >
          {test.status === "testing" ? t("ai.testing") : test.message}
        </p>
      ) : null}
    </>
  );
}

interface ActionsProps {
  provider: AiProviderView;
  isDefault: boolean;
  onDelete: (id: string) => void;
}

function ProviderActions({ provider, isDefault, onDelete }: ActionsProps) {
  const providers = container.ai.providers;
  const testing = providers.getState().tests[provider.id]?.status === "testing";
  return (
    <div className="ai-provider__actions">
      <label className="ai-check">
        <input
          type="checkbox"
          checked={provider.enabled}
          onChange={(event) => {
            void providers.setEnabled(provider.id, event.target.checked);
          }}
        />
        {t("extDetails.enabled")}
      </label>
      <button
        type="button"
        className="ai-link"
        onClick={() => {
          container.ai.ui.edit(provider.id);
        }}
      >
        {t("ai.edit")}
      </button>
      <button
        type="button"
        className="ai-link"
        disabled={!provider.available || testing}
        title={
          provider.available
            ? t("ai.testTitle")
            : (provider.unavailableReason ?? "")
        }
        onClick={() => {
          void providers.test(provider.id);
        }}
      >
        {t("ai.test")}
      </button>
      <button
        type="button"
        className="ai-link"
        disabled={isDefault || !provider.available}
        title={
          isDefault ? t("ai.alreadyDefault") : t("ai.defaultTitle")
        }
        onClick={() => {
          void providers.setDefault(provider.id);
        }}
      >
        {t("ai.setDefault")}
      </button>
      {provider.source === null || provider.sourceMissing ? (
        <button
          type="button"
          className="ai-link ai-link--danger"
          onClick={() => {
            onDelete(provider.id);
          }}
        >
          {t("runtimes.delete")}
        </button>
      ) : (
        <span className="ai-provider__hint">{t("ai.extensionOwned")}</span>
      )}
    </div>
  );
}

function ProviderRow(props: { provider: AiProviderView; onDelete: (id: string) => void }) {
  const isDefault = container.settings.string("ai.defaultProvider", "") === props.provider.id;
  return (
    <li className="ai-provider">
      <ProviderSummary provider={props.provider} isDefault={isDefault} />
      <ProviderActions provider={props.provider} isDefault={isDefault} onDelete={props.onDelete} />
    </li>
  );
}

function ListButtons({ onClear }: { onClear: () => void }) {
  return (
    <div className="modal__actions ai-manager__actions">
      <button
        type="button"
        className="modal__confirm--primary"
        onClick={() => {
          container.ai.ui.edit("new");
        }}
      >
        {t("ai.addProvider")}
      </button>
      <button type="button" onClick={onClear}>
        {t("ai.clearHistory")}
      </button>
      <button
        type="button"
        onClick={() => {
          container.ai.ui.closeManager();
        }}
      >
        {t("common.close")}
      </button>
    </div>
  );
}

/** Every configured provider, and the two confirmations (delete a provider, clear the history). */
export function ProviderList() {
  useSyncExternalStore(
    (listener) => container.ai.providers.subscribe(listener),
    () => container.ai.providers.getVersion(),
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const providers = container.ai.providers.all();
  const doomed = deleting === null ? undefined : container.ai.providers.find(deleting);
  return (
    <>
      <p className="ai-intro">
        {t("ai.intro")}
      </p>
      {providers.length === 0 ? (
        <p className="ai-note">{t("ai.noProviders")}</p>
      ) : (
        <ul className="ai-providers">
          {providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} onDelete={setDeleting} />
          ))}
        </ul>
      )}
      <ListButtons
        onClear={() => {
          setClearing(true);
        }}
      />
      {doomed ? (
        <ConfirmDialog
          title={t("ai.deleteProvider")}
          message={t("ai.deleteMessage", { name: doomed.name })}
          confirmLabel={t("runtimes.delete")}
          onConfirm={() => {
            setDeleting(null);
            void container.ai.providers.remove(doomed.id);
          }}
          onCancel={() => {
            setDeleting(null);
          }}
        />
      ) : null}
      {clearing ? (
        <ConfirmDialog
          title={t("ai.clearHistory")}
          message={t("ai.clearHistoryMessage")}
          confirmLabel={t("ai.clearHistoryConfirm")}
          onConfirm={() => {
            setClearing(false);
            void container.ai.chat.clearHistory();
          }}
          onCancel={() => {
            setClearing(false);
          }}
        />
      ) : null}
    </>
  );
}
