import { useEffect, useState } from "react";

import { t, useT } from "../i18n";
import {
  formatBytes,
  messageOf,
  sourceProfile,
  targetProfile,
  type DataScopeApi,
  type DataScopeMode,
  type DataScopeStatus,
  type MigrationOutcome,
} from "./dataScopeApi";
import "../styles/dataScope.css";

type Load =
  | { state: "loading" }
  | { state: "ready"; status: DataScopeStatus }
  | { state: "failed"; error: string };

const MODES: DataScopeMode[] = ["personal", "perMachine"];

/**
 * The portable data scope choice: "Only for me" (one profile) or "Everyone / Multi-computer" (one per computer), made
 * once in the first-run setup window — it is not offered in the workbench. Nothing changes until the user presses the
 * button, and nothing is ever deleted: an existing profile is copied, never moved.
 */
export function DataScopePanel({ api }: { api: DataScopeApi }) {
  useT();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [choice, setChoice] = useState<DataScopeMode | null>(null);
  const [useExisting, setUseExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MigrationOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(
      (status) => {
        setLoad({ state: "ready", status });
        setChoice(status.mode ?? status.recommended);
      },
      (failure: unknown) => {
        setLoad({ state: "failed", error: messageOf(failure) });
      },
    );
  }, [api]);

  if (load.state === "loading") {
    return <p className="data-scope__muted">{t("dataScope.loading")}</p>;
  }
  if (load.state === "failed") {
    return (
      <>
        <p role="alert">{t("dataScope.loadFailed", { error: load.error })}</p>
        <Footer api={api} />
      </>
    );
  }
  const status = load.status;
  if (status.managed) {
    return <ManagedLayout status={status} api={api} />;
  }
  const selected = choice ?? status.recommended;
  const target = targetProfile(status, selected);
  const source = target === null ? sourceProfile(status, selected) : null;

  const apply = () => {
    setBusy(true);
    setError(null);
    api.apply(selected, source !== null && useExisting).then(
      (done) => {
        setBusy(false);
        setOutcome(done);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(t("dataScope.failed", { error: messageOf(failure) }));
      },
    );
  };

  return (
    <div className="data-scope">
      <p className="data-scope__lead">{t("dataScope.lead")}</p>
      {status.unreadable !== null && (
        <p className="data-scope__warning" role="alert">
          {t("dataScope.unreadable", { reason: status.unreadable })}
        </p>
      )}
      {status.temporaryFolder && (
        <p className="data-scope__warning" role="alert">
          {t("dataScope.temporaryFolder", { folder: status.appFolder })}
        </p>
      )}
      {status.singleComputer && (
        <p className="data-scope__muted">{t("dataScope.singleComputer")}</p>
      )}
      <div className="data-scope__options" role="radiogroup" aria-label={t("dataScope.title")}>
        {MODES.map((mode) => (
          <label
            key={mode}
            className={`data-scope__option${mode === selected ? " data-scope__option--selected" : ""}`}
          >
            <input
              type="radio"
              name="data-scope"
              value={mode}
              checked={mode === selected}
              disabled={busy || outcome !== null}
              onChange={() => {
                setChoice(mode);
              }}
            />
            <span className="data-scope__option-text">
              <strong>{t(`dataScope.${mode}.title`)}</strong>
              {mode === "perMachine" && (
                <span className="data-scope__badge data-scope__badge--recommended">
                  {t("dataScope.recommended")}
                </span>
              )}
              {mode === status.mode && (
                <span className="data-scope__badge">{t("dataScope.current")}</span>
              )}
              <span>{t(`dataScope.${mode}.body`)}</span>
              <span className="data-scope__muted">{t(`dataScope.${mode}.hint`)}</span>
              {mode === "perMachine" && (
                <span className="data-scope__muted">{t("dataScope.perMachine.shared")}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      <Consequences
        status={status}
        selected={selected}
        target={target?.path ?? null}
        source={source}
        useExisting={useExisting}
        setUseExisting={setUseExisting}
        disabled={busy || outcome !== null}
      />
      <p className="data-scope__muted">
        {t("dataScope.profileId", { id: status.profileId })} ·{" "}
        {t(`dataScope.identity.${status.identitySource}`)}
        {status.profiles.length > 0 && (
          <> · {t("dataScope.profiles", { count: status.profiles.length })}</>
        )}
      </p>
      {error !== null && (
        <p className="data-scope__warning" role="alert">
          {error}
        </p>
      )}
      {outcome !== null ? (
        <Done outcome={outcome} api={api} />
      ) : (
        <div className="data-scope__actions">
          <button type="button" className="data-scope__primary" disabled={busy} onClick={apply}>
            {busy ? t("dataScope.applying") : t("dataScope.continue")}
          </button>
          <Footer api={api} />
        </div>
      )}
    </div>
  );
}

/** A per-machine or network installation: the installer decided where each computer's data lives; nothing to choose. */
function ManagedLayout({ status, api }: { status: DataScopeStatus; api: DataScopeApi }) {
  return (
    <div className="data-scope">
      <p className="data-scope__lead">
        {t(`dataScope.managed.${status.layout === "network" ? "network" : "perMachine"}`)}
      </p>
      <p className="data-scope__muted">
        {t("dataScope.managed.installedAt", { folder: status.appFolder })}
      </p>
      {status.localFolder !== null && (
        <p className="data-scope__muted">
          {t("dataScope.managed.localFolder", { folder: status.localFolder })}
        </p>
      )}
      <p className="data-scope__muted">{t("dataScope.managed.byInstaller")}</p>
      <div className="data-scope__actions">
        <Footer api={api} />
      </div>
    </div>
  );
}

function Consequences(props: {
  status: DataScopeStatus;
  selected: DataScopeMode;
  target: string | null;
  source: { path: string; bytes: number } | null;
  useExisting: boolean;
  setUseExisting: (value: boolean) => void;
  disabled: boolean;
}) {
  const { selected, target, source } = props;
  return (
    <div className="data-scope__consequences">
      {target !== null ? (
        <p>{t("dataScope.targetExists", { path: target })}</p>
      ) : source !== null ? (
        <>
          <p>
            {t("dataScope.existingFound", { path: source.path, size: formatBytes(source.bytes) })}
          </p>
          <label className="data-scope__check">
            <input
              type="checkbox"
              checked={props.useExisting}
              disabled={props.disabled}
              onChange={(event) => {
                props.setUseExisting(event.target.checked);
              }}
            />
            {t(`dataScope.useExisting.${selected}`)}
          </label>
          {!props.useExisting && <p className="data-scope__muted">{t("dataScope.fresh")}</p>}
        </>
      ) : (
        <p className="data-scope__muted">{t("dataScope.fresh")}</p>
      )}
      {(props.status.mode !== null || source !== null) && (
        <p className="data-scope__warning">{t(`dataScope.warning.${selected}`)}</p>
      )}
    </div>
  );
}

function Done({ outcome, api }: { outcome: MigrationOutcome; api: DataScopeApi }) {
  const [error, setError] = useState<string | null>(null);
  const text = outcome.willImport
    ? t("dataScope.done.import", { database: outcome.database })
    : outcome.keptExisting
      ? t("dataScope.done.kept", { database: outcome.database })
      : t("dataScope.done.fresh", { database: outcome.database });
  return (
    <>
      <p role="status">{text}</p>
      {error !== null && <p role="alert">{error}</p>}
      <div className="data-scope__actions">
        <button
          type="button"
          className="data-scope__primary"
          onClick={() => {
            api.restart().catch((failure: unknown) => {
              setError(t("dataScope.failed", { error: messageOf(failure) }));
            });
          }}
        >
          {t("dataScope.start")}
        </button>
      </div>
    </>
  );
}

/** Exit without choosing (the app can't start without a data scope). */
function Footer({ api }: { api: DataScopeApi }) {
  return (
    <button
      type="button"
      onClick={() => {
        void api.exit();
      }}
    >
      {t("dataScope.exit")}
    </button>
  );
}
