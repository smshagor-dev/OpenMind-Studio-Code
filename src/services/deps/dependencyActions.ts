import { t } from "../../i18n";
import type { ConfirmPrompt } from "../extensionPromptService";
import type { TerminalService } from "../terminalService";
import type { DepsIpc, DepsPlan, DepsRequest, Network } from "./depsIpc";

export interface DependencyActionsHost {
  ipc: Pick<DepsIpc, "depsPlan" | "depsRun">;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  terminals: Pick<TerminalService, "createTaskTerminal" | "waitForExit">;
  notice: (message: string) => void;
  error: (message: string) => void;
  /** After an operation ended, whatever its outcome (the view reads the project again). */
  changed?: () => void;
}

export type ActionOutcome =
  | { status: "done" }
  | { status: "failed"; code: number | null }
  | { status: "cancelled" }
  | { status: "refused"; reason: string };

/** The confirmation's button for an action. */
function verb(action: string): string {
  if (action === "install" || action === "add") return t("deps.run.install");
  if (action === "remove") return t("deps.run.remove");
  if (action === "update") return t("deps.run.update");
  if (action === "create environment") return t("deps.run.create");
  return t("deps.run.run");
}

function networkText(network: Network): string {
  return t(`deps.network.${network}`);
}

/** The labelled lines of the confirmation: nothing about the command is hidden. */
export function confirmationDetails(plan: DepsPlan): { label: string; value: string }[] {
  return [
    ...(plan.packages.length > 0 ? [{ label: t("deps.confirm.packages"), value: plan.packages.join(", ") }] : []),
    { label: t("deps.confirm.action"), value: plan.action },
    { label: t("deps.confirm.manager"), value: plan.manager },
    { label: t("deps.confirm.executable"), value: `${plan.program} (${plan.source})` },
    { label: t("deps.confirm.command"), value: plan.command },
    { label: t("deps.confirm.folder"), value: plan.cwd },
    { label: t("deps.confirm.into"), value: plan.target },
    { label: t("deps.confirm.network"), value: networkText(plan.network) },
  ];
}

/**
 * The one way OpenMind changes a project's packages or runs its tools, for the Dependencies view and the missing-package
 * card alike: the backend plans the operation, the user sees every detail and confirms, then the backend plans it again
 * and starts the program as a new terminal's own process — so what the terminal shows is the program's output and the
 * outcome reported is its real exit code. Nothing runs without the confirmation.
 */
export class DependencyActions {
  constructor(private readonly host: DependencyActionsHost) {}

  /** Asks for the plan only (the view shows why an action is unavailable). */
  async plan(request: DepsRequest): Promise<DepsPlan | string> {
    try {
      return await this.host.ipc.depsPlan(request);
    } catch (error) {
      return String(error);
    }
  }

  async perform(request: DepsRequest, requestedBy: string): Promise<ActionOutcome> {
    const plan = await this.plan(request);
    if (typeof plan === "string") {
      this.host.error(plan);
      return { status: "refused", reason: plan };
    }
    const button = verb(plan.action);
    const answer = await this.host.confirm({
      extension: requestedBy,
      title: t("deps.run.title", { manager: plan.manager, action: plan.action }),
      details: confirmationDetails(plan),
      notes: [...plan.notes, t("deps.run.note")],
      buttons: [button],
    });
    if (answer === null) return { status: "cancelled" };
    const label = `${plan.manager} ${plan.action}`;
    const terminal = await this.host.terminals.createTaskTerminal(
      label,
      (cols, rows) => this.host.ipc.depsRun(request, cols, rows),
      true,
    );
    if (terminal === null) {
      this.host.changed?.();
      return { status: "failed", code: null };
    }
    const code = await this.host.terminals.waitForExit(terminal);
    this.host.changed?.();
    if (code === 0) {
      this.host.notice(t("deps.run.done", { what: label }));
      return { status: "done" };
    }
    this.host.error(
      code === null ? t("deps.run.stopped", { what: label }) : t("deps.run.failed", { what: label, code }),
    );
    return { status: "failed", code };
  }
}
