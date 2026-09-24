import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { toMarker } from "./lspConvert";
import { pathKey } from "./textSync";

const owner = (server: string) => `lsp:${server}`;

/**
 * Puts what language servers report on the open documents as Monaco markers
 * (squiggles in the editor, and — because the Problems panel reads markers —
 * entries in Problems). A server that publishes an empty list clears the
 * file; a file that is closed loses its markers with its model; a server that
 * stops (or is restarted) has everything it reported removed, since nothing
 * is left to keep it up to date.
 */
export class DiagnosticsService {
  /** server → the documents it currently has markers on. */
  private readonly marked = new Map<string, Map<string, string>>();
  private offs: (() => void)[] = [];

  constructor(
    private readonly events: EventBus<AppEvents>,
    private readonly documents: DocumentService,
  ) {}

  initialize(): void {
    this.dispose();
    this.offs.push(
      this.events.on("lspDiagnostics", (event) => {
        this.apply(event.server, event.path, event.diagnostics);
      }),
      this.events.on("lspServerStopped", ({ server }) => {
        this.clearServer(server);
      }),
      // Markers outlive their model in Monaco, so a closed file's problems are removed explicitly
      // (the document still exists while this event is delivered).
      this.events.on("documentClosed", ({ id }) => {
        for (const [server, files] of this.marked) {
          for (const [key, docId] of files) {
            if (docId !== id) continue;
            if (this.documents.has(id)) this.documents.setMarkers(id, owner(server), []);
            files.delete(key);
          }
        }
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private apply(
    server: string,
    path: string,
    diagnostics: AppEvents["lspDiagnostics"]["diagnostics"],
  ): void {
    const id = this.documents.idForPath(path);
    // Diagnostics for a file that isn't open have nowhere to be shown.
    if (id === null) return;
    this.documents.setMarkers(id, owner(server), diagnostics.map(toMarker));
    let files = this.marked.get(server);
    if (!files) {
      files = new Map();
      this.marked.set(server, files);
    }
    if (diagnostics.length === 0) files.delete(pathKey(path));
    else files.set(pathKey(path), id);
  }

  /** Removes everything `server` reported. */
  clearServer(server: string): void {
    const files = this.marked.get(server);
    if (!files) return;
    for (const id of files.values()) {
      if (this.documents.has(id)) this.documents.setMarkers(id, owner(server), []);
    }
    this.marked.delete(server);
  }
}
