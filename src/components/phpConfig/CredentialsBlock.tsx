import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { DB_USER, LOCAL_HOST, MASKED_PASSWORD } from "../../services/phpConfigModel";
import { StackButton } from "../PhpStackSections";

/**
 * The connection details for MariaDB: host, port, user and the password — masked until the user clicks Reveal.
 * The password is fetched (decrypted) only on that click or a Copy, is never printed to a log and is not part of
 * anything an extension or the AI panel can read.
 */
export function CredentialsBlock() {
  useSyncExternalStore(
    (listener) => container.mariaDb.subscribe(listener),
    () => container.mariaDb.getState(),
  );
  const db = container.mariaDb;
  const state = db.getState();
  const revealed = state.passwordVisible && state.password !== null;
  const usable = db.installed() !== null;
  return (
    <div className="pcfg-credentials" role="group" aria-label="Connection details">
      <h4>Connection</h4>
      <dl className="pcfg-facts">
        <div className="pcfg-facts__row">
          <dt>Host</dt>
          <dd>{LOCAL_HOST}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>Port</dt>
          <dd>{state.port}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>User</dt>
          <dd>{DB_USER}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>Password</dt>
          <dd>
            {revealed ? (
              <code className="php-view__secret">{state.password}</code>
            ) : state.hasPassword ? (
              <span aria-label="Password hidden">{MASKED_PASSWORD}</span>
            ) : (
              <span className="pcfg-muted">Not set yet</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="php-view__row">
        <StackButton
          label={state.passwordVisible ? "Hide Password" : "Reveal Password"}
          availability={db.passwordState()}
          onClick={() => {
            void db.togglePassword();
          }}
        />
        <StackButton
          label="Copy Password"
          availability={db.passwordState()}
          onClick={() => {
            void db.copyPassword();
          }}
        />
        <StackButton
          label="Copy Connection String"
          availability={
            usable ? { enabled: true } : { enabled: false, reason: "Install MariaDB first." }
          }
          onClick={() => {
            void db.copyConnectionString();
          }}
        />
      </div>
      <p className="pcfg-muted">
        {db.passwordStatusLabel()}. The connection string has no password in it.
      </p>
    </div>
  );
}
