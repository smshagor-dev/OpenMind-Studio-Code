import { useState } from "react";

import { container } from "../../services/container";
import type { AiProviderView } from "../../services/ai/aiProviderService";
import { useProviders } from "./aiHooks";

/** The model of the selected provider: a list when the provider told us its models, else a text field. */
function ModelPicker({ provider }: { provider: AiProviderView }) {
  const providers = container.ai.providers;
  const model = providers.modelOf(provider);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (value: string) => {
    setDraft(null);
    if (value.trim() !== model) void providers.setModel(provider.id, value.trim());
  };
  if (provider.models.length > 0) {
    const options =
      provider.models.includes(model) || model === ""
        ? provider.models
        : [model, ...provider.models];
    return (
      <select
        className="ai-select"
        aria-label="Model"
        value={model}
        onChange={(event) => {
          void providers.setModel(provider.id, event.target.value);
        }}
      >
        {model === "" ? <option value="">Choose a model</option> : null}
        {options.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="ai-input"
      type="text"
      aria-label="Model"
      placeholder="Model name"
      value={draft ?? model}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        if (draft !== null) commit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
    />
  );
}

function ProviderSelect({ selectedId }: { selectedId: string }) {
  const providers = useProviders();
  return (
    <select
      className="ai-select"
      aria-label="Provider"
      value={selectedId}
      onChange={(event) => {
        providers.select(event.target.value);
      }}
    >
      {providers.usable().map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.name}
        </option>
      ))}
    </select>
  );
}

/** Provider and model pickers, and the Online/Local label saying where requests go. */
export function ProviderBar() {
  const providers = useProviders();
  const provider = providers.selected();
  if (provider === null) return null;
  return (
    <div className="ai-bar">
      <div className="ai-bar__row">
        {providers.usable().length > 1 ? (
          <ProviderSelect selectedId={provider.id} />
        ) : (
          <span className="ai-bar__name" title={provider.name}>
            {provider.name}
          </span>
        )}
        <ModelPicker provider={provider} />
      </div>
      <div className="ai-bar__row">
        <span
          className={provider.local ? "ai-badge ai-badge--local" : "ai-badge ai-badge--online"}
          title={
            provider.local ? "Requests stay on this computer." : `Requests go to ${provider.host}.`
          }
        >
          {provider.local ? "Local" : "Online"}
          {" · "}
          {provider.host}
        </span>
        <button
          type="button"
          className="ai-link"
          onClick={() => {
            container.ai.ui.openManager(provider.id);
          }}
        >
          Provider settings
        </button>
      </div>
    </div>
  );
}
