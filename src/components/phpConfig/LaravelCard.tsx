import { useEffect, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { laravelCommands } from "../../services/phpConfigModel";
import { StackButton } from "../PhpStackSections";
import { Card } from "./parts";

/**
 * Shown only when the Composer project folder is a Laravel project (composer.json requires laravel/framework and an
 * artisan file exists). It copies what the project needs — DB settings, commands — and never writes a `.env` or runs
 * anything itself.
 */
export function LaravelCard() {
  useSyncExternalStore(
    (listener) => container.composer.subscribe(listener),
    () => container.composer.getState(),
  );
  useSyncExternalStore(
    (listener) => container.mariaDb.subscribe(listener),
    () => container.mariaDb.getState(),
  );
  useSyncExternalStore(
    (listener) => container.phpMyAdmin.subscribe(listener),
    () => container.phpMyAdmin.getState(),
  );
  useSyncExternalStore(
    (listener) => container.php.subscribe(listener),
    () => container.php.getState(),
  );
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  const composer = container.composer.getState();
  const project = composer.project;
  useEffect(() => {
    if (composer.projectRoot !== null && project === null) {
      void container.composer.refreshProject();
    }
  }, [composer.projectRoot, project]);
  if (!project?.isLaravel) return null;

  const db = container.mariaDb;
  const cards = container.phpRuntime.cards();
  const phpCard = cards.find((card) => card.id === "php");
  const composerCard = cards.find((card) => card.id === "composer");
  const commands = laravelCommands({
    isLaravel: true,
    hasVendor: project.hasVendor === true,
    hasEnv: project.hasEnv === true,
    npmScripts: project.npmScripts ?? [],
  });
  return (
    <Card
      title="Laravel"
      label="Laravel"
      chip={{ label: "Laravel project", tone: "info" }}
      description="Helpers for the project selected under Composer."
    >
      <dl className="pcfg-facts">
        <div className="pcfg-facts__row">
          <dt>PHP</dt>
          <dd>{phpCard?.activeVersion ?? "Not installed"}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>Composer</dt>
          <dd>{composerCard?.activeVersion ?? "Not installed"}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>MariaDB</dt>
          <dd>{db.status() === "running" ? "Running" : "Not running"}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>.env</dt>
          <dd>
            {project.hasEnv === true
              ? "Found (never edited by OpenMind)"
              : "Not found — copy .env.example"}
          </dd>
        </div>
      </dl>
      <div className="php-view__row">
        <StackButton
          label="Copy DB Credentials for .env"
          availability={db.passwordState()}
          onClick={() => {
            void db.copyEnvBlock();
          }}
        />
        <StackButton
          label="Open phpMyAdmin"
          availability={container.phpMyAdmin.openState()}
          onClick={() => {
            void container.phpMyAdmin.open();
          }}
        />
      </div>
      <ul className="pcfg-commands" aria-label="Laravel commands">
        {commands.map((line) => (
          <li key={line.id}>
            <span>{line.label}</span>
            <code>{line.command}</code>
            <button
              type="button"
              className="php-view__button php-view__button--small"
              aria-label={`Copy ${line.command}`}
              onClick={() => {
                void container.ipc.clipboardWriteText(line.command);
              }}
            >
              Copy
            </button>
          </li>
        ))}
      </ul>
      <p className="pcfg-muted">
        Run these in a terminal inside the project. OpenMind copies the database settings for you to
        paste; it never edits or overwrites your .env.
      </p>
    </Card>
  );
}
