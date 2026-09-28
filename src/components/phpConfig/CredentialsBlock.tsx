import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { DB_USER, LOCAL_HOST, MASKED_PASSWORD } from "../../services/phpConfigModel";
import { StackButton } from "../PhpStackSections";
import { t } from "../../i18n";

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
    <div className="pcfg-credentials" role="group" aria-label={t("php.connectionDetails")}>
      <h4>{t("php.connection")}</h4>
      <dl className="pcfg-facts">
        <div className="pcfg-facts__row">
          <dt>{t("php.host")}</dt>
          <dd>{LOCAL_HOST}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>{t("php.col.port")}</dt>
          <dd>{state.port}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>{t("php.user")}</dt>
          <dd>{DB_USER}</dd>
        </div>
        <div className="pcfg-facts__row">
          <dt>{t("php.password")}</dt>
          <dd>
            {revealed ? (
              <code className="php-view__secret">{state.password}</code>
            ) : state.hasPassword ? (
              <span aria-label={t("php.passwordHidden")}>{MASKED_PASSWORD}</span>
            ) : (
              <span className="pcfg-muted">{t("php.notSetYet")}</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="php-view__row">
        <StackButton
          label={state.passwordVisible ? t("php.hidePassword") : t("php.revealPassword")}
          availability={db.passwordState()}
          onClick={() => {
            void db.togglePassword();
          }}
        />
        <StackButton
          label={t("php.copyPassword")}
          availability={db.passwordState()}
          onClick={() => {
            void db.copyPassword();
          }}
        />
        <StackButton
          label={t("php.copyConnection")}
          availability={
            usable ? { enabled: true } : { enabled: false, reason: t("php.installMariaDbFirst") }
          }
          onClick={() => {
            void db.copyConnectionString();
          }}
        />
      </div>
      <p className="pcfg-muted">
        {db.passwordStatusLabel()}. {t("php.noPasswordInString")}
      </p>
    </div>
  );
}
