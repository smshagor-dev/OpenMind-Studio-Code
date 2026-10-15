import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../i18n";
import type { AgentOptions } from "../../services/agent/agentOptions";
export function AgentCapabilities({
  draft,
  onChange,
}: {
  draft: AgentOptions;
  onChange: (options: AgentOptions) => void;
}) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  return (
    <>
      <p>{t("agent.capabilities.hint")}</p>
      {(["searchEndpoint", "visionEndpoint", "imageEndpoint"] as const).map((key) => (
        <label key={key}>
          {t(`agent.settings.${key}`)}
          <input
            type="url"
            disabled={checking}
            value={draft[key]}
            placeholder={
              key === "searchEndpoint"
                ? "https://search.example.org"
                : key === "visionEndpoint"
                  ? "http://127.0.0.1:8081/v1"
                  : "http://127.0.0.1:7860"
            }
            onChange={(event) => {
              setStatus([]);
              onChange({ ...draft, [key]: event.target.value });
            }}
          />
        </label>
      ))}
      <button
        type="button"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          void invoke<string[]>("agent_capabilities_check", { options: draft })
            .then(setStatus)
            .catch((error: unknown) => {
              setStatus([String(error)]);
            })
            .finally(() => {
              setChecking(false);
            });
        }}
      >
        {checking ? t("agent.loading") : t("agent.capabilities.check")}
      </button>
      <div role="status">
        {status.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </>
  );
}
