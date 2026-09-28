import { container } from "../services/container";
import type { MarketSort } from "../services/marketplaceIpc";
import type { InstalledExtension } from "../services/extensionsIpc";
import type { PopupItem } from "./MenuPopup";
import { t } from "../i18n";

const SORTS: readonly { sort: MarketSort; label: string }[] = [
  { sort: "relevance", label: "extensions.sort.relevance" },
  { sort: "installs", label: "extensions.sort.installs" },
  { sort: "rating", label: "extensions.sort.rating" },
  { sort: "updated", label: "extensions.sort.updated" },
];

/** The filter button's menu: VS Code's "Sort By" choices for the marketplace list. */
export function sortMenu(): PopupItem[] {
  const marketplace = container.extensions.marketplace;
  const current = marketplace.getState().sort;
  return [
    {
      kind: "submenu",
      label: t("extensions.sortBy"),
      items: SORTS.map(({ sort, label }) => ({
        kind: "item",
        label: t(label),
        enabled: true,
        checked: current === sort,
        onSelect: () => void marketplace.setSort(sort),
      })),
    },
    {
      kind: "item",
      label: t("extensions.showInstalled"),
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
      label: t("extensions.installVsix"),
      enabled: install.enabled,
      reason: install.reason,
      onSelect: () => void service.chooseVsix(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: t("common.refresh"),
      enabled: true,
      onSelect: () => void marketplace.refresh(),
    },
    {
      kind: "item",
      label: t("extensions.checkExtensionUpdates"),
      enabled: !marketplace.getState().checkingUpdates,
      reason: t("extensions.alreadyChecking"),
      onSelect: () => void marketplace.checkUpdates(),
    },
    {
      kind: "item",
      label: t("extensions.restartHost"),
      enabled: reload.enabled,
      reason: reload.reason,
      onSelect: () => void service.reloadHost(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: t("extensions.showHostLog"),
      enabled: true,
      onSelect: () => void service.showLogs(),
    },
    {
      kind: "item",
      label: t("extensions.openFolder"),
      enabled: root !== null,
      reason: t("extensions.notLoaded"),
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
      label: extension.enabled ? t("extensions.disable") : t("extensions.enable"),
      enabled: toggle.enabled,
      reason: toggle.reason,
      onSelect: () => void service.setEnabled(extension.id, !extension.enabled),
    },
    {
      kind: "item",
      label: t("extensions.uninstall.confirm"),
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
      label: t("extensions.copyId"),
      enabled: true,
      onSelect: () => void container.ipc.clipboardWriteText(extension.id),
    },
    {
      kind: "item",
      label: t("extensions.openExtensionFolder"),
      enabled: true,
      onSelect: () => {
        service.openFolder(extension.id);
      },
    },
  ];
}
