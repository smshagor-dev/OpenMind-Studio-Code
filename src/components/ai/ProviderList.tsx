import { useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { PROVIDER_KIND_LABELS, type AiProviderView } from "../../services/ai/aiProviderService";
import { ConfirmDialog } from "../ConfirmDialog";

function statusOf(provider: AiProviderView): string {
  if (!provider.available) return provider.unavailableReason ?? "Unavailable.";
  return container.ai.providers.configIssue(provider) ?? "Ready.";
}

function keyState(provider: AiProviderView): string {
  if (provider.hasKey) return "API key saved";
  return provider.needsKey ? "No API key" : "No API key needed";
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
          {provider.local ? "Local" : "Online"} · {provider.host}
        </span>
        {isDefault ? <span className="ai-badge">Default</span> : null}
      </div>
      <p className="ai-provider__meta">
        {PROVIDER_KIND_LABELS[provider.kind]}
        {provider.sourceName === null ? "" : ` · from extension ${provider.sourceName}`}
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
          {test.status === "testing" ? "Testing the connection…" : test.message}
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
        Enabled
      </label>
      <button
        type="button"
        className="ai-link"
        onClick={() => {
          container.ai.ui.edit(provider.id);
        }}
      >
        Edit
      </button>
      <button
        type="button"
        className="ai-link"
        disabled={!provider.available || testing}
        title={
          provider.available
            ? "Ask the provider for its models to check the address and key"
            : (provider.unavailableReason ?? "")
        }
        onClick={() => {
          void providers.test(provider.id);
        }}
      >
        Test connection
      </button>
      <button
        type="button"
        className="ai-link"
        disabled={isDefault || !provider.available}
        title={
          isDefault ? "This is already the default." : "Select this provider first in the AI panel"
        }
        onClick={() => {
          void providers.setDefault(provider.id);
        }}
      >
        Set as default
      </button>
      {provider.source === null || provider.sourceMissing ? (
        <button
          type="button"
          className="ai-link ai-link--danger"
          onClick={() => {
            onDelete(provider.id);
          }}
        >
          Delete
        </button>
      ) : (
        <span className="ai-provider__hint">Disable or uninstall the extension to remove it.</span>
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
        Add provider
      </button>
      <button type="button" onClick={onClear}>
        Clear AI history
      </button>
      <button
        type="button"
        onClick={() => {
          container.ai.ui.closeManager();
        }}
      >
        Close
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
        A provider is a service or server you send text to. Nothing is sent until you press Send or
        run an AI action, and online providers ask first. API keys are stored encrypted on this
        computer.
      </p>
      {providers.length === 0 ? (
        <p className="ai-note">No AI providers yet. Add one to turn on the AI panel.</p>
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
          title="Delete provider"
          message={`Delete ${doomed.name} and its saved API key? This cannot be undone.`}
          confirmLabel="Delete"
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
          title="Clear AI history"
          message="Delete every saved AI conversation on this computer? This cannot be undone."
          confirmLabel="Clear history"
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
