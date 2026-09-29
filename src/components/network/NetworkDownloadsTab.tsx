import { useT } from "../../i18n";
import { container } from "../../services/container";
import type { BrokerEvent, BrokerStatus } from "../../services/network/brokerIpc";
import { formatBytes, isActive, percent, providerLabel } from "../../services/network/downloadsModel";
import type { NetworkState } from "../../services/network/networkService";

function GatewayLine({ gateway }: { gateway: BrokerStatus | null }) {
  const t = useT();
  if (gateway === null) return <p className="network__meta">{t("network.downloads.unknown")}</p>;
  if (gateway.problem !== null) {
    return <p className="network__warning">{t("network.downloads.gatewayProblem", { problem: gateway.problem })}</p>;
  }
  if (!gateway.enabled) return <p className="network__meta">{t("network.downloads.gatewayOff")}</p>;
  return (
    <p className="network__ok" role="status">
      {t("network.downloads.gatewayRunning", { port: gateway.port ?? 0, npmPort: gateway.npmPort ?? 0 })}
    </p>
  );
}

function Download({ event }: { event: BrokerEvent }) {
  const t = useT();
  const share = percent(event);
  const size = event.total !== null ? `${formatBytes(event.bytes)} / ${formatBytes(event.total)}` : formatBytes(event.bytes);
  const active = isActive(event);
  return (
    <li className="network__entry" aria-label={event.artifact}>
      <div>
        <p className="network__name">
          {providerLabel(event.provider)} · {event.artifact}
        </p>
        <p className="network__meta">
          {t(`network.phase.${event.phase}`)}
          {event.bytes > 0 ? ` · ${size}` : ""}
          {share !== null && active ? ` · ${share}%` : ""}
          {active && event.speed > 0 ? ` · ${t("network.downloads.speed", { speed: formatBytes(event.speed) })}` : ""}
          {event.retry !== null ? ` · ${t("network.downloads.attempt", { attempt: event.retry })}` : ""}
        </p>
        {share !== null && active ? <progress className="network__progress" max={100} value={share} /> : null}
        {event.detail !== null && event.phase === "failed" ? <p className="network__warning">{event.detail}</p> : null}
      </div>
      {active ? (
        <button
          type="button"
          onClick={() => {
            void container.network.cancelDownload(event.id);
          }}
        >
          {t("common.cancel")}
        </button>
      ) : null}
    </li>
  );
}

/** The package gateway and what it downloaded this session. Showing it reads local state only. */
export function NetworkDownloadsTab({ state }: { state: NetworkState }) {
  const t = useT();
  const gateway = state.gateway;
  return (
    <div className="network__section">
      <GatewayLine gateway={gateway} />
      <p className="network__meta">{t("network.downloads.explain")}</p>
      {gateway !== null && gateway.skipped.length > 0 ? (
        <div className="network__card">
          <p className="network__name">{t("network.downloads.skipped")}</p>
          <ul>
            {gateway.skipped.map((item) => (
              <li key={item.tool}>
                {item.tool}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {gateway !== null ? (
        <p className="network__meta">
          {t("network.downloads.temp", { path: gateway.tempDir })}
          {gateway.recovery !== null
            ? ` ${t("network.downloads.recovered", { removed: gateway.recovery.removed, kept: gateway.recovery.keptPartial })}`
            : ""}
        </p>
      ) : null}
      {state.downloads.length === 0 ? (
        <p className="network__meta">{t("network.downloads.empty")}</p>
      ) : (
        <ul className="network__list">
          {state.downloads.map((event) => (
            <Download key={event.id} event={event} />
          ))}
        </ul>
      )}
      <div className="network__row">
        <button
          type="button"
          disabled={state.busy}
          onClick={() => {
            void container.network.exportDiagnostics();
          }}
        >
          {t("network.diagnostics.export")}
        </button>
      </div>
      <p className="network__meta">{t("network.diagnostics.explain")}</p>
    </div>
  );
}
