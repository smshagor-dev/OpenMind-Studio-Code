import * as monaco from "monaco-editor";

import type { DocumentService } from "./documentService";
import type { IpcClient } from "./ipc";
import type { LspAction } from "./lspAvailability";
import {
  convertCompletionList,
  convertHover,
  convertLocations,
  convertSignatureHelp,
  convertSymbols,
  convertTextEdits,
  convertWorkspaceEdit,
  toLspPosition,
  toMonacoRange,
  type LspCompletionItem,
  type LspLocation,
} from "./lspConvert";
import { LSP_MONACO_LANGUAGES, lspLanguageId, monacoLanguageFor } from "./lspLanguages";
import type { LspService } from "./lspService";
import { pathToUri } from "./lspUri";
import { pathKey } from "./textSync";
import type { RevealTarget, WorkspaceService } from "./workspaceService";

export interface ProviderDeps {
  ipc: IpcClient;
  documents: DocumentService;
  workspace: WorkspaceService;
  lsp: LspService;
}

/** A document the request is about, once the server for it can take the request. */
interface Target {
  id: string;
  path: string;
  uri: string;
}

function targetOf(
  deps: ProviderDeps,
  model: monaco.editor.ITextModel,
  action: LspAction,
): Target | null {
  const id = deps.documents.idForModelUri(model.uri.toString());
  if (id === undefined || !deps.lsp.available(action, id).enabled) return null;
  const path = deps.documents.snapshot(id).path;
  return path === null ? null : { id, path, uri: pathToUri(path) };
}

/** Sends one request, after the server has the text as it is now. A failed request is "no answer". */
async function ask(
  deps: ProviderDeps,
  target: Target,
  method: string,
  params: Record<string, unknown>,
  token?: monaco.CancellationToken,
): Promise<unknown> {
  await deps.lsp.flush(target.id);
  try {
    const result = await deps.ipc.lspRequest(target.path, method, {
      textDocument: { uri: target.uri },
      ...params,
    });
    return token?.isCancellationRequested === true ? null : result;
  } catch {
    return null;
  }
}

function positionParams(position: monaco.Position): {
  position: { line: number; character: number };
} {
  return { position: toLspPosition(position) };
}

// --- Files that aren't open, shown in Peek ---

const MAX_PEEK_MODELS = 40;

/**
 * Peek (references, several definitions) needs a Monaco model for every file it
 * lists. Files that are open already have theirs; the others get a read-only
 * copy here — not a document, no tab — which is dropped again when there are too
 * many or the workspace changes.
 */
export class PeekModels {
  private readonly models = new Map<string, monaco.editor.ITextModel>();

  constructor(private readonly ipc: IpcClient) {}

  async uriFor(path: string): Promise<monaco.Uri | null> {
    const key = pathKey(path);
    const existing = this.models.get(key);
    if (existing && !existing.isDisposed()) return existing.uri;
    let disk;
    try {
      disk = await this.ipc.documentRead(path);
    } catch {
      return null;
    }
    if (disk.state !== "file") return null;
    const uri = monaco.Uri.file(path);
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(
        disk.content,
        monacoLanguageFor(lspLanguageId(path) ?? "plaintext"),
        uri,
      );
    this.models.set(key, model);
    while (this.models.size > MAX_PEEK_MODELS) {
      const oldest = this.models.keys().next();
      if (oldest.done) break;
      this.models.get(oldest.value)?.dispose();
      this.models.delete(oldest.value);
    }
    return uri;
  }

  disposeAll(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
  }
}

async function toMonacoLocations(
  deps: ProviderDeps,
  peek: PeekModels,
  locations: LspLocation[],
): Promise<monaco.languages.Location[]> {
  const out: monaco.languages.Location[] = [];
  for (const location of locations) {
    const id = deps.documents.idForPath(location.path);
    const modelUri = id === null ? null : deps.documents.modelUri(id);
    const uri = modelUri !== null ? monaco.Uri.parse(modelUri) : await peek.uriFor(location.path);
    if (uri !== null) out.push({ uri, range: toMonacoRange(location.range) });
  }
  return out;
}

// --- The providers ---

const COMPLETION_TRIGGERS = [".", ":", "<", '"', "'", "/", "@", "$", ">", "\\", "-", "#"];

export function createHoverProvider(deps: ProviderDeps): monaco.languages.HoverProvider {
  return {
    async provideHover(model, position, token) {
      const target = targetOf(deps, model, "hover");
      if (!target) return null;
      return convertHover(
        await ask(deps, target, "textDocument/hover", positionParams(position), token),
      );
    },
  };
}

export function createCompletionProvider(
  deps: ProviderDeps,
): monaco.languages.CompletionItemProvider {
  let lastPath: string | null = null;
  return {
    triggerCharacters: COMPLETION_TRIGGERS,
    async provideCompletionItems(model, position, context, token) {
      const target = targetOf(deps, model, "completion");
      if (!target) return { suggestions: [] };
      lastPath = target.path;
      const word = model.getWordUntilPosition(position);
      const defaultRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const result = await ask(
        deps,
        target,
        "textDocument/completion",
        {
          ...positionParams(position),
          context: {
            triggerKind: context.triggerKind + 1,
            triggerCharacter: context.triggerCharacter,
          },
        },
        token,
      );
      return convertCompletionList(result, defaultRange);
    },
    async resolveCompletionItem(item, token) {
      const raw = (item as LspCompletionItem).lspItem;
      const id = lastPath === null ? null : deps.documents.idForPath(lastPath);
      if (raw === undefined || lastPath === null || id === null) return item;
      const server = deps.lsp.serverForPath(lastPath);
      if (!server?.capabilities?.completionResolve) return item;
      try {
        const resolved = await deps.ipc.lspRequest(lastPath, "completionItem/resolve", raw);
        if (token.isCancellationRequested) return item;
        const converted = convertCompletionList([resolved], item.range as monaco.IRange)
          .suggestions[0];
        return converted
          ? {
              ...item,
              detail: converted.detail ?? item.detail,
              documentation: converted.documentation ?? item.documentation,
            }
          : item;
      } catch {
        return item;
      }
    },
  };
}

export function createSignatureProvider(
  deps: ProviderDeps,
): monaco.languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, position, token) {
      const target = targetOf(deps, model, "signatureHelp");
      if (!target) return null;
      const result = convertSignatureHelp(
        await ask(deps, target, "textDocument/signatureHelp", positionParams(position), token),
      );
      return result === null ? null : { value: result, dispose: () => undefined };
    },
  };
}

type LocationMethod =
  | "textDocument/definition"
  | "textDocument/declaration"
  | "textDocument/typeDefinition"
  | "textDocument/implementation";

type LocationProvider = monaco.languages.DefinitionProvider &
  monaco.languages.DeclarationProvider &
  monaco.languages.TypeDefinitionProvider &
  monaco.languages.ImplementationProvider;

/** Definition, declaration, type definition and implementation providers differ only in the method. */
export function createLocationProvider(
  deps: ProviderDeps,
  peek: PeekModels,
  action: LspAction,
  method: LocationMethod,
): LocationProvider {
  const provide = async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Location[] | null> => {
    const target = targetOf(deps, model, action);
    if (!target) return null;
    const result = await ask(deps, target, method, positionParams(position), token);
    return toMonacoLocations(deps, peek, convertLocations(result));
  };
  return {
    provideDefinition: provide,
    provideDeclaration: provide,
    provideTypeDefinition: provide,
    provideImplementation: provide,
  };
}

export function createReferenceProvider(
  deps: ProviderDeps,
  peek: PeekModels,
): monaco.languages.ReferenceProvider {
  return {
    async provideReferences(model, position, context, token) {
      const target = targetOf(deps, model, "references");
      if (!target) return null;
      const result = await ask(
        deps,
        target,
        "textDocument/references",
        {
          ...positionParams(position),
          context: { includeDeclaration: context.includeDeclaration },
        },
        token,
      );
      return toMonacoLocations(deps, peek, convertLocations(result));
    },
  };
}

/** The word under the cursor, when the server can't say what is renameable. */
function wordRange(model: monaco.editor.ITextModel, position: monaco.Position) {
  const word = model.getWordAtPosition(position);
  return word
    ? {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        },
        text: word.word,
      }
    : null;
}

export function createRenameProvider(deps: ProviderDeps): monaco.languages.RenameProvider {
  return {
    async resolveRenameLocation(model, position, token) {
      const target = targetOf(deps, model, "rename");
      if (!target)
        return {
          range: model.getFullModelRange(),
          text: "",
          rejectReason: "Rename isn't available here.",
        };
      const server = deps.lsp.serverForPath(target.path);
      const fallback = wordRange(model, position);
      if (!server?.capabilities?.prepareRename) {
        return (
          fallback ?? {
            range: model.getFullModelRange(),
            text: "",
            rejectReason: "There is no symbol here to rename.",
          }
        );
      }
      const result = (await ask(
        deps,
        target,
        "textDocument/prepareRename",
        positionParams(position),
        token,
      )) as { range?: unknown; placeholder?: string; start?: unknown } | null;
      if (result === null) {
        return {
          range: model.getFullModelRange(),
          text: "",
          rejectReason: "You cannot rename this element.",
        };
      }
      const range = "start" in result && result.start !== undefined ? result : result.range;
      if (range === undefined)
        return (
          fallback ?? {
            range: model.getFullModelRange(),
            text: "",
            rejectReason: "You cannot rename this element.",
          }
        );
      const monacoRange = toMonacoRange(range as Parameters<typeof toMonacoRange>[0]);
      return { range: monacoRange, text: result.placeholder ?? model.getValueInRange(monacoRange) };
    },
    async provideRenameEdits(model, position, newName, token) {
      const target = targetOf(deps, model, "rename");
      if (!target) return { edits: [], rejectReason: "Rename isn't available here." };
      await deps.lsp.flush(target.id);
      let result: unknown;
      try {
        result = await deps.ipc.lspRequest(target.path, "textDocument/rename", {
          textDocument: { uri: target.uri },
          ...positionParams(position),
          newName,
        });
      } catch (error) {
        throw new Error(String(error), { cause: error });
      }
      if (token.isCancellationRequested) return { edits: [] };
      const converted = convertWorkspaceEdit(result);
      if (converted.unsupported !== null) throw new Error(converted.unsupported);
      const edits: monaco.languages.IWorkspaceTextEdit[] = [];
      const activeTab = deps.workspace.getState().activeId;
      for (const file of converted.files) {
        let id = deps.documents.idForPath(file.path);
        if (id === null) {
          // The edit is applied to the file's editor buffer (left unsaved, like any edit); opening it makes that possible.
          await deps.workspace.openPath(file.path, { kind: "text" });
          id = deps.documents.idForPath(file.path);
        }
        const uri = id === null ? null : deps.documents.modelUri(id);
        if (uri === null) throw new Error(`Couldn't open ${file.path} to apply the rename.`);
        for (const edit of file.edits) {
          edits.push({
            resource: monaco.Uri.parse(uri),
            versionId: undefined,
            textEdit: { range: toMonacoRange(edit.range), text: edit.newText },
          });
        }
      }
      // Opening files for the rename must not leave the user looking at a different one.
      if (activeTab !== null) deps.workspace.setActive(activeTab);
      return { edits };
    },
  };
}

export function createFormattingProvider(
  deps: ProviderDeps,
): monaco.languages.DocumentFormattingEditProvider {
  return {
    displayName: "Language Server",
    async provideDocumentFormattingEdits(model, options, token) {
      const target = targetOf(deps, model, "formatting");
      if (!target) return null;
      const result = await ask(
        deps,
        target,
        "textDocument/formatting",
        { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
        token,
      );
      return convertTextEdits(result);
    },
  };
}

export function createRangeFormattingProvider(
  deps: ProviderDeps,
): monaco.languages.DocumentRangeFormattingEditProvider {
  return {
    displayName: "Language Server",
    async provideDocumentRangeFormattingEdits(model, range, options, token) {
      const target = targetOf(deps, model, "formatting");
      if (!target) return null;
      const server = deps.lsp.serverForPath(target.path);
      if (!server?.capabilities?.rangeFormatting) return null;
      const result = await ask(
        deps,
        target,
        "textDocument/rangeFormatting",
        {
          range: {
            start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        },
        token,
      );
      return convertTextEdits(result);
    },
  };
}

export function createSymbolProvider(deps: ProviderDeps): monaco.languages.DocumentSymbolProvider {
  return {
    displayName: "Language Server",
    async provideDocumentSymbols(model, token) {
      const target = targetOf(deps, model, "documentSymbol");
      if (!target) return null;
      return convertSymbols(await ask(deps, target, "textDocument/documentSymbol", {}, token));
    },
  };
}

// --- Opening what a location points at ---

function revealTargetOf(selection: monaco.IRange | monaco.IPosition | undefined): RevealTarget {
  if (selection === undefined) return { line: 1, column: 1, length: 0 };
  if ("startLineNumber" in selection) {
    return {
      line: selection.startLineNumber,
      column: selection.startColumn,
      length:
        selection.endLineNumber === selection.startLineNumber
          ? selection.endColumn - selection.startColumn
          : 0,
    };
  }
  return { line: selection.lineNumber, column: selection.column, length: 0 };
}

/**
 * Go to Definition and friends ask Monaco to open a file at a position. Monaco's own
 * way would swap the model into the current editor without touching the tabs;
 * this sends it through the workbench instead (an open file's tab, or the file opened in a new one).
 */
export function createOpener(deps: ProviderDeps): monaco.editor.ICodeEditorOpener {
  return {
    openCodeEditor(_source, resource, selection) {
      const target = revealTargetOf(selection);
      const id = deps.documents.idForModelUri(resource.toString());
      if (id !== undefined) {
        deps.workspace.openDocumentAt(id, target);
        return true;
      }
      if (resource.scheme === "file") {
        void deps.workspace.openPathAt(resource.fsPath, target);
        return true;
      }
      return false;
    },
  };
}

/** Registers every provider for every language a server can handle. Returns one disposable that undoes it all. */
export function registerLspProviders(deps: ProviderDeps): {
  dispose: () => void;
  peek: PeekModels;
} {
  const peek = new PeekModels(deps.ipc);
  const disposables: monaco.IDisposable[] = [
    monaco.editor.registerEditorOpener(createOpener(deps)),
  ];
  for (const language of LSP_MONACO_LANGUAGES) {
    disposables.push(
      monaco.languages.registerHoverProvider(language, createHoverProvider(deps)),
      monaco.languages.registerCompletionItemProvider(language, createCompletionProvider(deps)),
      monaco.languages.registerSignatureHelpProvider(language, createSignatureProvider(deps)),
      monaco.languages.registerDefinitionProvider(
        language,
        createLocationProvider(deps, peek, "definition", "textDocument/definition"),
      ),
      monaco.languages.registerDeclarationProvider(
        language,
        createLocationProvider(deps, peek, "declaration", "textDocument/declaration"),
      ),
      monaco.languages.registerTypeDefinitionProvider(
        language,
        createLocationProvider(deps, peek, "typeDefinition", "textDocument/typeDefinition"),
      ),
      monaco.languages.registerImplementationProvider(
        language,
        createLocationProvider(deps, peek, "implementation", "textDocument/implementation"),
      ),
      monaco.languages.registerReferenceProvider(language, createReferenceProvider(deps, peek)),
      monaco.languages.registerRenameProvider(language, createRenameProvider(deps)),
      // Formatting (document and selection) is not registered with Monaco: Format Document / Format Selection are the
      // app's own commands (FormattingService), which use the language server through `createFormattingProvider` and
      // `createRangeFormattingProvider`. Registered providers would add a second, native "Format Document" to the menu.
      monaco.languages.registerDocumentSymbolProvider(language, createSymbolProvider(deps)),
    );
  }
  return {
    peek,
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
      peek.disposeAll();
    },
  };
}
