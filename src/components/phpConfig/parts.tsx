import type { ReactNode } from "react";

import type { Chip as ChipModel } from "../../services/phpConfigModel";

/** A status chip: one word of state with a tone, never a raw message. */
export function StatusChip({ chip }: { chip: ChipModel }) {
  return <span className={`pcfg-chip pcfg-chip--${chip.tone}`}>{chip.label}</span>;
}

/** A section card: title, an optional status chip, one short line of description, then the content. */
export function Card(props: {
  title: string;
  label: string;
  chip?: ChipModel;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="php-view__section pcfg-card" aria-label={props.label}>
      <header className="pcfg-card__head">
        <h3>{props.title}</h3>
        {props.chip ? <StatusChip chip={props.chip} /> : null}
      </header>
      {props.description ? <p className="pcfg-card__desc">{props.description}</p> : null}
      {props.children}
    </section>
  );
}

/** A label/value list; long values wrap inside their column instead of stretching the page. */
export function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="pcfg-facts">
      {rows.map((row) => (
        <div key={row.label} className="pcfg-facts__row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
