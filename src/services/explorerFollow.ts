// The Explorer follows the active editor (VS Code's `explorer.autoReveal`): when another file becomes the active tab,
// its folders are opened, its row is selected and scrolled into view — also in a large tree where the row is collapsed
// away or far below. Only a change of the active file (or of the open folder) reveals; the user's own clicks and
// scrolling in the tree are left alone in between.
import { pathKey } from "./textSync";

export interface ExplorerFollowDeps {
  /** The file path of the active editor tab, or null (no tab, an untitled document). */
  activePath(): string | null;
  onActiveChanged(listener: () => void): () => void;
  /** The Explorer's open folder, or null. */
  rootPath(): string | null;
  onExplorerChanged(listener: () => void): () => void;
  /** Expands the folders of `path`, selects it and scrolls it into view (ExplorerService.revealPath). */
  reveal(path: string): Promise<void>;
}

export class ExplorerFollowService {
  private lastKey: string | null = null;
  private lastRoot: string | null = null;
  private running = false;
  private next: string | null = null;

  constructor(private readonly deps: ExplorerFollowDeps) {}

  /** Starts following; returns the function that stops it. */
  start(): () => void {
    const offActive = this.deps.onActiveChanged(() => {
      this.sync();
    });
    const offExplorer = this.deps.onExplorerChanged(() => {
      this.sync();
    });
    this.sync();
    return () => {
      offActive();
      offExplorer();
    };
  }

  private sync(): void {
    const path = this.deps.activePath();
    const root = this.deps.rootPath();
    const key = path === null ? null : pathKey(path);
    // The Explorer emits on every change (also for this service's own reveals): only a new active file or a newly
    // opened folder counts.
    if (key === this.lastKey && root === this.lastRoot) return;
    this.lastKey = key;
    this.lastRoot = root;
    if (path !== null && root !== null) this.queue(path);
  }

  /** One reveal at a time, the newest request last: a slow folder load can't leave an older file selected. */
  private queue(path: string): void {
    this.next = path;
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        while (this.next !== null) {
          const target = this.next;
          this.next = null;
          try {
            await this.deps.reveal(target);
          } catch {
            // A folder that can't be read (deleted meanwhile, no permission): the tree simply doesn't move.
          }
        }
      } finally {
        this.running = false;
      }
    })();
  }
}
