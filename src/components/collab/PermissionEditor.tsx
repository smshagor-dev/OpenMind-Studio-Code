import { useState } from "react";

import { t } from "../../i18n";
import type { ParticipantRow } from "../../services/collab/collabPanelModel";
import type { PermissionModel } from "../../services/collab/roomIpc";
import { ROLE_KEYS } from "./collabLabels";

type Choice = "inherit" | "allow" | "deny";

const GROUP_ORDER = ["file", "member", "room", "voice"];

/** A permission's label: translated from its backend name (`file.write` -> `collab.perm.file.write`). */
function label(name: string): string {
  const key = `collab.perm.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

function initial(row: ParticipantRow, name: string): Choice {
  if (row.denied?.includes(name)) return "deny";
  if (row.granted?.includes(name)) return "allow";
  return "inherit";
}

/** The model's permissions by group (Owner-only ones left out: nobody else can ever hold them). */
function groupsOf(model: PermissionModel): { group: string; items: { name: string }[] }[] {
  const ownerOnly = new Set(model.ownerOnly);
  return GROUP_ORDER.map((group) => ({
    group,
    items: model.permissions.filter((p) => p.group === group && !ownerOnly.has(p.name)),
  })).filter((g) => g.items.length > 0);
}

/**
 * A member's permissions: per permission the role's default (from the backend's model), this member's override
 * (inherit / allow / deny) and what is in effect now as the Owner computed it. Saving sends the overrides; the Owner
 * checks them (no permission the sender lacks, nothing Owner-only) and the list then shows the new effective values.
 * The parent remounts it when the backend reports other overrides, so a change by someone else shows up here too.
 */
export function PermissionEditor({
  row,
  model,
  grantable,
  onSave,
  onClose,
}: {
  row: ParticipantRow;
  model: PermissionModel;
  /** What this member itself holds (a grant can't exceed it; the Owner refuses it anyway). */
  grantable: ReadonlySet<string>;
  onSave: (overrides: { grant: string[]; deny: string[] }) => Promise<boolean>;
  onClose: () => void;
}) {
  const names = model.permissions.map((p) => p.name);
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(names.map((n) => [n, initial(row, n)])),
  );
  const [saving, setSaving] = useState(false);
  const defaults = new Set(model.roles.find((r) => r.role === row.role)?.defaults ?? []);
  const effective = new Set(row.permissions ?? []);
  const groups = groupsOf(model);
  const save = async () => {
    setSaving(true);
    const grant = names.filter((n) => choices[n] === "allow");
    const deny = names.filter((n) => choices[n] === "deny");
    const ok = await onSave({ grant, deny });
    setSaving(false);
    if (ok) onClose();
  };
  const name = row.name || t("collab.member");
  return (
    <div className="modal-overlay" role="presentation">
      <div
        className="modal collab-perms"
        role="dialog"
        aria-modal="true"
        aria-label={t("collab.perms.title", { name })}
      >
        <h2>{t("collab.perms.title", { name })}</h2>
        <p className="collab-perms__role">
          {t("collab.perms.role", { role: t(ROLE_KEYS[row.role]) })}
        </p>
        <div className="collab-perms__groups">
          {groups.map(({ group, items }) => (
            <PermissionGroup
              key={group}
              group={group}
              items={items}
              defaults={defaults}
              effective={effective}
              grantable={grantable}
              choices={choices}
              disabled={saving}
              onChoose={(name, choice) => {
                setChoices({ ...choices, [name]: choice });
              }}
            />
          ))}
        </div>
        <p className="collab-perms__note">{t("collab.perms.note")}</p>
        <div className="modal__actions">
          <button
            type="button"
            className="modal__confirm--primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {t("collab.perms.save")}
          </button>
          <button type="button" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One group of permissions (files, members, room, voice): default, override and effective value per permission. */
function PermissionGroup(props: {
  group: string;
  items: { name: string }[];
  defaults: ReadonlySet<string>;
  effective: ReadonlySet<string>;
  grantable: ReadonlySet<string>;
  choices: Record<string, Choice>;
  disabled: boolean;
  onChoose: (name: string, choice: Choice) => void;
}) {
  const { defaults, effective } = props;
  return (
    <fieldset className="collab-perms__group">
      <legend>{t(`collab.permGroup.${props.group}`)}</legend>
      <div className="collab-perms__head" aria-hidden="true">
        <span />
        <span>{t("collab.perms.default")}</span>
        <span>{t("collab.perms.override")}</span>
        <span>{t("collab.perms.effective")}</span>
      </div>
      {props.items.map((p) => (
        <div key={p.name} className="collab-perms__row">
          <span className="collab-perms__name">{label(p.name)}</span>
          <span>
            {defaults.has(p.name) ? t("collab.perms.allowed") : t("collab.perms.notAllowed")}
          </span>
          <select
            aria-label={t("collab.perms.overrideFor", { permission: label(p.name) })}
            value={props.choices[p.name]}
            disabled={props.disabled}
            onChange={(event) => {
              props.onChoose(p.name, event.target.value as Choice);
            }}
          >
            <option value="inherit">{t("collab.perms.inherit")}</option>
            <option value="allow" disabled={!props.grantable.has(p.name)}>
              {t("collab.perms.allow")}
            </option>
            <option value="deny">{t("collab.perms.deny")}</option>
          </select>
          <span className={effective.has(p.name) ? "collab-perms__on" : "collab-perms__off"}>
            {effective.has(p.name) ? t("collab.perms.allowed") : t("collab.perms.denied")}
          </span>
        </div>
      ))}
    </fieldset>
  );
}
