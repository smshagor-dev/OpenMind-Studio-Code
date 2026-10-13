import { useSyncExternalStore } from "react";

import { t, useT } from "../../i18n";
import { container } from "../../services/container";
import { deployment } from "../../services/deployment";
import type { ProvisionKind } from "../../services/deployment/deployIpc";
import { destinationFor } from "../../services/deployment/deploymentService";
import { Checks, Deployment, Offer, OutcomeView, SearchSummary, ThisComputer } from "./DeploymentParts";

async function provision(id: string, kind: ProvisionKind): Promise<void> {
  if (kind === "share") {
    await deployment.provision(id, kind, null);
    return;
  }
  // Any folder on any drive the user chooses; the copy goes into an "OpenMind Studio" folder inside it.
  const folder = await container.ipc.openFolderDialog();
  if (folder === null) return;
  await deployment.provision(id, kind, destinationFor(folder));
}

/** Help > Network Deployment (see `services/deployment`). */
export function NetworkDeploymentDialog() {
  useT();
  const state = useSyncExternalStore(deployment.subscribe, deployment.getState);
  if (!state.open) return null;
  const { status, busy } = state;
  const working = busy !== null;
  return (
    <div className="modal-overlay" onClick={() => { deployment.closeDialog(); }}>
      <div
        className="modal deploy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-dialog-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="deploy-dialog-title">{t("deploy.title")}</h2>
        <p className="deploy-dialog__muted">{t("deploy.intro")}</p>
        {status !== null && <ThisComputer copy={status.copy} />}
        {status !== null && <Offer offer={status.offer} />}
        <section className="deploy-dialog__section">
          <h3>{t("deploy.find.title")}</h3>
          <label className="deploy-dialog__field">
            {t("deploy.find.targets")}
            <input
              type="text"
              value={state.targets}
              placeholder="10.0.0.5, lab-server"
              onChange={(event) => {
                deployment.setTargets(event.target.value);
              }}
            />
          </label>
          <div className="deploy-dialog__actions">
            <button type="button" disabled={working} onClick={() => void deployment.search()}>
              {busy === "search" ? t("deploy.find.searching") : t("deploy.find.search")}
            </button>
          </div>
          {state.search !== null && <SearchSummary search={state.search} />}
          <ul className="deploy-dialog__deployments">
            {(status?.deployments ?? []).map((d) => (
              <Deployment key={d.id} deployment={d} busy={working} onProvision={(kind) => void provision(d.id, kind)} />
            ))}
          </ul>
          {busy === "provision" && <p role="status">{t("deploy.provisioning")}</p>}
        </section>
        {state.outcome !== null && (
          <OutcomeView
            outcome={state.outcome}
            onLaunch={() => {
              if (state.outcome !== null) void deployment.launch(state.outcome.program);
            }}
          />
        )}
        <section className="deploy-dialog__section">
          <h3>{t("deploy.test.title")}</h3>
          <label className="deploy-dialog__check">
            <input
              type="checkbox"
              checked={state.downloadPackage}
              onChange={(event) => {
                deployment.setDownloadPackage(event.target.checked);
              }}
            />
            {t("deploy.test.download")}
          </label>
          <div className="deploy-dialog__actions">
            <button type="button" className="deploy-dialog__primary" disabled={working} onClick={() => void deployment.runTest()}>
              {busy === "test" ? t("deploy.test.running") : t("deploy.test.run")}
            </button>
          </div>
          {state.report !== null && (
            <>
              <p>
                {t("deploy.test.summary", {
                  passed: String(state.report.passed),
                  failed: String(state.report.failed),
                  blocked: String(state.report.blocked),
                })}
              </p>
              <Checks checks={state.report.checks} />
            </>
          )}
        </section>
        {state.error !== null && (
          <p className="deploy-dialog__error" role="alert">
            {state.error}
          </p>
        )}
        <div className="deploy-dialog__actions">
          <button type="button" onClick={() => { deployment.closeDialog(); }}>
            {t("deploy.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
