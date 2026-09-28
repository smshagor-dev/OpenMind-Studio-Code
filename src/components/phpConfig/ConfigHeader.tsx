import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import {
  composerChip,
  mariaDbChip,
  phpChip,
  phpMyAdminChip,
  type Chip,
} from "../../services/phpConfigModel";
import { Card, Facts, StatusChip } from "./parts";
import { t } from "../../i18n";

function useStack() {
  useSyncExternalStore(
    (listener) => container.php.subscribe(listener),
    () => container.php.getState(),
  );
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  useSyncExternalStore(
    (listener) => container.mariaDb.subscribe(listener),
    () => container.mariaDb.getState(),
  );
  useSyncExternalStore(
    (listener) => container.phpMyAdmin.subscribe(listener),
    () => container.phpMyAdmin.getState(),
  );
  const cards = container.phpRuntime.cards();
  const php = cards.find((card) => card.id === "php");
  const composer = cards.find((card) => card.id === "composer");
  return { php, composer };
}

/** The four status chips shown under the page title. A chip is left out when its data isn't known. */
function useStackChips(): Chip[] {
  const { php, composer } = useStack();
  const chips: Chip[] = [];
  if (php) {
    chips.push(
      phpChip({
        installed: php.installed,
        active: php.activeVersion,
        healthy: php.installedVersions.every((version) => version.healthy),
      }),
    );
  }
  if (composer) {
    chips.push(composerChip({ installed: composer.installed, active: composer.activeVersion }));
  }
  chips.push(mariaDbChip(container.mariaDb.status()));
  chips.push(
    phpMyAdminChip({
      installed: container.phpMyAdmin.installedVersion() !== null,
      running: container.phpMyAdmin.getState().server !== null,
    }),
  );
  return chips;
}

/** Title-row chips for the Configuration page. */
export function ConfigChips() {
  const chips = useStackChips();
  return (
    <div className="pcfg-chips" role="list" aria-label={t("php.stackStatus")}>
      {chips.map((chip) => (
        <span key={chip.label} role="listitem">
          <StatusChip chip={chip} />
        </span>
      ))}
    </div>
  );
}

/** A compact summary of the whole stack: versions, statuses, the web root and the addresses. */
export function StackSummary() {
  const { php, composer } = useStack();
  const state = container.php.getState();
  const db = container.mariaDb;
  const pma = container.phpMyAdmin;
  const dbInstalled = db.installed();
  return (
    <Card title={t("php.stackSummary")} label={t("php.stackSummary")}>
      <Facts
        rows={[
          {
            label: "PHP",
            value:
              php?.activeVersion ?? (php?.installed ? t("runtimes.installed") : t("runtimes.notInstalled")),
          },
          {
            label: "Composer",
            value:
              composer?.activeVersion ??
              (composer?.installed ? t("runtimes.installed") : t("runtimes.notInstalled")),
          },
          {
            label: "MariaDB",
            value: dbInstalled
              ? `${dbInstalled.version} — ${db.getState().server ? t("php.status.running") : t("php.status.stopped")}`
              : t("runtimes.notInstalled"),
          },
          {
            label: "phpMyAdmin",
            value:
              pma.installedVersion() === null
                ? t("runtimes.notInstalled")
                : pma.getState().server
                  ? t("php.status.running")
                  : t("php.available"),
          },
          {
            label: t("php.webRoot"),
            value: (
              <code className="pcfg-inline-path" title={state.root ?? undefined}>
                {state.root ?? t("php.notSet")}
              </code>
            ),
          },
          { label: t("php.phpServer"), value: state.server?.url ?? t("php.status.stopped") },
          { label: t("php.pmaUrl"), value: pma.url() ?? t("php.noneUntilRuns") },
        ]}
      />
    </Card>
  );
}
