import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type {
  FileLanguageStatus,
  LanguageDef,
  LanguageIpc,
  ProjectStatus,
  WorkspaceStatus,
} from "./languageIpc";
import { matchLanguage } from "./languageRegistry";

export interface LanguageSupportState {
  registry: LanguageDef[];
  workspace: WorkspaceStatus | null;
  scanning: boolean;
  scanError: string | null;
  /** The last file looked up (the file the status window shows). */
  file: FileLanguageStatus | null;
  fileError: string | null;
}

/** Files whose change can change what a folder is (a manifest or a config), so the folder is looked at again. */
const MARKER =
  /(^|\/)(package\.json|cargo\.toml|go\.mod|pubspec\.yaml|composer\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|tauri\.conf\.json|requirements\.txt|pyproject\.toml|gemfile|dockerfile|docker-compose\.ya?ml|cmakelists\.txt|manage\.py|artisan|[^/]+\.(csproj|sln))$/i;

/**
 * Languages and projects: which language a file is (the registry comes from the backend), which projects the open
 * folder holds with their commands and tools, and what is known about the tools of one file. Looking is all it does —
 * a scan reads file names and small manifests, never runs anything, and happens when a folder opens, a manifest is
 * saved, or the user asks. UI-free.
 */
export class LanguageSupportService {
  private state: LanguageSupportState = {
    registry: [],
    workspace: null,
    scanning: false,
    scanError: null,
    file: null,
    fileError: null,
  };
  private readonly listeners = new Set<() => void>();
  private scanSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ipc: LanguageIpc,
    private readonly events: EventBus<AppEvents>,
    private readonly hasWorkspace: () => boolean,
  ) {}

  getState(): LanguageSupportState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<LanguageSupportState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Loads the language table (static data) and follows the folder and saved manifests. */
  async initialize(): Promise<void> {
    try {
      this.set({ registry: await this.ipc.languageRegistry() });
    } catch (error) {
      this.events.emit("appError", { message: `Language support unavailable: ${String(error)}` });
    }
    this.events.on("workspaceFolderChanged", () => {
      this.set({ workspace: null, file: null });
      void this.refresh();
    });
    this.events.on("documentSaved", ({ path }) => {
      if (MARKER.test(path.replace(/\\/g, "/"))) this.refreshSoon();
    });
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // --- Languages ------------------------------------------------------------------------------------------

  languageOf(path: string): LanguageDef | null {
    return matchLanguage(this.state.registry, path);
  }

  /**
   * The editor grammar for a file the built-in table and the extensions don't know (Go, Rust, Java, C#, Dockerfile,
   * Vue as HTML ...), or null when nothing colours it.
   */
  editorLanguageFor(path: string): string | null {
    const language = this.languageOf(path);
    if (language === null || language.syntax === "none" || language.monaco === "plaintext") {
      return null;
    }
    return language.monaco;
  }

  // --- Projects -------------------------------------------------------------------------------------------

  /** Looks at the open folder again. */
  async refresh(): Promise<void> {
    if (!this.hasWorkspace()) {
      this.set({ workspace: null, scanning: false, scanError: null });
      return;
    }
    const seq = ++this.scanSeq;
    this.set({ scanning: true, scanError: null });
    try {
      const workspace = await this.ipc.languageWorkspaceStatus();
      if (seq === this.scanSeq) this.set({ workspace, scanning: false });
    } catch (error) {
      if (seq === this.scanSeq) this.set({ scanning: false, scanError: String(error) });
    }
  }

  /** A saved manifest: look again shortly (several saves in a row are one scan). */
  private refreshSoon(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, 600);
  }

  projects(): readonly ProjectStatus[] {
    return this.state.workspace?.projects ?? [];
  }

  /** The project a workspace-relative path lives in: the deepest one that contains it. */
  projectOf(relativePath: string): ProjectStatus | null {
    let best: ProjectStatus | null = null;
    for (const project of this.projects()) {
      const inside = project.root === "" || relativePath.startsWith(`${project.root}/`);
      if (inside && (best === null || project.root.length > best.root.length)) best = project;
    }
    return best;
  }

  /** The text for the status bar: the top-level project's title, else the first project's, else nothing found. */
  summary(): string | null {
    if (!this.hasWorkspace()) return null;
    const workspace = this.state.workspace;
    if (workspace === null) return this.state.scanning ? "Detecting project…" : null;
    const projects = workspace.projects;
    const top = projects.find((p) => p.root === "") ?? projects[0];
    if (top === undefined) return "No project detected";
    const more = projects.length > 1 ? ` (+${String(projects.length - 1)})` : "";
    return `${top.title}${more}`;
  }

  // --- One file -------------------------------------------------------------------------------------------

  /** The language servers, formatters and linters of a file inside the open folder. */
  async lookUpFile(path: string): Promise<FileLanguageStatus | null> {
    try {
      const file = await this.ipc.languageFileStatus(path);
      this.set({ file, fileError: null });
      return file;
    } catch (error) {
      this.set({ file: null, fileError: String(error) });
      return null;
    }
  }
}
