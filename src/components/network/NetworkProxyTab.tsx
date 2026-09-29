import { useState } from "react";

import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { NetworkStatus } from "../../services/network/networkIpc";
import { diagnosticText, sourceText, testSummary } from "../../services/network/networkModel";
import type { NetworkState } from "../../services/network/networkService";

const MODES = ["none", "system", "manual"] as const;

function Field({ id, label, placeholder }: { id: string; label: string; placeholder?: string }) {
  const network = container.network;
  const saved = container.settings.string(id, "");
  // What the user is typing; `null` = show the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const problem = network.fieldProblem(id, value);
  const save = () => {
    if (draft === null || problem !== null) return;
    if (draft.trim() === saved) {
      setDraft(null);
      return;
    }
    void network.saveSetting(id, draft).then((done) => {
      if (done) setDraft(null);
    });
  };
  return (
    <label className="network__field">
      <span>{label}</span>
      <input
        className="network__input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={problem !== null}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
      {problem !== null ? (
        <span className="network__invalid" role="alert">
          {problem}
        </span>
      ) : null}
    </label>
  );
}

function Detected({ status }: { status: NetworkStatus }) {
  const rows: [string, string | null][] = [
    ["HTTP", status.http],
    ["HTTPS", status.https],
    ["SOCKS", status.socks],
  ];
  return (
    <div className="network__detected">
      <p className="network__source">{sourceText(status.source)}</p>
      {rows
        .filter(([, value]) => value !== null)
        .map(([name, value]) => (
          <p key={name} className="network__meta">
            {name}: <code>{value}</code>
          </p>
        ))}
    </div>
  );
}

/**
 * What the backend ignores or can't do with these settings (an address with credentials in it, a PAC script, a
 * SOCKS-only proxy ...), and terminals that still have the old settings: nothing is dropped without saying so.
 */
function Diagnostics({ state }: { state: NetworkState }) {
  const t = useT();
  const items = (state.status?.diagnostics ?? []).map((diagnostic) => ({
    severity: diagnostic.severity,
    text: diagnosticText(diagnostic),
  }));
  if (state.staleTerminals.length > 0) items.push({ severity: "warning", text: t("network.diag.staleTerminals") });
  if (items.length === 0) return null;
  return (
    <section className="network__section" aria-label={t("network.diag.title")}>
      <h3>{t("network.diag.title")}</h3>
      <ul className="network__diagnostics">
        {items.map((item) => (
          <li
            key={item.text}
            className={item.severity === "warning" ? "network__diagnostic network__diagnostic--warning" : "network__diagnostic"}
          >
            {item.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Test Connection's answer: an actionable headline, route/status/time, what to do, and the raw error on request. */
function TestResult({ state }: { state: NetworkState }) {
  const t = useT();
  if (state.test === null) return null;
  const summary = testSummary(state.test);
  return (
    <div className={summary.ok ? "network__result network__result--ok" : "network__result"} role="status">
      <p className="network__result-title">
        {summary.ok ? "✓ " : "✗ "}
        {summary.title}
      </p>
      <p className="network__meta">{summary.line}</p>
      {summary.hint !== null ? <p className="network__meta">{summary.hint}</p> : null}
      {summary.detail !== null ? (
        <details className="network__details">
          <summary>{t("network.test.details")}</summary>
          <code>{summary.detail}</code>
        </details>
      ) : null}
    </div>
  );
}

function Credentials({ state }: { state: NetworkState }) {
  const t = useT();
  const status = state.status;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <section className="network__section" aria-label={t("network.credentials.title")}>
      <h3>{t("network.credentials.title")}</h3>
      <p className="network__lead">{t("network.credentials.lead")}</p>
      {status?.hasCredentials === true ? (
        <p className="network__meta">{t("network.credentials.savedFor", { user: status.username ?? "" })}</p>
      ) : null}
      {status?.credentialProblem ? <p className="network__warning">{status.credentialProblem}</p> : null}
      <div className="network__row">
        <input
          className="network__input"
          aria-label={t("network.credentials.user")}
          placeholder={t("network.credentials.user")}
          autoComplete="off"
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
        />
        <input
          className="network__input"
          type="password"
          aria-label={t("network.credentials.password")}
          placeholder={t("network.credentials.password")}
          autoComplete="off"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <button
          type="button"
          disabled={state.busy || username.trim() === ""}
          onClick={() => {
            void container.network.saveCredentials(username, password).then((done) => {
              if (done) {
                setUsername("");
                setPassword("");
              }
            });
          }}
        >
          {t("network.credentials.save")}
        </button>
        <button
          type="button"
          disabled={state.busy || status?.hasCredentials !== true}
          onClick={() => {
            void container.network.clearCredentials();
          }}
        >
          {t("network.credentials.clear")}
        </button>
      </div>
    </section>
  );
}

/** Settings > Network: mode, addresses, credentials, Test Connection and the terminal's variables. */
export function NetworkProxyTab({ state }: { state: NetworkState }) {
  const t = useT();
  const status = state.status;
  const mode = status?.mode ?? "none";
  const [testUrl, setTestUrl] = useState("");
  return (
    <>
      <p className="network__lead">{t("network.lead")}</p>
      <Diagnostics state={state} />
      <fieldset className="network__modes">
        <legend>{t("setting.network.proxy.mode.title")}</legend>
        {MODES.map((value) => (
          <label key={value} className="network__mode">
            <input
              type="radio"
              name="network-mode"
              checked={mode === value}
              onChange={() => {
                void container.network.saveSetting("network.proxy.mode", value);
              }}
            />
            {t(`setting.network.proxy.mode.option.${value}`)}
          </label>
        ))}
      </fieldset>
      {mode === "system" && status !== null ? <Detected status={status} /> : null}
      {mode === "manual" ? (
        <section className="network__section">
          <Field id="network.proxy.http" label={t("setting.network.proxy.http.title")} placeholder="proxy.example.edu:3128" />
          <Field id="network.proxy.https" label={t("setting.network.proxy.https.title")} />
          <Field id="network.proxy.socks" label={t("setting.network.proxy.socks.title")} placeholder="socks5://host:1080" />
        </section>
      ) : null}
      {mode !== "none" ? (
        <>
          <section className="network__section">
            <Field id="network.proxy.noProxy" label={t("setting.network.proxy.noProxy.title")} />
            <Field id="network.goProxy" label={t("setting.network.goProxy.title")} />
          </section>
          <Credentials state={state} />
        </>
      ) : null}
      <section className="network__section" aria-label={t("network.test.title")}>
        <h3>{t("network.test.title")}</h3>
        <p className="network__lead">{t("network.test.lead")}</p>
        <div className="network__row">
          <input
            className="network__input"
            aria-label={t("setting.network.testUrl.title")}
            placeholder={status?.testUrl ?? ""}
            value={testUrl}
            onChange={(event) => {
              setTestUrl(event.target.value);
            }}
          />
          <button
            type="button"
            disabled={state.testing}
            onClick={() => {
              void container.network.test(testUrl);
            }}
          >
            {state.testing ? t("network.test.running") : t("network.test.button")}
          </button>
        </div>
        <TestResult state={state} />
      </section>
      <section className="network__section">
        <button
          type="button"
          onClick={() => {
            void container.network.showTerminalEnv();
          }}
        >
          {t("network.palette.showTerminalEnv")}
        </button>
        {state.env !== null ? (
          state.env.length === 0 ? (
            <p className="network__meta">{t("network.env.none")}</p>
          ) : (
            <pre className="network__env" aria-label={t("network.palette.showTerminalEnv")}>
              {state.env.map(([name, value]) => `${name}=${value}`).join("\n")}
            </pre>
          )
        ) : null}
      </section>
    </>
  );
}
