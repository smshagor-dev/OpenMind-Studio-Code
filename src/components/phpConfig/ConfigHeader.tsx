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
    <div className="pcfg-chips" role="list" aria-label="Stack status">
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
    <Card title="Stack Summary" label="Stack Summary">
      <Facts
        rows={[
          {
            label: "PHP",
            value: php?.activeVersion ?? (php?.installed ? "Installed" : "Not installed"),
          },
          {
            label: "Composer",
            value: composer?.activeVersion ?? (composer?.installed ? "Installed" : "Not installed"),
          },
          {
            label: "MariaDB",
            value: dbInstalled
              ? `${dbInstalled.version} — ${db.getState().server ? "Running" : "Stopped"}`
              : "Not installed",
          },
          {
            label: "phpMyAdmin",
            value:
              pma.installedVersion() === null
                ? "Not installed"
                : pma.getState().server
                  ? "Running"
                  : "Available",
          },
          {
            label: "Web root",
            value: (
              <code className="pcfg-inline-path" title={state.root ?? undefined}>
                {state.root ?? "Not set"}
              </code>
            ),
          },
          { label: "PHP server", value: state.server?.url ?? "Stopped" },
          { label: "phpMyAdmin URL", value: pma.url() ?? "None until it runs" },
        ]}
      />
    </Card>
  );
}
