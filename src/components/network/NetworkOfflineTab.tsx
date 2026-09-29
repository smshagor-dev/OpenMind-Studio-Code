import { useState } from "react";

import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { CacheEntry, Inspection } from "../../services/network/networkIpc";
import { kindText, sizeText } from "../../services/network/networkModel";
import type { NetworkState } from "../../services/network/networkService";

function Pending({ inspection, busy }: { inspection: Inspection; busy: boolean }) {
  const t = useT();
  const usable = inspection.kind !== null && inspection.compatible;
  return (
    <div className="network__card" role="group" aria-label={inspection.fileName}>
      <p className="network__name">{inspection.name}</p>
      <p className="network__meta">
        {inspection.kind !== null ? kindText(inspection.kind) : t("network.kind.unknown")}
        {inspection.version !== null ? ` · ${inspection.version}` : ""}
        {inspection.architecture !== null ? ` · ${inspection.architecture}` : ""}
        {` · ${sizeText(inspection.size)}`}
      </p>
      <p className="network__meta">
        SHA-256 <code>{inspection.sha256.slice(0, 16)}…</code>
      </p>
      {inspection.reason !== null ? <p className="network__warning">{inspection.reason}</p> : null}
      <div className="network__row">
        <button
          type="button"
          className="modal__confirm--primary"
          disabled={!usable || busy}
          onClick={() => {
            void container.network.confirmImport();
          }}
        >
          {t("network.offline.import")}
        </button>
        <button
          type="button"
          onClick={() => {
            container.network.cancelImport();
          }}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function Entry({ entry, busy }: { entry: CacheEntry; busy: boolean }) {
  const t = useT();
  const network = container.network;
  const next =
    entry.kind === "vsix"
      ? { label: t("network.offline.install"), run: () => network.installExtension(entry.id) }
      : entry.kind === "runtime"
        ? {
            label: t("network.offline.openRuntimes"),
            run: () => {
              network.openRuntimeManager();
              return Promise.resolve();
            },
          }
        : entry.kind === "sourceArchive"
          ? { label: t("network.offline.extract"), run: () => network.extract(entry.id) }
          : null;
  return (
    <li className="network__entry">
      <div>
        <p className="network__name">
          {entry.name}
          {entry.version !== null ? ` ${entry.version}` : ""}
        </p>
        <p className="network__meta">
          {kindText(entry.kind)} · {entry.architecture ?? "any"} · {sizeText(entry.size)} ·{" "}
          {t("network.offline.sourceLocal")}
        </p>
      </div>
      <div className="network__row">
        {next !== null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void next.run();
            }}
          >
            {next.label}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void network.remove(entry.id);
          }}
        >
          {t("network.offline.remove")}
        </button>
      </div>
    </li>
  );
}

/**
 * The offline Python wheelhouse: the wheels imported for this computer, the ones a folder import refused (and why),
 * and Install from Wheelhouse — pip with `--no-index`, so it looks only here and makes no network request.
 */
function WheelhouseSection({ state }: { state: NetworkState }) {
  const t = useT();
  const network = container.network;
  const wheels = state.wheelhouse?.wheels ?? [];
  const [requirements, setRequirements] = useState("");
  return (
    <section className="network__section" aria-label={t("network.wheels.title")}>
      <h3>{t("network.wheels.title")}</h3>
      <p className="network__lead">{t("network.wheels.lead")}</p>
      {state.wheelImport !== null && state.wheelImport.refused.length > 0 ? (
        <div className="network__warning" role="alert">
          <p>{t("network.wheels.refused")}</p>
          <ul className="network__refused">
            {state.wheelImport.refused.map((wheel) => (
              <li key={wheel.file}>
                <code>{wheel.file}</code>: {wheel.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {wheels.length === 0 ? (
        <p className="network__meta">{t("network.wheels.none")}</p>
      ) : (
        <>
          <p className="network__meta">{t("network.wheels.recognized")}</p>
          <ul className="network__wheels" aria-label={t("network.wheels.recognized")}>
            {wheels.map((wheel) => (
              <li key={wheel.id}>
                {wheel.name}
                {wheel.version !== null ? ` ${wheel.version}` : ""}
                <span className="network__meta"> · {wheel.architecture ?? "any"}</span>
              </li>
            ))}
          </ul>
          <div className="network__row">
            <input
              className="network__input"
              aria-label={t("network.wheels.packages")}
              placeholder="django pandas"
              spellCheck={false}
              value={requirements}
              onChange={(event) => {
                setRequirements(event.target.value);
              }}
            />
            <button
              type="button"
              className="modal__confirm--primary"
              disabled={state.busy || requirements.trim() === ""}
              onClick={() => {
                void network.installFromWheelhouse(requirements);
              }}
            >
              {t("network.wheels.install")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Offline packages: import from a USB drive or folder, what is in the cache, and what to do with each. */
export function NetworkOfflineTab({ state }: { state: NetworkState }) {
  const t = useT();
  const network = container.network;
  return (
    <>
      <p className="network__lead">{t("network.offline.lead")}</p>
      <div className="network__row">
        <button
          type="button"
          className="modal__confirm--primary"
          disabled={state.busy}
          onClick={() => {
            void network.chooseImport();
          }}
        >
          {t("network.palette.importOffline")}
        </button>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => {
            void network.importWheelFolder();
          }}
        >
          {t("network.wheels.importFolder")}
        </button>
        <button
          type="button"
          onClick={() => {
            void network.openCacheFolder();
          }}
        >
          {t("network.palette.openCacheFolder")}
        </button>
        <button
          type="button"
          disabled={state.busy || state.offline.length === 0}
          onClick={() => {
            void network.clearCache();
          }}
        >
          {t("network.offline.clear")}
        </button>
      </div>
      <label className="network__check">
        <input
          type="checkbox"
          checked={state.status?.useWheelhouse === true}
          onChange={(event) => {
            void network.saveSetting("network.offline.useWheelhouse", event.target.checked);
          }}
        />
        {t("setting.network.offline.useWheelhouse.title")}
      </label>
      {state.inspection !== null ? <Pending inspection={state.inspection} busy={state.busy} /> : null}
      <WheelhouseSection state={state} />
      {state.offline.length === 0 ? (
        <p className="network__meta">{t("network.offline.empty")}</p>
      ) : (
        <ul className="network__list" aria-label={t("network.tab.offline")}>
          {state.offline.map((entry) => (
            <Entry key={entry.id} entry={entry} busy={state.busy} />
          ))}
        </ul>
      )}
    </>
  );
}
