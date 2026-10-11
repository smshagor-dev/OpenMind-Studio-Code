import { t } from "../../i18n";

/** Role names as translation keys. */
export const ROLE_KEYS = {
  owner: "collab.role.owner",
  admin: "collab.role.admin",
  editor: "collab.role.editor",
  viewer: "collab.role.viewer",
} as const;

/** A join failure in words (the backend's category; its own sentence only under Details). */
export function joinErrorText(kind: string): string {
  const key = `collab.joinError.${kind}`;
  const text = t(key);
  return text === key ? t("collab.joinError.other") : text;
}
