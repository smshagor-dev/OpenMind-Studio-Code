/**
 * The author's picture is a local file: put it at `src/assets/about/author.png` (or `.jpg`, `.jpeg`, `.webp`).
 * It is bundled with the app — never fetched from the internet — and when there is none (or it can't be decoded)
 * the About window shows the author's initials instead.
 */
const bundled = import.meta.glob("../assets/about/author.{png,jpg,jpeg,webp}", {
  eager: true,
  query: "?url",
  import: "default",
});

/** The address of the first bundled author picture, or `null` when there is none. */
export function pickAuthorImage(modules: Record<string, unknown>): string | null {
  for (const key of Object.keys(modules).sort()) {
    const value = modules[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export const AUTHOR_IMAGE: string | null = pickAuthorImage(bundled);

/** "Md Shahanur Islam Shagor" -> "MS": the first letters of the first and the last word. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}
