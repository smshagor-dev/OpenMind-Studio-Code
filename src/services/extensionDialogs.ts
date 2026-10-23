export interface ExtensionDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  canSelectFiles?: boolean;
  canSelectFolders?: boolean;
  canSelectMany?: boolean;
}
export interface ExtensionDialogs {
  open(options: ExtensionDialogOptions): Promise<string[] | null>;
  save(options: ExtensionDialogOptions): Promise<string | null>;
}

export function nativeExtensionDialogs(
  pickKind: () => Promise<"files" | "folders" | null>,
): ExtensionDialogs {
  return {
    async open(options) {
      const files = options.canSelectFiles !== false;
      const folders = options.canSelectFolders === true;
      if (!files && !folders)
        throw new Error("The dialog must allow files or folders.");
      const kind =
        files && folders ? await pickKind() : folders ? "folders" : "files";
      if (kind === null) return null;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        multiple: options.canSelectMany === true,
        directory: kind === "folders",
      });
      return result === null ? null : Array.isArray(result) ? result : [result];
    },
    async save(options) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return save({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
    },
  };
}

/** Allow only the documented native dialog options through the RPC boundary. */
export function extensionDialogOptions(value: unknown): ExtensionDialogOptions {
  if (value === null || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: ExtensionDialogOptions = {};
  if (typeof input.title === "string") result.title = input.title;
  if (typeof input.defaultPath === "string")
    result.defaultPath = input.defaultPath;
  for (const key of [
    "canSelectFiles",
    "canSelectFolders",
    "canSelectMany",
  ] as const) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  if (Array.isArray(input.filters))
    result.filters = input.filters.map((value: unknown) => {
      if (!value || typeof value !== "object")
        throw new Error("Invalid dialog filter.");
      const filter = value as Record<string, unknown>;
      if (
        typeof filter.name !== "string" ||
        !Array.isArray(filter.extensions) ||
        !filter.extensions.every((part: unknown) => typeof part === "string")
      )
        throw new Error("Invalid dialog filter.");
      return { name: filter.name, extensions: filter.extensions };
    });
  return result;
}
