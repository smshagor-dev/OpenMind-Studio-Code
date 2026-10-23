import type { DynamicQuickInput } from "./extensionPromptService";
import {
  extensionDialogOptions,
  type ExtensionDialogs,
} from "./extensionDialogs";
import type { ExtensionPromptService } from "./extensionPromptService";
import type { ExtensionEditorService } from "./extensionEditorService";
import type { ExtensionTaskService } from "./extensionTasks";
import type { ExtensionTerminalService } from "./extensionTerminals";
import type { OutputService } from "./outputService";

/** The document as the host wants it (0-based lines are the host's business, not part of this). */
export interface HostDocument {
  eol?: 1 | 2;
  path: string;
  languageId: string;
  version: number;
  text: string;
  isDirty: boolean;
}

/** A language feature an extension registered with the host. */
export interface ProviderRegistration {
  handle: string;
  kind:
    | "workspaceSymbol"
    | "callHierarchy"
    | "typeHierarchy"
    | "inlineCompletion"
    | "completion"
    | "hover"
    | "definition"
    | "typeDefinition"
    | "implementation"
    | "inlayHints"
    | "color"
    | "rename"
    | "codeAction"
    | "codeLens"
    | "semanticTokens"
    | "rangeSemanticTokens"
    | "declaration"
    | "signatureHelp"
    | "selectionRange"
    | "linkedEditing"
    | "onTypeFormatting"
    | "documentLink"
    | "reference"
    | "highlight"
    | "documentSymbol"
    | "folding"
    | "formatting"
    | "rangeFormatting";
  extension: string;
  selector: {
    language?: string;
    scheme?: string;
    pattern?: string | { base: string; pattern: string };
  }[];
  triggerCharacters?: string[];
  retriggerCharacters?: string[];
  providedCodeActionKinds?: string[];
  legend?: { tokenTypes: string[]; tokenModifiers: string[] };
  /** The extension's name, for a formatter ("Format Document With..."). */
  displayName?: string;
}

export interface ProviderCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export type ProviderInvoke = ((
  payload: {
    path: string;
    position?: { line: number; character: number };
    range?: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    };
    options?: { tabSize: number; insertSpaces: boolean };
    positions?: { line: number; character: number }[];
    character?: string;
    action?: "resolve" | "command" | "prepare" | "release" | "present";
    newName?: string;
    partIndex?: number;
    color?: { red: number; green: number; blue: number; alpha: number };
    itemIds?: string[];
    itemId?: string;
    context?: {
      selectedCompletionInfo?: {
        range: {
          startLine: number;
          startColumn: number;
          endLine: number;
          endColumn: number;
        };
        text: string;
      };
      only?: string;
      diagnostics?: HostDiagnostic[];
      includeDeclaration?: boolean;
      triggerKind?: number;
      triggerCharacter?: string;
      isRetrigger?: boolean;
      activeSignatureHelp?: unknown;
    };
  },
  token?: ProviderCancellation,
) => Promise<unknown>) & {
  onDidChange?: (listener: () => void) => { dispose(): void };
};

/** A custom-scheme document an extension opens (`window.showTextDocument`, read-only in the app). */
export interface VirtualDocumentRequest {
  extension: string;
  uri: string;
  scheme: string;
  path: string;
  text: string;
  languageId: string;
  readonly: boolean;
}

/** A problem an extension reports for a file (host coordinates: 0-based). */
export interface HostDiagnostic {
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  message: string;
  severity: number;
  /** VS Code DiagnosticTag: 1 = unnecessary, 2 = deprecated. */
  tags?: number[];
  source?: string;
  code?: string;
}

export interface BridgeDeps {
  dialogs?: ExtensionDialogs;
  clipboard?: { readText(): Promise<string | null>; writeText(value: string): Promise<void> };
  prompts: ExtensionPromptService;
  output: OutputService;
  /** Sends a request to the host (used to invoke a registered language feature). */
  hostRequest: (method: string, params: unknown) => Promise<unknown>;
  showOutput: (channel: string) => void;
  openExternal: (url: string) => Promise<void>;
  readDocument: (path: string) => Promise<HostDocument | null>;
  languageIds: () => string[];
  updateConfiguration: (
    key: string,
    value: unknown,
    target: "user" | "workspace",
  ) => Promise<void>;
  registerProvider: (
    registration: ProviderRegistration,
    invoke: ProviderInvoke,
  ) => () => void;
  setDiagnostics: (
    collection: string,
    path: string,
    diagnostics: HostDiagnostic[],
  ) => void;
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
  onWorkbenchEvent?: (method: string, params: Record<string, unknown>) => void;
  /** Extension terminals (`terminal/*`, Milestone 18). */
  terminals?: ExtensionTerminalService;
  /** Extension tasks (`tasks/execute`, `tasks/terminate`). */
  tasks?: ExtensionTaskService;
  /** Opens a file in a tab (`window.showTextDocument`). */
  showTextDocument?: (path: string, preserveFocus: boolean) => Promise<void>;
  /** Opens a custom-scheme document read-only in a tab. */
  showVirtualDocument?: (request: VirtualDocumentRequest) => Promise<void>;
  updateVirtualDocument?: (request: VirtualDocumentRequest) => void;
  /** Saves an open document / every open document (`TextDocument.save`, `workspace.saveAll`). */
  saveDocument?: (path: string) => Promise<boolean>;
  saveAll?: () => Promise<boolean>;
  /** A document formatting provider (offered by the formatter, never used by itself). */
  registerFormatter?: (
    registration: ProviderRegistration,
    invoke: ProviderInvoke,
  ) => () => void;
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
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function channelName(channel: string): string {
  if (channel === "console" || channel === "error" || channel === "")
    return HOST_CHANNEL;
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
  private nextProviderRequest = 0;
  private readonly providerChanges = new Map<string, () => void>();

  constructor(private deps: BridgeDeps) {}

  /** Adds the services built after the bridge (terminals, tasks, documents, formatters: Milestone 18). */
  connect(extra: Partial<BridgeDeps>): void {
    this.deps = { ...this.deps, ...extra };
  }

  registeredCommands(): ReadonlySet<string> {
    return this.hostCommands;
  }

  async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = record(params);
    switch (method) {
      case "ui/showMessage":
        return this.showMessage(p);
      case "clipboard/readText":
        return this.need(this.deps.clipboard, "Clipboard").readText();
      case "clipboard/writeText":
        await this.need(this.deps.clipboard, "Clipboard").writeText(text(p.text));
        return null;
      case "ui/showOpenDialog":
        return this.need(this.deps.dialogs, "File dialogs").open(
          extensionDialogOptions(p.options),
        );
      case "ui/showSaveDialog":
        return this.need(this.deps.dialogs, "File dialogs").save(
          extensionDialogOptions(p.options),
        );
      case "ui/showQuickPick":
        return this.deps.prompts.quickPick({
          extension: text(p.extension),
          items: Array.isArray(p.items)
            ? (p.items as {
                label: string;
                description?: string;
                detail?: string;
              }[])
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
        if (document === null)
          throw new Error(`Couldn't open ${text(p.path)}.`);
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
      case "editor/insertSnippet":
        return this.editorApi().insertSnippet(p);
      case "editor/applyEdits":
        return this.editorApi().applyEdits(p);
      case "editor/applyWorkspaceEdit":
        return this.editorApi().applyWorkspaceEdit(p);
      case "commands/execute":
        return this.deps.runCommand(
          text(p.command),
          Array.isArray(p.args) ? p.args : [],
        );
      case "commands/getCommands":
        return this.deps.knownCommands();
      case "terminal/runDebuggee":
        return this.need(this.deps.terminals, "Terminals").runDebuggee(p);
      case "terminal/create":
        return this.need(this.deps.terminals, "Terminals").create(p);
      case "terminal/sendText":
        return this.need(this.deps.terminals, "Terminals").sendText(p);
      case "tasks/execute":
        return this.need(this.deps.tasks, "Tasks").execute(p);
      case "ui/showTextDocument":
        await this.need(this.deps.showTextDocument, "Opening documents")(
          text(p.path),
          p.preserveFocus === true,
        );
        return { ok: true };
      case "ui/showVirtualDocument":
        await this.need(
          this.deps.showVirtualDocument,
          "Opening documents",
        )({
          extension: text(p.extension),
          uri: text(p.uri),
          scheme: text(p.scheme),
          path: text(p.path),
          text: text(p.text),
          languageId: text(p.languageId) || "plaintext",
          readonly: p.readonly !== false,
        });
        return { ok: true };
      case "workspace/saveDocument":
        return {
          saved: await this.need(
            this.deps.saveDocument,
            "Saving",
          )(text(p.path)),
        };
      case "workspace/saveAll":
        return { saved: await this.need(this.deps.saveAll, "Saving")() };
      default:
        throw new Error(`Not an allowed extension host request: ${method}`);
    }
  }

  handleNotification(method: string, params: unknown): void {
    const p = record(params);
    switch (method) {
      case "quickInput/set":
        this.deps.prompts.setQuickInput(p as unknown as DynamicQuickInput, event => {
          void this.deps.hostRequest("host/quickInputEvent", event).catch((error: unknown) => { this.log(text(p.extension), "Quick input", String(error)); });
        });
        return;
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
      case "languages/changed":
        this.providerChanges.get(text(p.handle))?.();
        return;
      case "languages/unregistered":
        this.providers.get(text(p.handle))?.();
        this.providers.delete(text(p.handle));
        return;
      case "diagnostics/set":
        this.deps.setDiagnostics(
          text(p.collection),
          text(p.path),
          Array.isArray(p.diagnostics)
            ? (p.diagnostics as HostDiagnostic[])
            : [],
        );
        return;
      case "editor/setSelections":
        this.deps.editorApi?.setSelections(p);
        return;
      case "editor/setOptions":
        this.deps.editorApi?.setOptions(p);
        return;
      case "editor/revealRange":
        this.deps.editorApi?.revealRange(p);
        return;
      case "workspace/virtualDocumentChanged":
        this.deps.updateVirtualDocument?.({
          extension: text(p.extension),
          uri: text(p.uri),
          scheme: text(p.scheme),
          path: text(p.path),
          text: text(p.text),
          languageId: text(p.languageId) || "plaintext",
          readonly: true,
        });
        return;
      case "terminal/ptyWrite":
        this.deps.terminals?.ptyWrite(p);
        return;
      case "terminal/ptyExit":
        this.deps.terminals?.ptyExit(p);
        return;
      case "terminal/show":
        this.deps.terminals?.show(p);
        return;
      case "terminal/dispose":
        void this.deps.terminals?.dispose(p);
        return;
      case "tasks/customOutput":
        this.deps.tasks?.customOutput(p);
        return;
      case "tasks/customFinished":
        this.deps.tasks?.customFinished(p);
        return;
      case "tasks/terminate":
        void this.deps.tasks?.terminate(p);
        return;
      default:
        if (method.startsWith("views/")) this.deps.onViewEvent?.(method, p);
        else if (method.startsWith("statusBar/"))
          this.deps.onStatusBarEvent?.(method, p);
        else if (method.startsWith("webview/"))
          this.deps.onWebviewEvent?.(method, p);
        else if (method.startsWith("workbench/"))
          this.deps.onWorkbenchEvent?.(method, p);
    }
  }

  private need<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`${what} isn't available here.`);
    return value;
  }

  private editorApi(): ExtensionEditorService {
    if (!this.deps.editorApi) throw new Error("Editing isn't available here.");
    return this.deps.editorApi;
  }

  /** The host went away: what it had registered is gone with it. */
  reset(): void {
    for (const dispose of this.providers.values()) dispose();
    this.providers.clear();
    this.providerChanges.clear();
    this.hostCommands.clear();
    this.deps.prompts.dismissAll();
    this.deps.terminals?.reset();
    this.deps.tasks?.reset();
    this.deps.onHostCommandsChanged();
    this.deps.onViewEvent?.("views/reset", {});
    this.deps.onStatusBarEvent?.("statusBar/reset", {});
    this.deps.onWebviewEvent?.("webview/reset", {});
    this.deps.onWorkbenchEvent?.("workbench/reset", {});
  }

  private log(extension: string, channel: string, line: string): void {
    const name = channelName(channel);
    const tagged =
      name === HOST_CHANNEL && extension !== ""
        ? `[${extension}] ${line}`
        : line;
    this.deps.output.append(name, tagged);
  }

  private showMessage(p: Record<string, unknown>): Promise<string | null> {
    const severity =
      p.severity === "warning" || p.severity === "error" ? p.severity : "info";
    return this.deps.prompts.showMessage({
      extension: text(p.extension),
      severity,
      message: text(p.message),
      items: Array.isArray(p.items) ? p.items.map(String) : [],
    });
  }

  private registerProvider(registration: ProviderRegistration): void {
    // A host restart or duplicate registration can reuse a handle. Dispose the
    // previous Monaco/formatter binding before installing its replacement.
    this.providers.get(registration.handle)?.();
    this.providers.delete(registration.handle);
    const invoke: ProviderInvoke = async (payload, token) => {
      if (token?.isCancellationRequested) return null;
      const requestId = `${registration.handle}:${++this.nextProviderRequest}`;
      const pending = this.deps.hostRequest("host/provide", {
        handle: registration.handle,
        ...payload,
        requestId,
      });
      const cancel = () => {
        void this.deps
          .hostRequest("host/cancelProvide", { requestId })
          .catch(() => undefined);
      };
      const subscription = token?.onCancellationRequested(cancel);
      if (token?.isCancellationRequested) cancel();
      try {
        const result = await pending;
        return token?.isCancellationRequested ? null : result;
      } finally {
        subscription?.dispose();
      }
    };
    const listeners = new Set<() => void>();
    invoke.onDidChange = (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    };
    this.providerChanges.set(registration.handle, () => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error("Extension provider refresh failed", error);
        }
      }
    });
    const formatting =
      registration.kind === "formatting" ||
      registration.kind === "rangeFormatting";
    if (formatting && !this.deps.registerFormatter) {
      this.providerChanges.delete(registration.handle);
      return;
    }
    const dispose =
      formatting && this.deps.registerFormatter
        ? this.deps.registerFormatter(registration, invoke)
        : this.deps.registerProvider(registration, invoke);
    this.providers.set(registration.handle, () => {
      listeners.clear();
      this.providerChanges.delete(registration.handle);
      dispose();
    });
  }
}
