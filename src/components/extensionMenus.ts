import { container } from "../services/container";
import type { MarketSort } from "../services/marketplaceIpc";
import type { InstalledExtension, PermissionName } from "../services/extensionsIpc";
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

/** "Run Anyway…" / "Stop Running Anyway" for an extension whose VS Code engine is newer than OpenMind's subset. */
function runAnywayItems(extension: InstalledExtension): PopupItem[] {
  if (extension.engineSupported) return [];
  const { service } = container.extensions;
  return [
    extension.runAnyway
      ? {
          kind: "item",
          label: t("extensions.runAnyway.stop"),
          enabled: true,
          onSelect: () => void service.stopRunningAnyway(extension.id),
        }
      : {
          kind: "item",
          label: t("extensions.runAnyway.menu"),
          enabled: extension.enabled,
          reason: t("extensions.runAnyway.enableFirst"),
          onSelect: () => {
            service.requestRunAnyway(extension.id);
          },
        },
  ];
}

/** An installed extension's gear menu; `refused`: a permission the guard refused it (offered as a grant). */
export function manageMenu(extension: InstalledExtension, refused: PermissionName | null = null): PopupItem[] {
  const { service } = container.extensions;
  const toggle = service.toggleAvailability(extension);
  const grant: PopupItem[] =
    refused === null
      ? []
      : [
          {
            kind: "item",
            label: t("extensions.grantAny.menu", { permission: t(`permission.${refused}.label`) }),
            enabled: true,
            onSelect: () => {
              service.requestGrant(extension.id, refused);
            },
          },
        ];
  return [
    ...grant,
    {
      kind: "item",
      label: extension.enabled ? t("extensions.disable") : t("extensions.enable"),
      enabled: toggle.enabled,
      reason: toggle.reason,
      onSelect: () => void service.setEnabled(extension.id, !extension.enabled),
    },
    ...runAnywayItems(extension),
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
