import { useEffect, useState } from "react";

import { container } from "../../services/container";
import type { AiProviderKind } from "../../services/ai/aiIpc";
import { DEFAULT_BASE_URLS, PROVIDER_KIND_LABELS } from "../../services/ai/aiProviderService";

const KINDS: AiProviderKind[] = ["openai-compatible", "claude", "gemini", "local"];

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  password?: boolean;
}

function TextField({ id, label, value, onChange, password, ...rest }: TextFieldProps) {
  return (
    <>
      <label className="ai-form__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="ai-input"
        type={password === true ? "password" : "text"}
        autoComplete={password === true ? "off" : undefined}
        spellCheck={password === true ? false : undefined}
        value={value}
        disabled={rest.disabled}
        required={rest.required}
        placeholder={rest.placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </>
  );
}

function KindField(props: {
  kind: AiProviderKind;
  disabled: boolean;
  onChange: (kind: AiProviderKind) => void;
}) {
  return (
    <>
      <label className="ai-form__label" htmlFor="ai-kind">
        Type
      </label>
      <select
        id="ai-kind"
        className="ai-select"
        value={props.kind}
        disabled={props.disabled}
        onChange={(event) => {
          props.onChange(event.target.value as AiProviderKind);
        }}
      >
        {KINDS.map((entry) => (
          <option key={entry} value={entry}>
            {PROVIDER_KIND_LABELS[entry]}
          </option>
        ))}
      </select>
    </>
  );
}

/** The API key field: masked, never pre-filled, and only a "saved" hint for a stored key. */
function KeyField(props: {
  value: string;
  onChange: (value: string) => void;
  saved: boolean;
  onClear: () => void;
}) {
  return (
    <>
      <TextField
        id="ai-key"
        label="API key"
        password
        value={props.value}
        placeholder={props.saved ? "Saved — type a new key to replace it" : "Paste the API key"}
        onChange={props.onChange}
      />
      <p className="ai-form__hint">
        Stored encrypted on this computer and only ever sent to the endpoint above. It is never
        shown again.
      </p>
      {props.saved ? (
        <button type="button" className="ai-link ai-link--danger" onClick={props.onClear}>
          Clear saved API key
        </button>
      ) : null}
    </>
  );
}

const LOCAL_HINT =
  "A local server needs no key. OpenMind does not run models itself: start your own OpenAI-compatible " +
  "server (for example Ollama or LM Studio) and give its address.";

/** Adds or edits one provider. An extension's provider keeps its name and type (the extension owns them). */
export function ProviderForm({ id }: { id: string }) {
  const existing = id === "new" ? undefined : container.ai.providers.find(id);
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<AiProviderKind>(existing?.kind ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [model, setModel] = useState(existing?.model ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromExtension = existing?.source != null;

  useEffect(() => {
    if (id !== "new" && !existing) container.ai.ui.edit(null);
  }, [id, existing]);

  const save = async () => {
    setBusy(true);
    const result = await container.ai.providers.save(
      { id: existing?.id, name, kind, baseUrl, model, enabled },
      key,
    );
    setBusy(false);
    if (result.ok) container.ai.ui.edit(null);
    else setError(result.error);
  };
  const clearKey = async () => {
    const failure = existing ? await container.ai.providers.clearKey(existing.id) : null;
    if (failure !== null) setError(failure);
  };
  return (
    <form
      className="ai-form"
      aria-label={existing ? `Edit ${existing.name}` : "Add provider"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TextField
        id="ai-name"
        label="Name"
        value={name}
        onChange={setName}
        disabled={fromExtension}
        required
      />
      <KindField kind={kind} disabled={fromExtension} onChange={setKind} />
      <TextField
        id="ai-url"
        label="Endpoint address"
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder={DEFAULT_BASE_URLS[kind]}
      />
      <TextField
        id="ai-model"
        label="Model"
        value={model}
        onChange={setModel}
        placeholder="For example gpt-4o-mini, or use Test connection to list models"
      />
      {kind === "local" ? (
        <p className="ai-form__hint">{LOCAL_HINT}</p>
      ) : (
        <KeyField
          value={key}
          onChange={setKey}
          saved={existing ? container.ai.providers.find(existing.id)?.hasKey === true : false}
          onClear={() => void clearKey()}
        />
      )}
      <label className="ai-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
        />
        Enabled
      </label>
      {error !== null ? (
        <p className="ai-note ai-note--error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal__actions">
        <button
          type="submit"
          className="modal__confirm--primary"
          disabled={busy || name.trim() === ""}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            container.ai.ui.edit(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
