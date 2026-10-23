import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeDeps, ProviderRegistration } from "../services/extensionHostBridge";
import { HostBridge } from "../services/extensionHostBridge";
import { registerHostProvider } from "./extensionMonaco";

const mocked = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
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
    editor: { registerCommand: (id: string, callback: (...args: unknown[]) => Promise<unknown>) => {
      mocked.commands.set(id, callback); return { dispose: () => mocked.commands.delete(id) };
    } },
    languages: {
      CompletionItemKind: { Snippet: 28 }, CompletionItemTag: { Deprecated: 1 }, CompletionItemInsertTextRule: { KeepWhitespace: 1 }, DocumentHighlightKind: { Text: 0 }, SymbolTag: { Deprecated: 1 },
      FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
      registerCompletionItemProvider: register("completion"),
      registerDefinitionProvider: register("definition"),
      registerTypeDefinitionProvider: register("typeDefinition"),
      registerImplementationProvider: register("implementation"),
      registerReferenceProvider: register("reference"),
      registerDocumentHighlightProvider: register("highlight"),
      registerDocumentSymbolProvider: register("documentSymbol"),
      registerFoldingRangeProvider: register("folding"),
      registerDeclarationProvider: register("declaration"),
      registerSignatureHelpProvider: register("signatureHelp"),
      registerSelectionRangeProvider: register("selectionRange"),
      registerLinkedEditingRangeProvider: register("linkedEditing"),
      registerOnTypeFormattingEditProvider: register("onTypeFormatting"),
      registerLinkProvider: register("documentLink"),
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
beforeEach(() => { mocked.providers.clear(); mocked.commands.clear(); });
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

async function integrated(code: string, permissions = ["languages"]) {
  const host = await fixture({ after: callback => cleanups.push(callback) }, {
    "test.monaco": { permissions, code: code.replaceAll("/workspace", workspace) },
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
  it("preserves completion context, incomplete results, ranges, snippets and lazy resolution", async () => {
    const { host, bridge } = await integrated(`const v = require('vscode'); let accepted; exports.activate = () => {
      v.commands.registerCommand('completion.accepted', value => { accepted = value; });
      v.commands.registerCommand('completion.result', () => accepted);
      v.languages.registerCompletionItemProvider('javascript', {
        provideCompletionItems(doc, position, token, context) {
          if (context.triggerKind !== 1 || context.triggerCharacter !== '.') throw new Error('Completion context lost');
          const item = new v.CompletionItem({ label: 'value', detail: ': number', description: 'example' }, v.CompletionItemKind.Variable);
          item.command = { command: 'completion.accepted', title: 'Accepted', arguments: [42] };
          item.privateState = 42; item.insertText = new v.SnippetString('value($1)'); item.keepWhitespace = true;
          item.range = { inserting: new v.Range(0,1,0,3), replacing: new v.Range(0,1,0,7) }; item.preselect = true;
          item.commitCharacters = [';']; item.tags = [1]; return new v.CompletionList([item], true);
        },
        resolveCompletionItem(item) {
          if (item.privateState !== 42) throw new Error('Original completion item lost');
          item.documentation = new v.MarkdownString('Resolved docs');
          item.additionalTextEdits = [v.TextEdit.insert(new v.Position(0,0), 'import example;')]; return item;
        }
      }, '.');
    };`, ['languages', 'commands']);
    const registered = mocked.providers.get('completion')?.provider as {
      triggerCharacters: string[];
      provideCompletionItems(...args: unknown[]): Promise<{ suggestions: { command: { id: string; arguments: unknown[] }; label: { label: string; detail: string }; insertTextRules: number; range: { insert: { endColumn: number }; replace: { endColumn: number } } }[]; incomplete: boolean; dispose(): void }>;
      resolveCompletionItem(...args: unknown[]): Promise<{ documentation: string; additionalTextEdits: { text: string; range: { startColumn: number } }[] }>;
    };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const list = await registered.provideCompletionItems({ getWordUntilPosition: () => ({ startColumn: 2, endColumn: 4 }) }, { lineNumber: 1, column: 4 }, { triggerKind: 1, triggerCharacter: '.' }, token);
    expect(registered.triggerCharacters).toEqual(['.']); expect(list.incomplete).toBe(true);
    expect(list.suggestions[0]?.label).toEqual({ label: 'value', detail: ': number', description: 'example' });
    expect(list.suggestions[0]?.insertTextRules).toBe(5); expect(list.suggestions[0]?.range.insert.endColumn).toBe(4); expect(list.suggestions[0]?.range.replace.endColumn).toBe(8);
    const resolved = await registered.resolveCompletionItem(list.suggestions[0], token);
    expect(resolved.documentation).toBe('Resolved docs'); expect(resolved.additionalTextEdits[0]?.text).toBe('import example;'); expect(resolved.additionalTextEdits[0]?.range.startColumn).toBe(1);
    const completionCommand = list.suggestions[0]?.command; if (!completionCommand) throw new Error("Missing completion command");
    await mocked.commands.get(completionCommand.id)?.({}, ...completionCommand.arguments);
    expect(await host.request('host/executeCommand', { command: 'completion.result' })).toBe(42);
    list.dispose();
    await host.request('host/deactivate', { id: 'test.monaco' });
    for (const message of host.messages) if (message.method === 'languages/unregistered') bridge.handleNotification(message.method, message.params);
    expect(mocked.providers.get('completion')?.dispose).toHaveBeenCalledOnce(); expect(mocked.commands.size).toBe(0);
  });

  it("connects declaration, signatures, selections, linked editing, on-type formatting and lazy links", async () => {
    const { host, bridge } = await integrated(`const v = require('vscode'); exports.activate = () => {
      const range = new v.Range(0, 1, 0, 4); const selector = 'javascript';
      v.languages.registerDeclarationProvider(selector, { provideDeclaration: () => new v.Location(v.Uri.parse('memory:/declaration'), range) });
      v.languages.registerSignatureHelpProvider(selector, { provideSignatureHelp(doc, position, token, context) {
        if (position.character !== 3 || context.triggerCharacter !== '(' || !context.isRetrigger) throw new Error('Signature context was lost');
        const result = new v.SignatureHelp(); const signature = new v.SignatureInformation('run(value)', 'Signature docs');
        signature.parameters = [new v.ParameterInformation([4,9], 'Argument docs')]; result.signatures = [signature]; return result;
      } }, { triggerCharacters: ['('], retriggerCharacters: [','] });
      v.languages.registerSelectionRangeProvider(selector, { provideSelectionRanges(doc, positions) {
        return positions.map(position => new v.SelectionRange(new v.Range(position, position), new v.SelectionRange(new v.Range(0,0,0,15))));
      } });
      v.languages.registerLinkedEditingRangeProvider(selector, { provideLinkedEditingRanges: () => new v.LinkedEditingRanges([range, new v.Range(0,8,0,11)], /[a-z]+/i) });
      v.languages.registerOnTypeFormattingEditProvider(selector, { provideOnTypeFormattingEdits(doc, position, character, options) {
        if (character !== ';' || options.tabSize !== 2 || position.character !== 3) throw new Error('Formatting context lost');
        return [new v.TextEdit(range, 'formatted')];
      } }, ';', '}');
      v.languages.registerDocumentLinkProvider(selector, {
        provideDocumentLinks: () => [new v.DocumentLink(range)],
        resolveDocumentLink(link) { link.target = v.Uri.parse('https://example.test/resolved'); link.tooltip = 'Resolved by extension'; return link; }
      });
    };`);
    const callback = (kind: string, method: string) => {
      const value = mocked.providers.get(kind)?.provider as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
      const invoke = value?.[method]; if (!invoke) throw new Error(`Missing ${kind}.${method}`); return invoke;
    };
    const model = {}; const position = { lineNumber: 1, column: 4 };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const declaration = await callback('declaration', 'provideDeclaration')(model, position, token) as { uri: { scheme: string }; range: { startColumn: number } }[];
    expect(declaration[0]?.uri.scheme).toBe('memory'); expect(declaration[0]?.range.startColumn).toBe(2);
    const signature = await callback('signatureHelp', 'provideSignatureHelp')(model, position, token, { triggerKind: 2, triggerCharacter: '(', isRetrigger: true }) as { value: { signatures: { parameters: { label: number[] }[] }[] }; dispose(): void };
    expect(signature.value.signatures[0]?.parameters[0]?.label).toEqual([4,9]); signature.dispose();
    const metadata = mocked.providers.get('signatureHelp')?.provider as { signatureHelpTriggerCharacters: string[]; signatureHelpRetriggerCharacters: string[] };
    expect(metadata.signatureHelpTriggerCharacters).toEqual(['(']); expect(metadata.signatureHelpRetriggerCharacters).toEqual([',']);
    const selections = await callback('selectionRange', 'provideSelectionRanges')(model, [position], token) as { range: { startColumn: number; endColumn: number } }[][];
    expect(selections[0]).toHaveLength(2); expect(selections[0]?.[0]?.range.startColumn).toBe(4); expect(selections[0]?.[1]?.range.endColumn).toBe(16);
    const linked = await callback('linkedEditing', 'provideLinkedEditingRanges')(model, position, token) as { ranges: { startColumn: number }[]; wordPattern: RegExp };
    expect(linked.ranges[1]?.startColumn).toBe(9); expect(linked.wordPattern.test('ABC')).toBe(true);
    const edits = await callback('onTypeFormatting', 'provideOnTypeFormattingEdits')(model, position, ';', { tabSize: 2, insertSpaces: true }, token) as { range: { startColumn: number }; text: string }[];
    expect(edits[0]?.text).toBe('formatted'); expect(edits[0]?.range.startColumn).toBe(2);
    const links = await callback('documentLink', 'provideLinks')(model, token) as { links: { url?: string }[]; dispose(): void };
    expect(links.links[0]?.url).toBeUndefined();
    const resolved = await callback('documentLink', 'resolveLink')(links.links[0], token) as { url: string; tooltip: string };
    expect(resolved.url).toBe('https://example.test/resolved'); expect(resolved.tooltip).toBe('Resolved by extension');
    links.dispose(); expect(await callback('documentLink', 'resolveLink')(links.links[0], token)).toBeNull();
    await host.request("host/deactivate", { id: "test.monaco" });
    for (const message of host.messages) if (message.method === "languages/unregistered") bridge.handleNotification(message.method, message.params);
    for (const value of mocked.providers.values()) expect(value.dispose).toHaveBeenCalledOnce();
  });

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
