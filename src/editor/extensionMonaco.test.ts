import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeDeps, ProviderRegistration } from "../services/extensionHostBridge";
import { HostBridge } from "../services/extensionHostBridge";
import { registerHostProvider } from "./extensionMonaco";

const mocked = vi.hoisted(() => ({
  providers: new Map<string, { selector: unknown; provider: unknown; dispose: ReturnType<typeof vi.fn> }>(),
}));

vi.mock("monaco-editor", () => {
  const register = (kind: string) => (selector: unknown, provider: unknown) => {
    const dispose = vi.fn();
    mocked.providers.set(kind, { selector, provider, dispose });
    return { dispose };
  };
  return {
    Uri: { file: (path: string) => ({ path, scheme: "file" }), parse: (value: string) => ({ value, scheme: value.split(":")[0] }) },
    languages: {
      CompletionItemKind: { Snippet: 28 }, DocumentHighlightKind: { Text: 0 }, SymbolTag: { Deprecated: 1 },
      FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
      registerDefinitionProvider: register("definition"),
      registerTypeDefinitionProvider: register("typeDefinition"),
      registerImplementationProvider: register("implementation"),
      registerReferenceProvider: register("reference"),
      registerDocumentHighlightProvider: register("highlight"),
      registerDocumentSymbolProvider: register("documentSymbol"),
      registerFoldingRangeProvider: register("folding"),
    },
  };
});

interface RpcFixture {
  request(method: string, params?: unknown): Promise<unknown>;
  messages: { method?: string; params: unknown }[];
}
const require = createRequire(import.meta.url);
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as {
  fixture(t: { after(callback: () => Promise<void>): void }, definitions: Record<string, { code: string; permissions: string[] }>): Promise<RpcFixture>;
};
const workspace = path.resolve("provider-workspace").replaceAll("\\", "/");
const file = path.join(workspace, "main.js");
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => mocked.providers.clear());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const methods = {
  definition: "provideDefinition", typeDefinition: "provideTypeDefinition", implementation: "provideImplementation",
  reference: "provideReferences", highlight: "provideDocumentHighlights", documentSymbol: "provideDocumentSymbols", folding: "provideFoldingRanges",
} as const;

function provider(kind: keyof typeof methods) {
  const registered = mocked.providers.get(kind);
  if (!registered) throw new Error(`Missing Monaco ${kind} registration`);
  const invoke = (registered.provider as Record<string, (...args: unknown[]) => Promise<unknown>>)[methods[kind]];
  if (!invoke) throw new Error(`Missing Monaco ${kind} callback`);
  return invoke;
}

async function integrated(code: string) {
  const host = await fixture({ after: callback => cleanups.push(callback) }, {
    "test.monaco": { permissions: ["languages"], code: code.replaceAll("/workspace", workspace) },
  });
  await host.request("host/init", { documents: [{ path: file, languageId: "javascript", version: 1, text: "const value = 1;" }] });
  const bridge = new HostBridge({
    hostRequest: (method, params) => host.request(method, params),
    registerProvider: (registration, invoke) => registerHostProvider(registration, invoke, () => file),
  } as BridgeDeps);
  await host.request("host/activate", { id: "test.monaco" });
  for (const message of host.messages) {
    if (message.method === "languages/registered") bridge.handleNotification(message.method, message.params);
  }
  return { host, bridge };
}

describe("extension language providers through the real stdio host and UI bridge", () => {
  it("maps navigation, references, highlights, symbols and folding into Monaco registrations", async () => {
    const { host, bridge } = await integrated(`const vscode = require('vscode');
      exports.activate = () => {
        const selector = { language: 'javascript', scheme: 'file', pattern: new vscode.RelativePattern('/workspace', '*.js') };
        const range = new vscode.Range(0, 1, 0, 8);
        const link = { targetUri: vscode.Uri.parse('memory:/target'), targetRange: range, targetSelectionRange: range, originSelectionRange: range };
        for (const [registration, method] of [['registerDefinitionProvider','provideDefinition'], ['registerTypeDefinitionProvider','provideTypeDefinition'], ['registerImplementationProvider','provideImplementation']]) {
          vscode.languages[registration](selector, { [method]: () => [link] });
        }
        vscode.languages.registerReferenceProvider(selector, { provideReferences(doc, position, context) {
          if (position.character !== 2 || !context.includeDeclaration) throw Error('Lost reference context');
          return [new vscode.Location(vscode.Uri.file('/workspace/ref.js'), range)];
        } });
        vscode.languages.registerDocumentHighlightProvider(selector, { provideDocumentHighlights: () => [new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Read)] });
        vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: () => {
          const root = new vscode.DocumentSymbol('root', '', vscode.SymbolKind.Function, range, range);
          root.children = [new vscode.DocumentSymbol('child', '', vscode.SymbolKind.Variable, range, range)];
          return [root];
        } });
        vscode.languages.registerFoldingRangeProvider(selector, { provideFoldingRanges: () => [new vscode.FoldingRange(0, 4, vscode.FoldingRangeKind.Region)] });
      };`);
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const position = { lineNumber: 1, column: 3 };
    for (const kind of ["definition", "typeDefinition", "implementation"] as const) {
      const result = await provider(kind)({}, position, token);
      expect(result).toEqual([expect.objectContaining({
        uri: { value: expect.stringMatching(/^memory:\/+target$/), scheme: "memory" },
        range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 9 },
        targetSelectionRange: expect.objectContaining({ startColumn: 2 }),
        originSelectionRange: expect.objectContaining({ endColumn: 9 }),
      })]);
    }
    expect(await provider("reference")({}, position, { includeDeclaration: true }, token)).toEqual([
      expect.objectContaining({ uri: expect.objectContaining({ scheme: "file", value: expect.stringMatching(/\/ref\.js$/) }) }),
    ]);
    expect(await provider("highlight")({}, position, token)).toEqual([
      expect.objectContaining({ kind: 1, range: expect.objectContaining({ startColumn: 2 }) }),
    ]);
    expect(await provider("documentSymbol")({}, token)).toEqual([
      expect.objectContaining({ name: "root", children: [expect.objectContaining({ name: "child" })] }),
    ]);
    expect(await provider("folding")({}, {}, token)).toEqual([{ start: 1, end: 5, kind: "region" }]);
    expect(mocked.providers.get("reference")?.selector).toEqual([
      { language: "javascript", scheme: "file", pattern: { base: workspace, pattern: "*.js" } },
    ]);
    await host.request("host/deactivate", { id: "test.monaco" });
    for (const message of host.messages) {
      if (message.method === "languages/unregistered") bridge.handleNotification(message.method, message.params);
    }
    for (const registration of mocked.providers.values()) expect(registration.dispose).toHaveBeenCalledOnce();
  });

  it("sends Monaco cancellation through the UI bridge to the extension and disposes the listener", async () => {
    const { host } = await integrated(`const vscode = require('vscode');
      exports.activate = () => vscode.languages.registerReferenceProvider('javascript', {
        provideReferences(doc, position, context, token) {
          console.log('provider-entered');
          return new Promise(resolve => token.onCancellationRequested(() => {
            console.log('provider-cancelled'); resolve([]);
          }));
        }
      });`);
    const dispose = vi.fn();
    let cancel: (() => void) | undefined;
    const token = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose }; } };
    const pending = provider("reference")({}, { lineNumber: 1, column: 1 }, { includeDeclaration: false }, token);
    token.isCancellationRequested = true;
    cancel?.();
    expect(await pending).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(host.messages.some(message => message.method === "log/output" && JSON.stringify(message.params).includes("provider-cancelled"))).toBe(true);
  });

  it("does not invoke cancelled requests or accidentally register unknown kinds as definitions", async () => {
    const invoke = vi.fn();
    const registration: ProviderRegistration = { handle: "test", extension: "test", kind: "reference", selector: [{ language: "javascript" }] };
    const dispose = registerHostProvider(registration, invoke, () => file);
    expect(await provider("reference")({}, { lineNumber: 1, column: 1 }, { includeDeclaration: false }, { isCancellationRequested: true })).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    dispose();
    registerHostProvider({ ...registration, kind: "future" as ProviderRegistration["kind"] }, invoke, () => null)();
    expect(mocked.providers.has("definition")).toBe(false);
  });
});
