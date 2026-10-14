// The Network Deployment service of this window (kept out of container.ts, which is at its size limit).
// `startDeployment` only registers the command and follows the "offer on the local network" setting: nothing is
// searched or sent at start-up — a search runs only when the user asks in the dialog.
import { container } from "../container";
import { tauriDeployIpc, type DeployIpc } from "./deployIpc";
import { DeploymentService } from "./deploymentService";

export const OFFER_SETTING = "deployment.advertiseOnLan";
export const OPEN_COMMAND = "help.networkDeployment";

export function createDeployment(ipc: DeployIpc = tauriDeployIpc): DeploymentService {
  return new DeploymentService(ipc);
}

export const deployment = createDeployment();

let unfollow: (() => void) | null = null;

/** Registers Help > Network Deployment and applies the offer setting when it changes (every editor window). */
export async function startDeployment(service: DeploymentService = deployment): Promise<void> {
  const { commands, settings } = container;
  if (!commands.has(OPEN_COMMAND)) {
    commands.register(OPEN_COMMAND, () => service.openDialog());
  }
  unfollow?.();
  unfollow = settings.onChange([OFFER_SETTING], () => {
    void service.applyOffering();
  });
  await Promise.resolve();
}
