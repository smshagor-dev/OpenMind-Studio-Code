import * as monaco from "monaco-editor";

import { t } from "../i18n";
import { convertWorkspaceEdit, toMonacoRange, type ConvertedWorkspaceEdit } from "./lspConvert";
import { LSP_MONACO_LANGUAGES } from "./lspLanguages";
import type { ProviderDeps } from "./lspProviders";
import { pathToUri } from "./lspUri";

/** The Monaco command every server code action runs through (so its edits go to the editor's buffers). */
export const APPLY_CODE_ACTION = "openmind.lsp.applyCodeAction";

export interface CodeActionDeps extends ProviderDeps {
  /** Asked before an edit that changes more than one file; the answer is whether to go on. */
  confirmFiles: (paths: string[]) => Promise<boolean>;
  /** A failure the user should see. */
  report: (message: string) => void;
}

interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: unknown;
  command?: LspCommand;
  data?: unknown;
}

export interface CodeActionPayload {
  path: string;
  item: LspCodeAction | LspCommand;
}

const EMPTY: monaco.languages.CodeActionList = { actions: [], dispose() {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCommand(value: unknown): value is LspCommand {
  return isRecord(value) && typeof value.command === "string" && typeof value.title === "string";
}

function isCodeAction(value: unknown): value is LspCodeAction {
  return isRecord(value) && typeof value.title === "string" && !isCommand(value);
}

function lspSeverity(severity: monaco.MarkerSeverity): number {
  switch (severity) {
    case monaco.MarkerSeverity.Warning:
      return 2;
    case monaco.MarkerSeverity.Info:
      return 3;
    case monaco.MarkerSeverity.Hint:
      return 4;
    default:
      return 1;
  }
}

/** Monaco markers back to LSP diagnostics (quick fixes are matched against the server's own diagnostics). */
export function markerDiagnostics(markers: monaco.editor.IMarkerData[]): unknown[] {
  return markers.map((marker) => ({
    range: {
      start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
    },
    severity: lspSeverity(marker.severity),
    message: marker.message,
    ...(marker.source ? { source: marker.source } : {}),
    ...(marker.code === undefined
      ? {}
      : { code: typeof marker.code === "string" ? marker.code : marker.code.value }),
  }));
}

/** A server's answer as Monaco code actions; each runs `APPLY_CODE_ACTION` with the server's own item. */
export function toMonacoActions(path: string, result: unknown): monaco.languages.CodeAction[] {
  if (!Array.isArray(result)) return [];
  const actions: monaco.languages.CodeAction[] = [];
  for (const item of result as unknown[]) {
    if (!isCommand(item) && !isCodeAction(item)) continue;
    const action = item as LspCodeAction;
    const payload: CodeActionPayload = { path, item };
    actions.push({
      title: action.title,
      ...(action.kind ? { kind: action.kind } : {}),
      ...(action.isPreferred ? { isPreferred: true } : {}),
      ...(action.disabled?.reason ? { disabled: action.disabled.reason } : {}),
      command: { id: APPLY_CODE_ACTION, title: action.title, arguments: [payload] },
    });
  }
  return actions;
}

export function createCodeActionProvider(deps: CodeActionDeps): monaco.languages.CodeActionProvider {
  return {
    async provideCodeActions(model, range, context, token) {
      const id = deps.documents.idForModelUri(model.uri.toString());
      if (id === undefined || !deps.lsp.available("codeAction", id).enabled) return EMPTY;
      // The light bulb asks on every cursor move: then only quick fixes for the problems under the cursor.
      const automatic = context.trigger === monaco.languages.CodeActionTriggerType.Auto;
      if (automatic && context.markers.length === 0) return EMPTY;
      const path = deps.documents.snapshot(id).path;
      if (path === null) return EMPTY;
      await deps.lsp.flush(id);
      let result: unknown;
      try {
        result = await deps.ipc.lspRequest(path, "textDocument/codeAction", {
          textDocument: { uri: pathToUri(path) },
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
          context: {
            diagnostics: markerDiagnostics(context.markers),
            ...(context.only ? { only: [context.only] } : automatic ? { only: ["quickfix"] } : {}),
            triggerKind: automatic ? 2 : 1,
          },
        });
      } catch {
        result = null;
      }
      if (token.isCancellationRequested) return EMPTY;
      return { actions: toMonacoActions(path, result), dispose() {} };
    },
  };
}

/** Applies a server's workspace edit to the editor's buffers (one undo step per file; nothing is saved). */
export async function applyWorkspaceEdit(
  deps: CodeActionDeps,
  converted: ConvertedWorkspaceEdit,
): Promise<boolean> {
  if (converted.unsupported !== null) throw new Error(converted.unsupported);
  if (converted.files.length === 0) return true;
  if (converted.files.length > 1 && !(await deps.confirmFiles(converted.files.map((file) => file.path)))) {
    return false;
  }
  const activeTab = deps.workspace.getState().activeId;
  for (const file of converted.files) {
    let id = deps.documents.idForPath(file.path);
    if (id === null) {
      await deps.workspace.openPath(file.path, { kind: "text" });
      id = deps.documents.idForPath(file.path);
    }
    const uri = id === null ? null : deps.documents.modelUri(id);
    const model = uri === null ? null : monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model === null) throw new Error(t("codeAction.openFailed", { path: file.path }));
    model.pushStackElement();
    model.pushEditOperations(
      [],
      file.edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText })),
      () => null,
    );
    model.pushStackElement();
  }
  if (activeTab !== null) deps.workspace.setActive(activeTab);
  return true;
}

async function executeCommand(deps: CodeActionDeps, path: string, command: LspCommand): Promise<void> {
  const outcome = await deps.ipc.lspExecuteCommand(path, command.command, command.arguments ?? []);
  for (const edit of outcome.edits) await applyWorkspaceEdit(deps, convertWorkspaceEdit(edit));
}

/** Runs one server code action: resolve it if the server fills in its edit lazily, apply the edit, run its command. */
export async function runCodeAction(deps: CodeActionDeps, payload: CodeActionPayload): Promise<void> {
  const { path } = payload;
  let item = payload.item;
  if (isCommand(item)) {
    await executeCommand(deps, path, item);
    return;
  }
  const server = deps.lsp.serverForPath(path);
  if (item.edit === undefined && item.data !== undefined && server?.capabilities?.codeActionResolve) {
    const resolved = await deps.ipc.lspRequest(path, "codeAction/resolve", item);
    if (isCodeAction(resolved)) item = resolved;
  }
  if (item.edit !== undefined && !(await applyWorkspaceEdit(deps, convertWorkspaceEdit(item.edit)))) return;
  if (item.command) await executeCommand(deps, path, item.command);
}

/** Registers the code action provider for every server language and the command its actions run. */
export function registerCodeActions(deps: CodeActionDeps): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = [
    monaco.editor.registerCommand(APPLY_CODE_ACTION, (_accessor, ...args: unknown[]) => {
      const payload = args[0] as CodeActionPayload | undefined;
      if (payload === undefined) return;
      void runCodeAction(deps, payload).catch((error: unknown) => {
        deps.report(error instanceof Error ? error.message : String(error));
      });
    }),
  ];
  for (const language of LSP_MONACO_LANGUAGES) {
    disposables.push(
      monaco.languages.registerCodeActionProvider(language, createCodeActionProvider(deps), {
        providedCodeActionKinds: ["quickfix", "refactor", "source"],
      }),
    );
  }
  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
