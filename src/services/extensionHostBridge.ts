import type { ExtensionPromptService } from "./extensionPromptService";
import type { ExtensionEditorService } from "./extensionEditorService";
import type { OutputService } from "./outputService";

/** The document as the host wants it (0-based lines are the host's business, not part of this). */
export interface HostDocument {
  path: string;
  languageId: string;
  version: number;
  text: string;
  isDirty: boolean;
}

/** A language feature an extension registered (completion, hover, definition). */
export interface ProviderRegistration {
  handle: string;
  kind: "completion" | "hover" | "definition";
  extension: string;
  selector: { language?: string; scheme?: string; pattern?: string }[];
  triggerCharacters?: string[];
}

export type ProviderInvoke = (payload: {
  path: string;
  position: { line: number; character: number };
}) => Promise<unknown>;

/** A problem an extension reports for a file (host coordinates: 0-based). */
export interface HostDiagnostic {
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  message: string;
  severity: number;
  source?: string;
  code?: string;
}

export interface BridgeDeps {
  prompts: ExtensionPromptService;
  output: OutputService;
  /** Sends a request to the host (used to invoke a registered language feature). */
  hostRequest: (method: string, params: unknown) => Promise<unknown>;
  showOutput: (channel: string) => void;
  openExternal: (url: string) => Promise<void>;
  readDocument: (path: string) => Promise<HostDocument | null>;
  languageIds: () => string[];
  updateConfiguration: (key: string, value: unknown, target: "user" | "workspace") => Promise<void>;
  registerProvider: (registration: ProviderRegistration, invoke: ProviderInvoke) => () => void;
  setDiagnostics: (collection: string, path: string, diagnostics: HostDiagnostic[]) => void;
  /** Commands from other extensions the host may run through `executeCommand`, and the app's own. */
  runCommand: (command: string, args: unknown[]) => Promise<unknown>;
  /** The command ids that can be run: built in, contributed and registered by activated extensions. */
  knownCommands: () => string[];
  onHostCommandsChanged: () => void;
  /** `views/*` notifications (tree views), and `views/reset` when the host went away. */
  onViewEvent?: (method: string, params: Record<string, unknown>) => void;
  /** Edits, selection and reveal requests of extensions (`editor/*`). */
  editorApi?: ExtensionEditorService;
  /** `statusBar/*` notifications, and `statusBar/reset` when the host went away. */
  onStatusBarEvent?: (method: string, params: Record<string, unknown>) => void;
  /** `webview/*` notifications (panels), and `webview/reset` when the host went away. */
  onWebviewEvent?: (method: string, params: Record<string, unknown>) => void;
}

/** Every channel an extension creates shows up under this suffix when it would clash with a built-in one. */
const BUILT_IN_CHANNELS = new Set([
  "OpenMind Studio",
  "Runtime Manager",
  "Terminal",
  "Search",
  "Git",
  "LSP",
  "Python",
  "Node.js",
  "PHP",
  "Run Code",
  "PHP Server",
]);

/** Where the host's own lines (an extension's `console.log`, an activation failure) go. */
export const HOST_CHANNEL = "Extension Host";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function channelName(channel: string): string {
  if (channel === "console" || channel === "error" || channel === "") return HOST_CHANNEL;
  return BUILT_IN_CHANNELS.has(channel) ? `${channel} (extension)` : channel;
}

/**
 * What the extension host is allowed to ask of the app — a fixed list, everything else is refused. This is
 * the API bridge: extension code never touches an app service directly, it sends one of these messages and
 * the app decides. UI-free.
 */
export class HostBridge {
  /** Commands extensions registered in the host (not necessarily contributed in a manifest). */
  private readonly hostCommands = new Set<string>();
  private readonly providers = new Map<string, () => void>();

  constructor(private readonly deps: BridgeDeps) {}

  registeredCommands(): ReadonlySet<string> {
    return this.hostCommands;
  }

  async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = record(params);
    switch (method) {
      case "ui/showMessage":
        return this.showMessage(p);
      case "ui/showQuickPick":
        return this.deps.prompts.quickPick({
          extension: text(p.extension),
          items: Array.isArray(p.items)
            ? (p.items as { label: string; description?: string; detail?: string }[])
            : [],
          placeHolder: typeof p.placeHolder === "string" ? p.placeHolder : null,
          canPickMany: p.canPickMany === true,
        });
      case "ui/showInputBox":
        return this.deps.prompts.inputBox({
          extension: text(p.extension),
          prompt: typeof p.prompt === "string" ? p.prompt : null,
          placeHolder: typeof p.placeHolder === "string" ? p.placeHolder : null,
          value: text(p.value),
          password: p.password === true,
          title: typeof p.title === "string" ? p.title : null,
        });
      case "ui/openExternal":
        await this.deps.openExternal(text(p.url));
        return true;
      case "workspace/openTextDocument": {
        const document = await this.deps.readDocument(text(p.path));
        if (document === null) throw new Error(`Couldn't open ${text(p.path)}.`);
        return document;
      }
      case "workspace/getLanguages":
        return this.deps.languageIds();
      case "workspace/updateConfiguration":
        await this.deps.updateConfiguration(
          text(p.key),
          p.value === null ? undefined : p.value,
          p.target === "workspace" ? "workspace" : "user",
        );
        return null;
      case "editor/applyEdits":
        return this.editorApi().applyEdits(p);
      case "editor/applyWorkspaceEdit":
        return this.editorApi().applyWorkspaceEdit(p);
      case "commands/execute":
        return this.deps.runCommand(text(p.command), Array.isArray(p.args) ? p.args : []);
      case "commands/getCommands":
        return this.deps.knownCommands();
      default:
        throw new Error(`Not an allowed extension host request: ${method}`);
    }
  }

  handleNotification(method: string, params: unknown): void {
    const p = record(params);
    switch (method) {
      case "log/output":
        this.log(text(p.extension), text(p.channel), text(p.text));
        return;
      case "ui/showMessage":
        void this.showMessage(p);
        return;
      case "ui/showOutput":
        this.deps.showOutput(channelName(text(p.channel)));
        return;
      case "ui/clearOutput":
        this.deps.output.clear(channelName(text(p.channel)));
        return;
      case "commands/registered":
        this.hostCommands.add(text(p.command));
        this.deps.onHostCommandsChanged();
        return;
      case "commands/unregistered":
        this.hostCommands.delete(text(p.command));
        this.deps.onHostCommandsChanged();
        return;
      case "languages/registered":
        this.registerProvider(params as ProviderRegistration);
        return;
      case "languages/unregistered":
        this.providers.get(text(p.handle))?.();
        this.providers.delete(text(p.handle));
        return;
      case "diagnostics/set":
        this.deps.setDiagnostics(
          text(p.collection),
          text(p.path),
          Array.isArray(p.diagnostics) ? (p.diagnostics as HostDiagnostic[]) : [],
        );
        return;
      case "editor/setSelections":
        this.deps.editorApi?.setSelections(p);
        return;
      case "editor/revealRange":
        this.deps.editorApi?.revealRange(p);
        return;
      default:
        if (method.startsWith("views/")) this.deps.onViewEvent?.(method, p);
        else if (method.startsWith("statusBar/")) this.deps.onStatusBarEvent?.(method, p);
        else if (method.startsWith("webview/")) this.deps.onWebviewEvent?.(method, p);
    }
  }

  private editorApi(): ExtensionEditorService {
    if (!this.deps.editorApi) throw new Error("Editing isn't available here.");
    return this.deps.editorApi;
  }

  /** The host went away: what it had registered is gone with it. */
  reset(): void {
    for (const dispose of this.providers.values()) dispose();
    this.providers.clear();
    this.hostCommands.clear();
    this.deps.prompts.dismissAll();
    this.deps.onHostCommandsChanged();
    this.deps.onViewEvent?.("views/reset", {});
    this.deps.onStatusBarEvent?.("statusBar/reset", {});
    this.deps.onWebviewEvent?.("webview/reset", {});
  }

  private log(extension: string, channel: string, line: string): void {
    const name = channelName(channel);
    const tagged = name === HOST_CHANNEL && extension !== "" ? `[${extension}] ${line}` : line;
    this.deps.output.append(name, tagged);
  }

  private showMessage(p: Record<string, unknown>): Promise<string | null> {
    const severity = p.severity === "warning" || p.severity === "error" ? p.severity : "info";
    return this.deps.prompts.showMessage({
      extension: text(p.extension),
      severity,
      message: text(p.message),
      items: Array.isArray(p.items) ? p.items.map(String) : [],
    });
  }

  private registerProvider(registration: ProviderRegistration): void {
    const dispose = this.deps.registerProvider(registration, (payload) =>
      this.deps.hostRequest("host/provide", { handle: registration.handle, ...payload }),
    );
    this.providers.set(registration.handle, dispose);
  }
}
