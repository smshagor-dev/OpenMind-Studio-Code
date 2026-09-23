import type { DirEntryInfo, IpcClient, PathMetadata } from "./ipc";

/**
 * All file/folder CRUD lives here, nowhere else — Explorer UI and
 * ExplorerService call into this rather than touching IPC directly. Pure
 * I/O wrapper: no tree state, no confirmation dialogs (those are UI
 * concerns triggered before calling `delete`/`move`, not this service's
 * job).
 */
export class FileSystemService {
  constructor(private readonly ipc: IpcClient) {}

  readDir(path: string): Promise<DirEntryInfo[]> {
    return this.ipc.fsReadDir(path);
  }

  metadata(path: string): Promise<PathMetadata> {
    return this.ipc.fsMetadata(path);
  }

  isBinary(path: string): Promise<boolean> {
    return this.ipc.fsIsBinary(path);
  }

  createFile(workspaceRoot: string, parentDir: string, name: string): Promise<string> {
    return this.ipc.fsCreateFile(workspaceRoot, parentDir, name);
  }

  createFolder(workspaceRoot: string, parentDir: string, name: string): Promise<string> {
    return this.ipc.fsCreateFolder(workspaceRoot, parentDir, name);
  }

  rename(workspaceRoot: string, path: string, newName: string): Promise<string> {
    return this.ipc.fsRename(workspaceRoot, path, newName);
  }

  delete(workspaceRoot: string, path: string): Promise<void> {
    return this.ipc.fsDelete(workspaceRoot, path);
  }

  move(workspaceRoot: string, source: string, destDir: string): Promise<string> {
    return this.ipc.fsMove(workspaceRoot, source, destDir);
  }

  copy(workspaceRoot: string, source: string, destDir: string): Promise<string> {
    return this.ipc.fsCopy(workspaceRoot, source, destDir);
  }

  /** Copies `path` into its own parent directory under an auto-generated "copy" name. */
  async duplicate(workspaceRoot: string, path: string): Promise<string> {
    const parentDir = dirname(path);
    const siblings = await this.readDir(parentDir);
    const siblingNames = new Set(siblings.map((entry) => entry.name));
    const newName = nextAvailableDuplicateName(basename(path), siblingNames);
    return this.ipc.fsDuplicate(workspaceRoot, path, newName);
  }
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? path : path.slice(0, index);
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || path;
}

/** "a.txt" -> "a copy.txt" -> "a copy 2.txt" -> "a copy 3.txt" ..., skipping any name already taken. */
function nextAvailableDuplicateName(name: string, taken: Set<string>): string {
  const dotIndex = name.lastIndexOf(".");
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? name.slice(0, dotIndex) : name;
  const extension = hasExtension ? name.slice(dotIndex) : "";

  let candidate = `${stem} copy${extension}`;
  let attempt = 2;
  while (taken.has(candidate)) {
    candidate = `${stem} copy ${attempt}${extension}`;
    attempt += 1;
  }
  return candidate;
}
