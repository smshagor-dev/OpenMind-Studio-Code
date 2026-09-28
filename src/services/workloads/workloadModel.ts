import { i18n, t } from "../../i18n";
import type {
  ComponentState,
  ComponentView,
  FrameworkView,
  Pack,
  Selection,
  Warning,
  Workload,
  WorkloadCatalog,
} from "./workloadsIpc";

/**
 * Pure helpers of the Workloads page: what is selected, toggling workloads/components/packs, which components get a
 * runtime card, sizes and the words for states and warnings. The catalog's own English text (names, notes,
 * summaries) is translated when the UI language has a key for it, and shown as is otherwise.
 */

export const EMPTY_SELECTION: Selection = { workloads: [], add: [], remove: [] };

/** `t(key)` when the catalog has the key, else `fallback` (catalog text comes from the backend in English). */
export function tr(key: string, fallback: string): string {
  return i18n.english(key) === undefined ? fallback : t(key);
}

export function componentName(c: Pick<ComponentView, "id" | "name">): string {
  return tr(`workloadComponent.${c.id}.name`, c.name);
}

/** Why a component isn't simply installable here, or a note about it. */
export function componentNote(c: ComponentView): string | null {
  const own = tr(`workloadComponent.${c.id}.note`, "");
  if (own) return own;
  if (c.state === "unsupportedArchitecture") return t("workloads.reason.unsupportedArchitecture");
  if (c.state === "planned" && c.provision.type === "runtime") return t("workloads.reason.noDownloadYet");
  if (c.provision.type === "project") return t("workloads.reason.project");
  if (c.provision.type === "lspBundled" && c.state === "manualInstall") return t("workloads.reason.noBundle");
  return c.reason;
}

export function workloadName(w: Workload): string {
  return tr(`workload.${w.id}.name`, w.name);
}

export function workloadSummary(w: Workload): string {
  return tr(`workload.${w.id}.summary`, w.summary);
}

export function packName(p: Pack): string {
  return tr(`workloadPack.${p.id}.name`, p.name);
}

export function stateLabel(state: ComponentState): string {
  return t(`workloads.state.${state}`);
}

export function sourceLabel(source: string): string {
  return tr(`workloads.source.${source}`, source);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 MB";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function inSelectedWorkload(selection: Selection, catalog: WorkloadCatalog, id: string): boolean {
  return catalog.workloads.some((w) => selection.workloads.includes(w.id) && w.components.includes(id));
}

/** Whether a component is part of the selection (from a workload or added), and not removed. */
export function isSelected(selection: Selection, catalog: WorkloadCatalog, id: string): boolean {
  if (selection.remove.includes(id)) return false;
  return selection.add.includes(id) || inSelectedWorkload(selection, catalog, id);
}

export function toggleWorkload(selection: Selection, id: string): Selection {
  const on = selection.workloads.includes(id);
  if (id === "minimal") return on ? EMPTY_SELECTION : { workloads: ["minimal"], add: [], remove: [] };
  const workloads = on
    ? selection.workloads.filter((w) => w !== id)
    : [...selection.workloads.filter((w) => w !== "minimal"), id];
  return { ...selection, workloads };
}

export function toggleComponent(selection: Selection, catalog: WorkloadCatalog, id: string): Selection {
  const without = (list: string[]) => list.filter((x) => x !== id);
  if (isSelected(selection, catalog, id)) {
    return inSelectedWorkload(selection, catalog, id)
      ? { ...selection, add: without(selection.add), remove: [...selection.remove, id] }
      : { ...selection, add: without(selection.add) };
  }
  const remove = without(selection.remove);
  const add = inSelectedWorkload({ ...selection, remove }, catalog, id) ? selection.add : [...selection.add, id];
  return { workloads: selection.workloads.filter((w) => w !== "minimal"), add, remove };
}

/** Selects every component of a pack, or deselects them all when they are all selected already. */
export function togglePack(selection: Selection, catalog: WorkloadCatalog, pack: Pack): Selection {
  const all = pack.components.every((id) => isSelected(selection, catalog, id));
  return pack.components.reduce(
    (current, id) => (isSelected(current, catalog, id) === all ? toggleComponent(current, catalog, id) : current),
    selection,
  );
}

export interface PackState {
  installed: number;
  total: number;
  installable: number;
}

export function packState(pack: Pack, catalog: WorkloadCatalog): PackState {
  const members = pack.components
    .map((id) => catalog.components.find((c) => c.id === id))
    .filter((c): c is ComponentView => c !== undefined);
  return {
    installed: members.filter((c) => c.state === "installed").length,
    total: members.length,
    installable: members.filter((c) => c.state === "available" || c.state === "heavySdk").length,
  };
}

/** The components shown as runtime cards: runtimes, SDKs and system tools (not language servers or project tools). */
export function runtimeCards(catalog: WorkloadCatalog): ComponentView[] {
  const provisions = new Set(["runtime", "includedWith", "external", "planned"]);
  const hidden = new Set(["languageServer", "framework", "formatter", "linter"]);
  return catalog.components.filter((c) => provisions.has(c.provision.type) && !hidden.has(c.category));
}

export function selectedCount(selection: Selection, catalog: WorkloadCatalog): number {
  return catalog.components.filter((c) => isSelected(selection, catalog, c.id)).length;
}

export function warningText(warning: Warning, catalog: WorkloadCatalog): string {
  const name = (id: string) => {
    const c = catalog.components.find((x) => x.id === id);
    return c ? componentName(c) : id;
  };
  return t(`workloads.warning.${warning.kind}`, {
    name: name(warning.component),
    neededBy: warning.neededBy ? name(warning.neededBy) : "",
  });
}

/** Ready, or what a framework's projects still need (Flutter has its own sentence). */
export function frameworkMessage(f: FrameworkView, catalog: WorkloadCatalog): string {
  if (f.missing.length === 0) return t("workloads.framework.ready");
  if (f.missing.includes("flutter")) return t("workloads.framework.flutterMissing");
  const names = f.missing
    .map((id) => catalog.components.find((c) => c.id === id))
    .filter((c): c is ComponentView => c !== undefined)
    .map(componentName)
    .join(", ");
  return t("workloads.framework.needs", { names });
}

/** Why a card's Install button is disabled (or `null` when it can install). */
export function installBlocker(c: ComponentView): string | null {
  if (c.state === "installed") return t("workloads.reason.alreadyInstalled");
  if (c.state === "available" || c.state === "heavySdk") return null;
  return componentNote(c) ?? stateLabel(c.state);
}
