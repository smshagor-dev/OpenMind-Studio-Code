import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { Availability } from "../services/runtimeService";
import type { CardView, VersionView } from "../services/phpRuntimeService";

function usePhpRuntime() {
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  useSyncExternalStore(
    (listener) => container.php.subscribe(listener),
    () => container.php.getState(),
  );
  return container.phpRuntime;
}

/** Reasons worth printing: "already installed / already active / intact" are just state, not obstacles. */
function visibleReason(availability: Availability): string | null {
  if (availability.enabled || !availability.reason) return null;
  return /already|nothing to repair|intact/i.test(availability.reason) ? null : availability.reason;
}

function ActionButton(props: {
  label: string;
  availability: Availability;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        props.primary === true ? "ext-view__button ext-view__button--primary" : "ext-view__button"
      }
      disabled={!props.availability.enabled}
      title={props.availability.enabled ? props.label : props.availability.reason}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function VersionRow({ card, version }: { card: CardView; version: VersionView }) {
  const ext = usePhpRuntime();
  const reasons = version.installed
    ? [visibleReason(version.remove), visibleReason(version.repair)]
    : [visibleReason(version.install)];
  const shown = reasons.find((reason) => reason !== null) ?? null;
  const badge = !version.installed
    ? "available"
    : !version.healthy
      ? "needs repair"
      : version.active
        ? "active"
        : "installed";
  const name = `${card.name} ${version.version}`;
  return (
    <li className="ext-view__version">
      <div className="ext-view__version-head">
        <strong>{version.version}</strong>
        <span className={`ext-view__badge ext-view__badge--${badge.replace(" ", "-")}`}>
          {badge}
        </span>
        {version.recommended ? (
          <span className="ext-view__badge ext-view__badge--recommended">recommended</span>
        ) : null}
      </div>
      <div className="ext-view__row">
        {version.installed ? (
          <>
            <ActionButton
              label={`Set ${name} Active`}
              availability={version.setActive}
              onClick={() => {
                void ext.setActive(card.id, version.version);
              }}
            />
            <ActionButton
              label={`Repair ${name}`}
              availability={version.repair}
              onClick={() => {
                void ext.repair(card.id, version.version);
              }}
            />
            <ActionButton
              label={`Delete ${name}`}
              availability={version.remove}
              onClick={() => {
                void ext.remove(card.id, version.version);
              }}
            />
          </>
        ) : (
          <ActionButton
            label={`Install ${name}`}
            availability={version.install}
            primary={version.recommended}
            onClick={() => {
              void ext.install(card.id, version.version);
            }}
          />
        )}
      </div>
      {shown ? <div className="ext-view__reason">{shown}</div> : null}
    </li>
  );
}

function VersionLists({ card }: { card: CardView }) {
  return (
    <>
      {card.installedVersions.length > 0 ? (
        <>
          <div className="ext-view__label">Installed</div>
          <ul className="ext-view__versions" aria-label={`${card.name} installed versions`}>
            {card.installedVersions.map((version) => (
              <VersionRow key={version.version} card={card} version={version} />
            ))}
          </ul>
        </>
      ) : null}
      {card.availableVersions.length > 0 ? (
        <>
          <div className="ext-view__label">Available</div>
          <ul className="ext-view__versions" aria-label={`${card.name} available versions`}>
            {card.availableVersions.map((version) => (
              <VersionRow key={version.version} card={card} version={version} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function Status({ card }: { card: CardView }) {
  return (
    <dl className="ext-view__facts">
      <dt>Status</dt>
      <dd>
        {card.installed
          ? `Installed${card.activeVersion ? ` — active ${card.activeVersion}` : " — none active"}`
          : "Not installed"}
      </dd>
      <dt>Source</dt>
      <dd>{card.sourceLabel}</dd>
      <dt>Terminal PATH</dt>
      <dd>{card.terminal.label}</dd>
    </dl>
  );
}

function Features({ card }: { card: CardView }) {
  return (
    <ul className="ext-view__features" aria-label={`${card.name} features`}>
      {card.features.map((feature) => (
        <li
          key={feature.label}
          className={
            feature.available ? "ext-view__feature" : "ext-view__feature ext-view__feature--off"
          }
          title={feature.available ? undefined : feature.note}
        >
          {feature.available ? "✓" : "✗"} {feature.label}
        </li>
      ))}
    </ul>
  );
}

function Progress({ card }: { card: CardView }) {
  return (
    <>
      {card.working ? (
        <div className="ext-view__progress" role="status">
          {card.progressLabel ?? "Working…"}
        </div>
      ) : null}
      {card.error ? <div className="ext-view__error">{card.error}</div> : null}
      {card.notice ? (
        <div className="ext-view__notice" role="status">
          {card.notice}
        </div>
      ) : null}
    </>
  );
}

function RuntimeCard({ card }: { card: CardView }) {
  const ext = usePhpRuntime();
  const update = card.update;
  return (
    <article className="ext-view__card" aria-label={card.name}>
      <header className="ext-view__card-head">
        <h3>{card.name}</h3>
        <span
          className={
            card.installed ? "ext-view__badge ext-view__badge--installed" : "ext-view__badge"
          }
        >
          {card.installed ? "Installed" : "Not installed"}
        </span>
      </header>
      <Status card={card} />
      {card.id === "composer" ? <ComposerDependency card={card} /> : null}
      <Features card={card} />
      <Progress card={card} />
      <VersionLists card={card} />
      <div className="ext-view__row">
        {update ? (
          <ActionButton
            label={`Update ${card.name} to ${update.version}`}
            availability={update.availability}
            primary
            onClick={() => {
              void ext.install(card.id, update.version);
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

/** Composer's PHP dependency; when it is broken and installed, the card's notice already says so. */
function ComposerDependency({ card }: { card: CardView }) {
  const dependency = usePhpRuntime().composerDependency();
  if (!dependency.ok && card.notice !== null) return null;
  return (
    <div
      className={
        dependency.ok ? "ext-view__dependency" : "ext-view__dependency ext-view__dependency--bad"
      }
    >
      PHP dependency: {dependency.label}
    </div>
  );
}

/** PHP and Composer: versions, features, and Install / Set Active / Repair / Delete for each. */
export function PhpRuntimeCards() {
  const runtimes = usePhpRuntime();
  return (
    <div className="ext-view ext-view--embedded">
      {runtimes.cards().map((card) => (
        <RuntimeCard key={card.id} card={card} />
      ))}
    </div>
  );
}
