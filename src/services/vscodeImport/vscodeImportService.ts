import type { VsCodeImportIpc, VsCodeImportResult, VsCodePreview, VsCodeSource } from "./vscodeImportIpc";

/** What the app re-reads after an import, so the change shows at once (settings, shortcuts, snippets ...). */
export interface VsCodeImportHost {
  reloadSettings: () => Promise<void>;
  reloadKeybindings: () => Promise<void>;
  reloadProfiles: () => Promise<void>;
  reloadExtensions: () => Promise<void>;
  reloadSnippets: () => void;
  text: (key: string, params?: Record<string, string | number>) => string;
}

export interface VsCodeImportState {
  expanded: boolean;
  sources: VsCodeSource[];
  /** `edition:profile` of the chosen source. */
  selected: string;
  preview: VsCodePreview | null;
  result: VsCodeImportResult | null;
  importSettings: boolean;
  importShortcuts: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

export function sourceKey(source: VsCodeSource): string {
  return `${source.edition}:${source.profile}`;
}

const INITIAL: VsCodeImportState = {
  expanded: false,
  sources: [],
  selected: "",
  preview: null,
  result: null,
  importSettings: true,
  importShortcuts: true,
  busy: false,
  error: null,
  notice: null,
};

/**
 * The Settings page's "Import from VS Code": find the VS Code profiles on this computer, preview what each would bring
 * (translated by the backend), and import settings/shortcuts, snippets, the profile as an OpenMind profile, or one
 * installed extension (disabled). Every step is a click; nothing is read or imported by itself.
 */
export class VsCodeImportService {
  private state: VsCodeImportState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: VsCodeImportIpc,
    private readonly host: VsCodeImportHost,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): VsCodeImportState {
    return this.state;
  }

  private set(patch: Partial<VsCodeImportState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  selectedSource(): VsCodeSource | undefined {
    return this.state.sources.find((source) => sourceKey(source) === this.state.selected);
  }

  /** Runs one step: busy while it runs, its failure shown, a step already running is not started again. */
  private async step(work: () => Promise<Partial<VsCodeImportState>>): Promise<boolean> {
    if (this.state.busy) return false;
    this.set({ busy: true, error: null });
    try {
      this.set({ ...(await work()), busy: false });
      return true;
    } catch (failure) {
      this.set({ busy: false, error: String(failure) });
      return false;
    }
  }

  async toggle(): Promise<void> {
    if (this.state.expanded) {
      this.set({ expanded: false });
      return;
    }
    this.set({ expanded: true });
    await this.step(async () => {
      const sources = await this.ipc.sources();
      const first = sources[0];
      return { sources, selected: first ? sourceKey(first) : "", preview: null, result: null, notice: null };
    });
  }

  select(key: string): void {
    this.set({ selected: key, preview: null, result: null, notice: null, error: null });
  }

  setImportSettings(on: boolean): void {
    this.set({ importSettings: on });
  }

  setImportShortcuts(on: boolean): void {
    this.set({ importShortcuts: on });
  }

  async inspect(): Promise<boolean> {
    const source = this.selectedSource();
    if (!source) return false;
    return this.step(async () => ({
      preview: await this.ipc.preview(source.edition, source.profile),
      result: null,
      notice: null,
    }));
  }

  /** Why "Import selected items" can't run now, or null. */
  applyBlocker(): string | null {
    if (!this.state.preview) return this.host.text("vscodeImport.reason.previewFirst");
    if (!this.state.importSettings && !this.state.importShortcuts) return this.host.text("vscodeImport.reason.nothingChosen");
    return null;
  }

  async apply(): Promise<boolean> {
    const source = this.selectedSource();
    if (!source || this.applyBlocker() !== null) return false;
    const { importSettings, importShortcuts } = this.state;
    return this.step(async () => {
      const result = await this.ipc.apply(source.edition, source.profile, importSettings, importShortcuts);
      if (result.settingsImported > 0) await this.host.reloadSettings();
      if (result.shortcutsImported > 0) await this.host.reloadKeybindings();
      return { result, notice: null };
    });
  }

  async importSnippets(): Promise<boolean> {
    const source = this.selectedSource();
    if (!source || !this.state.preview || this.state.preview.snippets.length === 0) return false;
    return this.step(async () => {
      const count = await this.ipc.importSnippets(source.edition, source.profile);
      this.host.reloadSnippets();
      return { notice: this.host.text("vscodeImport.notice.snippets", { count }) };
    });
  }

  async importProfile(): Promise<boolean> {
    const source = this.selectedSource();
    if (!source) return false;
    return this.step(async () => {
      await this.ipc.importProfile(source.edition, source.profile);
      await this.host.reloadProfiles();
      return { notice: this.host.text("vscodeImport.notice.profile", { name: source.label }) };
    });
  }

  async importExtension(folder: string): Promise<boolean> {
    const source = this.selectedSource();
    if (!source) return false;
    return this.step(async () => {
      const imported = await this.ipc.importExtension(source.edition, folder);
      await this.host.reloadExtensions();
      return { notice: this.host.text("vscodeImport.notice.extension", { id: imported.id }) };
    });
  }
}
