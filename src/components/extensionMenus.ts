import { container } from "../services/container";
import type { MarketSort } from "../services/marketplaceIpc";
import type { InstalledExtension } from "../services/extensionsIpc";
import type { PopupItem } from "./MenuPopup";

const SORTS: readonly { sort: MarketSort; label: string }[] = [
  { sort: "relevance", label: "Relevance" },
  { sort: "installs", label: "Install Count" },
  { sort: "rating", label: "Rating" },
  { sort: "updated", label: "Updated Date" },
];

/** The filter button's menu: VS Code's "Sort By" choices for the marketplace list. */
export function sortMenu(): PopupItem[] {
  const marketplace = container.extensions.marketplace;
  const current = marketplace.getState().sort;
  return [
    {
      kind: "submenu",
      label: "Sort By",
      items: SORTS.map(({ sort, label }) => ({
        kind: "item",
        label,
        enabled: true,
        checked: current === sort,
        onSelect: () => void marketplace.setSort(sort),
      })),
    },
    {
      kind: "item",
      label: "Show Installed Extensions",
      enabled: true,
      onSelect: () => {
        marketplace.setQuery("@installed");
      },
    },
  ];
}

/** The view's "…" menu: the actions VS Code keeps there. */
export function moreActionsMenu(): PopupItem[] {
  const { service, marketplace, registry } = container.extensions;
  const install = service.installAvailability();
  const reload = service.reloadAvailability();
  const root = registry.getState().snapshot?.root ?? null;
  return [
    {
      kind: "item",
      label: "Install from VSIX...",
      enabled: install.enabled,
      reason: install.reason,
      onSelect: () => void service.chooseVsix(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Refresh",
      enabled: true,
      onSelect: () => void marketplace.refresh(),
    },
    {
      kind: "item",
      label: "Check for Extension Updates",
      enabled: !marketplace.getState().checkingUpdates,
      reason: "Already checking.",
      onSelect: () => void marketplace.checkUpdates(),
    },
    {
      kind: "item",
      label: "Restart Extension Host",
      enabled: reload.enabled,
      reason: reload.reason,
      onSelect: () => void service.reloadHost(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Show Extension Host Log",
      enabled: true,
      onSelect: () => void service.showLogs(),
    },
    {
      kind: "item",
      label: "Open Extensions Folder",
      enabled: root !== null,
      reason: "Extensions aren't loaded yet.",
      onSelect: () => {
        if (root !== null) void container.ipc.panelOpenFolder(root);
      },
    },
  ];
}

/** An installed extension's gear menu. */
export function manageMenu(extension: InstalledExtension): PopupItem[] {
  const { service } = container.extensions;
  const toggle = service.toggleAvailability(extension);
  return [
    {
      kind: "item",
      label: extension.enabled ? "Disable" : "Enable",
      enabled: toggle.enabled,
      reason: toggle.reason,
      onSelect: () => void service.setEnabled(extension.id, !extension.enabled),
    },
    {
      kind: "item",
      label: "Uninstall",
      enabled: toggle.enabled,
      reason: toggle.reason,
      danger: true,
      onSelect: () => {
        service.requestUninstall(extension.id);
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Copy Extension ID",
      enabled: true,
      onSelect: () => void container.ipc.clipboardWriteText(extension.id),
    },
    {
      kind: "item",
      label: "Open Extension Folder",
      enabled: true,
      onSelect: () => {
        service.openFolder(extension.id);
      },
    },
  ];
}
