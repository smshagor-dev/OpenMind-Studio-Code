import { t } from "../../i18n";
import type {
  Check,
  DeploymentView,
  OfferView,
  ProvisionKind,
  ProvisionOutcome,
  SearchView,
  ThisCopy,
} from "../../services/deployment/deployIpc";
import { provisionOptions } from "../../services/deployment/deploymentService";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="deploy-dialog__fact">
      <span className="deploy-dialog__label">{label}</span>
      <span className="deploy-dialog__value" title={value}>
        {value}
      </span>
    </div>
  );
}

/** This computer and this copy: where the program, its data and its runtimes are. */
export function ThisComputer({ copy }: { copy: ThisCopy }) {
  return (
    <section className="deploy-dialog__section">
      <h3>{t("deploy.thisComputer")}</h3>
      <Fact label={t("deploy.fact.computer")} value={`${copy.hostname} · ${copy.user} · ${copy.osArch}`} />
      <Fact label={t("deploy.fact.identity")} value={copy.profileId} />
      <Fact label={t("deploy.fact.program")} value={`${copy.exe} (${copy.version}, ${copy.buildArch})`} />
      {copy.universalDir !== copy.installDir && <Fact label={t("deploy.fact.networkPath")} value={copy.universalDir} />}
      <Fact label={t("deploy.fact.layout")} value={t(`deploy.layout.${copy.layout}`)} />
      <Fact label={t("deploy.fact.data")} value={copy.dataRoot} />
      <Fact label={t("deploy.fact.database")} value={copy.dbPath} />
      <Fact
        label={t("deploy.fact.runtimes")}
        value={`${copy.runtimesDir} — ${t(`deploy.store.${copy.runtimeStore}`)}`}
      />
    </section>
  );
}

export function Offer({ offer }: { offer: OfferView }) {
  let text = t("deploy.offer.off");
  if (offer.error !== null) text = offer.error;
  else if (offer.on && offer.kind !== null)
    text = t("deploy.offer.on", {
      kind: t(`deploy.kind.${offer.kind}`),
      address: offer.discoveryAddress ?? "",
      packages: String(offer.packages.length),
      runtimes: String(offer.runtimes),
    });
  return (
    <section className="deploy-dialog__section">
      <h3>{t("deploy.offer.title")}</h3>
      <p className={offer.error === null ? "deploy-dialog__muted" : "deploy-dialog__error"}>{text}</p>
      {offer.problems.map((problem) => (
        <p key={problem} className="deploy-dialog__muted">
          {t("deploy.offer.leftOut", { problem })}
        </p>
      ))}
    </section>
  );
}

export function SearchSummary({ search }: { search: SearchView }) {
  const details = [...search.sendErrors, ...search.incompatible, ...(search.socketError ? [search.socketError] : [])];
  return (
    <div className={`deploy-dialog__search deploy-dialog__search--${search.outcome}`} role="status">
      <strong>{t(`deploy.outcome.${search.outcome}`)}</strong>{" "}
      {t("deploy.search.summary", { sent: String(search.sent), ms: String(search.elapsedMs) })}
      {details.map((line) => (
        <div key={line} className="deploy-dialog__muted">
          {line}
        </div>
      ))}
    </div>
  );
}

export function Deployment({
  deployment,
  busy,
  onProvision,
}: {
  deployment: DeploymentView;
  busy: boolean;
  onProvision: (kind: ProvisionKind) => void;
}) {
  const m = deployment.manifest;
  return (
    <li className="deploy-dialog__deployment">
      <div>
        <strong>{t(`deploy.kind.${m.kind}`)}</strong> — OpenMind Studio {m.appVersion} ({m.platform} {m.arch})
      </div>
      {m.sharePath !== undefined && <div className="deploy-dialog__muted">{m.sharePath}</div>}
      {m.packages.map((p) => (
        <div key={p.name} className="deploy-dialog__muted">
          {p.name} · {Math.round(p.size / 1048576)} MB
        </div>
      ))}
      {m.runtimes.length > 0 && (
        <div className="deploy-dialog__muted">
          {t("deploy.runtimesReady", { list: m.runtimes.map((r) => `${r.kind} ${r.version}`).join(", ") })}
        </div>
      )}
      <div className="deploy-dialog__muted">
        {t("deploy.sources", { list: deployment.sources.map((s) => s.address).join(", ") })}
      </div>
      {!deployment.trusted && <div className="deploy-dialog__muted">{t("deploy.trust.notYet")}</div>}
      {deployment.incompatible !== null && <div className="deploy-dialog__error">{deployment.incompatible}</div>}
      {deployment.manifestError !== null && <div className="deploy-dialog__error">{deployment.manifestError}</div>}
      <div className="deploy-dialog__actions">
        {provisionOptions(deployment).map((option) => (
          <button
            key={option.kind}
            type="button"
            disabled={busy || !option.available}
            title={option.reason === null ? t(`deploy.provision.${option.kind}.hint`) : t(option.reason)}
            onClick={() => {
              onProvision(option.kind);
            }}
          >
            {t(`deploy.provision.${option.kind}`)}
          </button>
        ))}
      </div>
    </li>
  );
}

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <table className="deploy-dialog__checks">
      <tbody>
        {checks.map((check) => (
          <tr key={check.id}>
            <td className={`deploy-dialog__status deploy-dialog__status--${check.status}`}>
              {t(`deploy.status.${check.status}`)}
            </td>
            <td>{t(`deploy.check.${check.id}`)}</td>
            <td className="deploy-dialog__detail">{check.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OutcomeView({ outcome, onLaunch }: { outcome: ProvisionOutcome; onLaunch: () => void }) {
  return (
    <section className="deploy-dialog__section" role="status">
      <h3>{t(`deploy.done.${outcome.action}`, { version: outcome.version })}</h3>
      <p>{outcome.program}</p>
      {outcome.steps.map((step) => (
        <p key={step} className="deploy-dialog__muted">
          {step}
        </p>
      ))}
      {outcome.shortcut !== null && <p className="deploy-dialog__muted">{outcome.shortcut}</p>}
      <p className="deploy-dialog__muted">{t("deploy.done.data", { path: outcome.dataLocation })}</p>
      <button type="button" onClick={onLaunch}>
        {t("deploy.launch")}
      </button>
    </section>
  );
}
