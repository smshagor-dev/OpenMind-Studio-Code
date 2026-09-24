import * as monaco from "monaco-editor";

/** The Monaco language id for a file name, from the registered extensions ("plaintext" if none match). */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot) : "";
  const match = monaco.languages
    .getLanguages()
    .find(
      (language) =>
        (extension !== "" && (language.extensions ?? []).includes(extension)) ||
        (language.filenames ?? []).some((filename) => filename.toLowerCase() === name),
    );
  return match?.id ?? "plaintext";
}
