import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import { displayName } from "../services/extensionModel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExtensionInstallDialog } from "./ExtensionInstallDialog";
import { t } from "../i18n";

/**
 * The extension trust (install) and uninstall confirmations. Mounted once by
 * the workbench, so Install from the marketplace, the extension page or a
 * .vsix asks the same way whichever side bar view is open.
 */
export function ExtensionDialogs() {
  const { service, registry } = container.extensions;
  const ui = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getState(),
  );
  const pendingUninstall =
    ui.pendingUninstall === null ? undefined : registry.find(ui.pendingUninstall);
  const pendingGrant = ui.pendingGrant === null ? undefined : registry.find(ui.pendingGrant);
  const pendingRunAnyway = ui.pendingRunAnyway === null ? undefined : registry.find(ui.pendingRunAnyway);
  return (
    <>
      {pendingGrant && ui.pendingGrantPermission === "filesystemOutsideWorkspace" ? (
        <ConfirmDialog
          title={t("extensions.grant.title")}
          message={t("extensions.grant.message", { name: displayName(pendingGrant) })}
          confirmLabel={t("extensions.grant.confirm")}
          onConfirm={() => {
            void service.confirmGrant();
          }}
          onCancel={() => {
            service.cancelGrant();
          }}
        />
      ) : null}
      {pendingGrant && ui.pendingGrantPermission !== "filesystemOutsideWorkspace" ? (
        <ConfirmDialog
          title={t("extensions.grantAny.title", { permission: t(`permission.${ui.pendingGrantPermission}.label`) })}
          message={t("extensions.grantAny.message", {
            name: displayName(pendingGrant),
            permission: t(`permission.${ui.pendingGrantPermission}.label`),
            description: t(`permission.${ui.pendingGrantPermission}.description`),
          })}
          confirmLabel={t("extensions.grantAny.confirm")}
          onConfirm={() => {
            void service.confirmGrant();
          }}
          onCancel={() => {
            service.cancelGrant();
          }}
        />
      ) : null}
      {pendingRunAnyway ? (
        <ConfirmDialog
          title={t("extensions.runAnyway.title")}
          message={t("extensions.runAnyway.message", {
            name: displayName(pendingRunAnyway),
            engine: pendingRunAnyway.manifest.enginesVscode ?? "?",
          })}
          confirmLabel={t("extensions.runAnyway.confirm")}
          onConfirm={() => {
            void service.confirmRunAnyway();
          }}
          onCancel={() => {
            service.cancelRunAnyway();
          }}
        />
      ) : null}
      {ui.pendingInstall ? <ExtensionInstallDialog pending={ui.pendingInstall} /> : null}
      {pendingUninstall ? (
        <ConfirmDialog
          title={t("extensions.uninstall.title")}
          message={t("extensions.uninstall.message", { name: displayName(pendingUninstall) })}
          confirmLabel={t("extensions.uninstall.confirm")}
          onConfirm={() => {
            void service.confirmUninstall();
          }}
          onCancel={() => {
            service.cancelUninstall();
          }}
        />
      ) : null}
    </>
  );
}
