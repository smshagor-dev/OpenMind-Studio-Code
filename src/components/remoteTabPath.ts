import { container } from "../services/container";

/** The custom scheme a participant's remote collaboration documents use (`omcollab://<room id>/<file id>`). */
const REMOTE_SCHEME = "omcollab:";

/** Whether `path` is a remote collaboration document's internal address (never shown to the user). */
export function isRemotePath(path: string | null): boolean {
  return path !== null && path.toLowerCase().startsWith(REMOTE_SCHEME);
}

/**
 * The words to show for a remote document instead of its internal address: the shared folder's name and the file's
 * path inside it (what the Owner shared), never the room id, the file id or anything of the Owner's own disk. `null`
 * when the document's origin isn't known (then only its title is shown).
 */
export function remoteDisplaySegments(
  origin: { room: string; path: string } | undefined,
): string[] | null {
  if (!origin) return null;
  const parts = origin.path.split("/").filter((part) => part.length > 0);
  return [origin.room, ...parts];
}

/** The origin of the remote document shown by preview tab `docId` (participant side), if it is one. */
export function remoteOrigin(docId: string): { room: string; path: string } | undefined {
  const model = container.filePreviews.get(docId)?.model;
  return model?.type === "virtualText" ? model.collab : undefined;
}

/** A tab's path as the user may see it: a remote document's folder/path, never its internal address. */
export function shownPath(path: string | null, docId: string, title: string): string | null {
  if (path === null || !isRemotePath(path)) return path;
  return remoteDisplaySegments(remoteOrigin(docId))?.join("/") ?? title;
}
