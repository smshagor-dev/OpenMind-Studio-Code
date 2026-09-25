import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import { displayName } from "../services/extensionModel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExtensionInstallDialog } from "./ExtensionInstallDialog";

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
  return (
    <>
      {ui.pendingInstall ? <ExtensionInstallDialog pending={ui.pendingInstall} /> : null}
      {pendingUninstall ? (
        <ConfirmDialog
          title="Uninstall Extension"
          message={`Uninstall ${displayName(pendingUninstall)}? Its files are deleted from the extensions folder.`}
          confirmLabel="Uninstall"
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
