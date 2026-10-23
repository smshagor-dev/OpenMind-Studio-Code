# VS Code extension compatibility inventory

Reference: [VS Code 1.85.2 declarations](https://github.com/microsoft/vscode/blob/1.85.2/src/vscode-dts/vscode.d.ts).
The host currently exposes vscode.version = 1.85.0. This is a declaration comparison baseline, **not a claim of complete 1.85 compatibility**. No complete stable API version has been verified. Do not use the version or successful installation alone to classify an extension as compatible.

This inventory enumerates runtime namespace exports and top-level value exports against that baseline. Interfaces and type aliases are compile-time declarations, not runtime exports. Presence is detected with Object.hasOwn, so the unsupported-API proxy cannot masquerade as an implemented member. Overloads and individual class methods are not measured by this listing. Present means partial or unverified unless the behavioral evidence below says otherwise. It does not mean end-to-end workbench support.

## Verified behavior in the local Node tests

Run: node --test crates/extensions/tests/node/*.test.cjs

Verified Linux run on 2026-10-23: 77 Node tests passed, zero failures and one skipped test. The 34 focused frontend tests for Monaco, native dialogs and host editor APIs passed. Full-project TypeScript and scoped ESLint passed. Full frontend regression validation is incomplete. Rust/Tauri and Windows builds were not run; Cargo is unavailable.

- Real child-process host activation: concurrent callers, shared dependencies, dependency exports, manifest cycles, runtime activation cycles, failure rollback/retry, uninstall during activation, concurrent deactivation and command ownership permissions.
- File operations on actual temporary files: copy, rename, overwrite rejection, missing source after rename, provider delegation and read-only rejection.
- Permission regression cases: outside destinations, existing symlink targets, future paths under symlinks and dangling symlinks. These are regression checks, not proof of a sandbox.
- Core contracts: command thisArg and disposal, nested workspace selection, relative paths and all 58 public numeric enums, including named and reverse mappings, against the official declaration values. Parent cancellation and late-listener disposal are covered.
- Notebook edits and saves: serializer inputs are copied to keep extension-owned/frozen objects from corrupting transaction state. Save As uses guarded exclusive writes and retains the original document when serialization fails or newer edits arrive.
- Workbench: real-host tests cover test discovery/execution/cancellation, SCM commands/validation, notebook editing/execution/save, trust grants and adapter permissions. React integration renders the actual dialog against the child-process host. Frontend tests also cover stale responses, dirty notebook retention and failed-edit barriers. Native Tauri rendering remains unverified.
- Additional provider evidence: real-host/HostBridge tests cover declaration, signature context, selection parent flattening, linked word patterns, on-type edit mapping, lazy link and completion resolution, snippet flags, incomplete results and extra edits. Monaco registrations remain mocked.
- Native ESM: actual hosts cover default/named vscode imports, guarded builtin namespaces, top-level await, ownership across awaits, package-type and typeless entrypoints, CJS dynamic imports and helper-module reload after disable/update. Synchronous module hooks provide virtual CommonJS bridges without temporary source files. Node keeps historical ESM records until the host process exits; generation tags ensure reactivation loads current code. This is not an OS sandbox.
- Additional local integrations: inline completions map trigger/selected-suggestion context, snippets, explicit/default word ranges and acceptance commands; stale model replies are discarded. Commands run after an edit or tab closure while released result capabilities are rejected. Open/save dialog requests run through the real stdio host and HostBridge to a mocked native adapter. Native dialog rendering remains unverified. Theme events retain configuration; stacked status messages restore earlier entries and clean up on timeout, settled promises and extension teardown.
- Advanced language providers: real host/HostBridge/Monaco-adapter tests now cover prepared multi-file rename with versioned text edits, code-action diagnostics/kind context and lazy resolution, CodeLens refresh/resolution, inlay-hint label-part commands/locations/resolution, color presentation edits and full/range semantic tokens with legends and sorted builders. Original extension objects and command arguments stay in the host. Write permissions, symlink escapes, stale/released items, disabled commands, cancellation and deactivation are covered by real-host tests. Extension diagnostic aggregation and change events retain URI identities; builtin LSP diagnostic collections are not mirrored into the host. Monaco registrations remain mocked.
- Language providers: real stdio-host tests cover references, type definitions, implementations, highlights, nested symbols, folding, selectors and cancellation/disposal. Vitest sends requests through the real host and HostBridge into mocked Monaco registrations to verify coordinate conversion, URI schemes, reference context, disposal and cancellation. This does not establish browser rendering behavior.

## Implemented subsets and remaining work

| Area | Observed implementation and remaining work |
| --- | --- |
| Debug | Executable, socket and inline DAP transports, configuration/factory registration, sessions, source/function breakpoints and a dedicated workbench are implemented. A real debugpy adapter launched Python, stopped at a conditional breakpoint, returned threads/frames/scopes/variables, evaluated an expression and disconnected in the Node suite. Attach/restart are not integration-tested; Tracker factories (including wildcard and multiple registrations) now observe real DAP, preserve callback owner permissions and isolate tracker exceptions/mutations. Adapter-confirmed source/function breakpoints are available through DebugSession.getDebugProtocolBreakpoint. Inline and loopback TCP transports have real host integration tests, including failure cleanup and adapter-initiated termination. Transport ownership remains tracked while disconnect is pending, so extension teardown can still close it. Reverse requests (including runInTerminal), virtual debug sources, data breakpoints and native editor gutter integration remain unsupported. |
| Testing | Controllers, hierarchical discovery, run profiles, selected execution, results/diffs/output and cancellation are connected to the dedicated workbench and tested with actual extension code. Continuous testing and detailed coverage reporting remain unsupported. This is not a marketplace test-extension certification. |
| Notebooks | Serializers, file-backed documents/cells, metadata, text edits, controller execution, textual outputs and save are connected to the dedicated workbench. Tests verify actual file persistence and dirty-cell preservation when an extension is disabled. NotebookEdit cell insertion/replacement/deletion and cell/notebook metadata updates now work through notebook-only WorkspaceEdit transactions, with validation before mutation, stable cell identities, reindexing and change events. The workbench supports New notebook, add/delete cells and Save As to a new file; exclusive creation refuses existing destinations and failures retain unsaved source text. Tests cover permissions, symlink containment, invalid/overlapping edits, serialization races and actual UI-to-file persistence. Mixed notebook/text/file WorkspaceEdit transactions, rich output renderers, native Jupyter integration and editor selections/affinity remain unsupported. No undo/redo integration is claimed. |
| SCM | Providers, resource groups, input validation, selection, accept/resource commands and quick-diff URI resolution are exercised through the real host. The workbench displays groups and can compare original/current text through guarded workspace.fs. Advanced contribution menus/status commands remain incomplete; built-in Git is separate. |
| Languages | Completion, hover, definition, document/range formatting and diagnostics retain their implementations. References, type definitions, implementations, document highlights, document symbols and folding are now connected through HostBridge to Monaco. Navigation links preserve URI schemes and selection ranges. Selectors retain scheme/glob/relative bases and are checked in the host. Provider cancellation reaches extension tokens; deactivation and provider disposal cancel outstanding requests. Declaration, signature help/context, selection ranges, linked editing, on-type formatting and document links (including lazy resolution) now connect through the real host and Monaco adapter. Completion preserves trigger context, incomplete lists, insert/replace ranges, snippets, label details, commit characters, tags and lazy resolution with additional edits. Completion acceptance commands route back through host-owned command execution and dispose with the provider. Rename, code actions, CodeLens, inlay hints, colors and document/range semantic tokens now connect through the real host and HostBridge to Monaco. Lazy object/command state remains host-owned; text edits carry document versions and require write permissions and symlink containment. Semantic tokens currently use full results rather than delta optimization. Extension diagnostics can be queried across collections with change events; builtin language-server diagnostics are not mirrored. Inline completions now connect through the host/bridge, including snippets, context, ranges, cancellation/stale-model checks and host-owned acceptance commands. Filter text is checked before returning results, but Monaco also applies its own visibility rules; complete VS Code filter behavior is not certified. Call/type hierarchy, workspace symbols, folding change events and full selector semantics remain incomplete. No browser rendering test was run here. |
| Tasks/terminals | Existing shell/process task and terminal bridges need live workbench validation. CustomExecution and problem matchers remain unsupported. |
| Webviews/trees | Existing host modules and UI bridge need actual rendering, restore, messaging, CSP and resource-policy validation. |
| Lifecycle | Local tests cover the cases above. Native ESM loading, top-level await and generation-based dependency reload are now covered locally. Recovery after an OS-level host crash, activation timeouts and orphan-process cleanup still need validation or implementation. |
| Activation events | Rust Trigger currently covers startup, command, language, view and workspace contains. The Node host now activates onFileSystem providers, onNotebook serializers and onDebug/onDebugResolve/onDebugAdapterProtocolTracker/onDebugInitialConfigurations handlers at their actual call sites. Notebook/debug contributions provide implicit type activation, and concurrent activation is coalesced. The SCM workbench emits onView:workbench.scm. These direct Node paths do not expand the Rust Trigger enum; URI/task triggers and a comprehensive event dispatch surface still require work. No invented onTest event is claimed. |
| Virtual documents | workspace.registerTextDocumentContentProvider now loads read-only content, coalesces concurrent opens, preserves URI query/fragment, refreshes on change with versioned full-replacement text events, cancels superseded reads and removes stale responses. Provider disposal/closure settle reads even when cancellation is ignored. Callbacks retain provider-owner permissions. The UI bridge refreshes an existing preview without switching focus or reopening a closed tab; closing its last tab releases the host mirror. Real-host and actual workspace/preview-service integration tests cover these paths. One provider per scheme is supported; multiple content-provider arbitration and fully editable virtual Monaco models remain unsupported. |
| Window/environment | Active color theme and change events follow the real theme service. Status messages stack, restore older entries, settle timers/thenables and dispose with their extension. Desktop UIKind and the local remoteName value are exposed. Native open/save dialogs support file URIs, multiple selections and filters; mixed file/folder requests ask which native mode to use. Custom dialog button labels and virtual-scheme dialogs are not supported. Native Tauri/Windows dialogs were not executed. Dynamic quick-input objects, progress notifications, clipboard, URI handlers and broader workbench window events remain incomplete. |
| Filesystems | Same-scheme file rename and file copy plus custom-provider delegation implemented. Cross-scheme transfers and local directory copy explicitly reject. Local rename overwrite=false has a check/rename race and needs an atomic platform implementation for a strict no-clobber guarantee. Provider file-change events still require integration work. |
| Profiles/install/marketplace | Existing implementation has not been fully audited or executed here. VSIX install, dependencies, imports, updates, native modules and legal distribution sources require separate end-to-end evidence. |
| Permissions/isolation | Node require guards are not a security sandbox. Native code, process.binding, alternative loaders, shared module state, file descriptors and filesystem races remain limitations. Do not run hostile extensions as though isolated by these guards. Workspace Trust defaults to untrusted; workbench execution requires an explicit session grant for the exact current roots, and manifests explicitly rejecting untrusted workspaces cannot activate there. These checks are tested; full VS Code restricted-settings semantics and an OS isolation boundary are not provided. |
| Platforms | Node and focused Vitest tests ran on Linux with Node 24.19.0. Full-project TypeScript checks and the Vite production build passed against Monaco 0.56.0. Rust/Cargo is unavailable; Rust, Tauri and Windows builds were not run. No real marketplace extension compatibility or Windows result is claimed. |

## Namespace member inventory

| Official member | Current host status |
| --- | --- |
| `tasks.executeTask` | Present; partial or unverified |
| `tasks.fetchTasks` | Present; partial or unverified |
| `tasks.onDidEndTask` | Present; partial or unverified |
| `tasks.onDidEndTaskProcess` | Present; partial or unverified |
| `tasks.onDidStartTask` | Present; partial or unverified |
| `tasks.onDidStartTaskProcess` | Present; partial or unverified |
| `tasks.registerTaskProvider` | Present; partial or unverified |
| `tasks.taskExecutions` | Present; partial or unverified |
| `env.appHost` | Present; partial or unverified |
| `env.appName` | Present; partial or unverified |
| `env.appRoot` | Unsupported |
| `env.asExternalUri` | Unsupported |
| `env.clipboard` | Unsupported |
| `env.createTelemetryLogger` | Unsupported |
| `env.isNewAppInstall` | Unsupported |
| `env.isTelemetryEnabled` | Unsupported |
| `env.language` | Present; partial or unverified |
| `env.logLevel` | Unsupported |
| `env.machineId` | Present; partial or unverified |
| `env.onDidChangeLogLevel` | Unsupported |
| `env.onDidChangeShell` | Unsupported |
| `env.onDidChangeTelemetryEnabled` | Unsupported |
| `env.openExternal` | Present; partial or unverified |
| `env.remoteName` | Present; partial or unverified |
| `env.sessionId` | Present; partial or unverified |
| `env.shell` | Present; partial or unverified |
| `env.uiKind` | Present; partial or unverified |
| `env.uriScheme` | Present; partial or unverified |
| `commands.executeCommand` | Present; partial or unverified |
| `commands.getCommands` | Present; partial or unverified |
| `commands.registerCommand` | Present; partial or unverified |
| `commands.registerTextEditorCommand` | Present; partial or unverified |
| `window.activeColorTheme` | Present; partial or unverified |
| `window.activeNotebookEditor` | Unsupported |
| `window.activeTerminal` | Present; partial or unverified |
| `window.activeTextEditor` | Present; partial or unverified |
| `window.createInputBox` | Unsupported |
| `window.createOutputChannel` | Present; partial or unverified |
| `window.createQuickPick` | Unsupported |
| `window.createStatusBarItem` | Present; partial or unverified |
| `window.createTerminal` | Present; partial or unverified |
| `window.createTextEditorDecorationType` | Unsupported |
| `window.createTreeView` | Present; partial or unverified |
| `window.createWebviewPanel` | Present; partial or unverified |
| `window.onDidChangeActiveColorTheme` | Present; partial or unverified |
| `window.onDidChangeActiveNotebookEditor` | Unsupported |
| `window.onDidChangeActiveTerminal` | Unsupported |
| `window.onDidChangeActiveTextEditor` | Present; partial or unverified |
| `window.onDidChangeNotebookEditorSelection` | Unsupported |
| `window.onDidChangeNotebookEditorVisibleRanges` | Unsupported |
| `window.onDidChangeTerminalState` | Unsupported |
| `window.onDidChangeTextEditorOptions` | Unsupported |
| `window.onDidChangeTextEditorSelection` | Present; partial or unverified |
| `window.onDidChangeTextEditorViewColumn` | Unsupported |
| `window.onDidChangeTextEditorVisibleRanges` | Unsupported |
| `window.onDidChangeVisibleNotebookEditors` | Unsupported |
| `window.onDidChangeVisibleTextEditors` | Unsupported |
| `window.onDidChangeWindowState` | Unsupported |
| `window.onDidCloseTerminal` | Present; partial or unverified |
| `window.onDidOpenTerminal` | Present; partial or unverified |
| `window.registerCustomEditorProvider` | Unsupported |
| `window.registerFileDecorationProvider` | Unsupported |
| `window.registerTerminalLinkProvider` | Unsupported |
| `window.registerTerminalProfileProvider` | Unsupported |
| `window.registerTreeDataProvider` | Present; partial or unverified |
| `window.registerUriHandler` | Unsupported |
| `window.registerWebviewPanelSerializer` | Unsupported |
| `window.registerWebviewViewProvider` | Present; partial or unverified |
| `window.setStatusBarMessage` | Present; partial or unverified |
| `window.showErrorMessage` | Present; partial or unverified |
| `window.showInformationMessage` | Present; partial or unverified |
| `window.showInputBox` | Present; partial or unverified |
| `window.showNotebookDocument` | Present; partial or unverified |
| `window.showOpenDialog` | Present; partial or unverified |
| `window.showQuickPick` | Present; partial or unverified |
| `window.showSaveDialog` | Present; partial or unverified |
| `window.showTextDocument` | Present; partial or unverified |
| `window.showWarningMessage` | Present; partial or unverified |
| `window.showWorkspaceFolderPick` | Unsupported |
| `window.state` | Unsupported |
| `window.tabGroups` | Unsupported |
| `window.terminals` | Present; partial or unverified |
| `window.visibleNotebookEditors` | Unsupported |
| `window.visibleTextEditors` | Present; partial or unverified |
| `window.withProgress` | Unsupported |
| `window.withScmProgress` | Unsupported |
| `workspace.applyEdit` | Present; partial or unverified |
| `workspace.asRelativePath` | Present; partial or unverified |
| `workspace.createFileSystemWatcher` | Present; partial or unverified |
| `workspace.findFiles` | Present; partial or unverified |
| `workspace.fs` | Present; partial or unverified |
| `workspace.getConfiguration` | Present; partial or unverified |
| `workspace.getWorkspaceFolder` | Present; partial or unverified |
| `workspace.isTrusted` | Present; partial or unverified |
| `workspace.name` | Present; partial or unverified |
| `workspace.notebookDocuments` | Present; partial or unverified |
| `workspace.onDidChangeConfiguration` | Present; partial or unverified |
| `workspace.onDidChangeNotebookDocument` | Present; partial or unverified |
| `workspace.onDidChangeTextDocument` | Present; partial or unverified |
| `workspace.onDidChangeWorkspaceFolders` | Present; partial or unverified |
| `workspace.onDidCloseNotebookDocument` | Present; partial or unverified |
| `workspace.onDidCloseTextDocument` | Present; partial or unverified |
| `workspace.onDidCreateFiles` | Unsupported |
| `workspace.onDidDeleteFiles` | Unsupported |
| `workspace.onDidGrantWorkspaceTrust` | Present; partial or unverified |
| `workspace.onDidOpenNotebookDocument` | Present; partial or unverified |
| `workspace.onDidOpenTextDocument` | Present; partial or unverified |
| `workspace.onDidRenameFiles` | Unsupported |
| `workspace.onDidSaveNotebookDocument` | Present; partial or unverified |
| `workspace.onDidSaveTextDocument` | Present; partial or unverified |
| `workspace.onWillCreateFiles` | Unsupported |
| `workspace.onWillDeleteFiles` | Unsupported |
| `workspace.onWillRenameFiles` | Unsupported |
| `workspace.onWillSaveNotebookDocument` | Unsupported |
| `workspace.onWillSaveTextDocument` | Unsupported |
| `workspace.openNotebookDocument` | Present; partial or unverified |
| `workspace.openTextDocument` | Present; partial or unverified |
| `workspace.registerFileSystemProvider` | Present; partial or unverified |
| `workspace.registerNotebookSerializer` | Present; partial or unverified |
| `workspace.registerTaskProvider` | Unsupported |
| `workspace.registerTextDocumentContentProvider` | Present; partial or unverified |
| `workspace.rootPath` | Present; partial or unverified |
| `workspace.saveAll` | Present; partial or unverified |
| `workspace.textDocuments` | Present; partial or unverified |
| `workspace.updateWorkspaceFolders` | Unsupported |
| `workspace.workspaceFile` | Unsupported |
| `workspace.workspaceFolders` | Present; partial or unverified |
| `languages.createDiagnosticCollection` | Present; partial or unverified |
| `languages.createLanguageStatusItem` | Unsupported |
| `languages.getDiagnostics` | Present; partial or unverified |
| `languages.getLanguages` | Present; partial or unverified |
| `languages.match` | Present; partial or unverified |
| `languages.onDidChangeDiagnostics` | Present; partial or unverified |
| `languages.registerCallHierarchyProvider` | Unsupported |
| `languages.registerCodeActionsProvider` | Present; partial or unverified |
| `languages.registerCodeLensProvider` | Present; partial or unverified |
| `languages.registerColorProvider` | Present; partial or unverified |
| `languages.registerCompletionItemProvider` | Present; partial or unverified |
| `languages.registerDeclarationProvider` | Present; partial or unverified |
| `languages.registerDefinitionProvider` | Present; partial or unverified |
| `languages.registerDocumentDropEditProvider` | Unsupported |
| `languages.registerDocumentFormattingEditProvider` | Present; partial or unverified |
| `languages.registerDocumentHighlightProvider` | Present; partial or unverified |
| `languages.registerDocumentLinkProvider` | Present; partial or unverified |
| `languages.registerDocumentRangeFormattingEditProvider` | Present; partial or unverified |
| `languages.registerDocumentRangeSemanticTokensProvider` | Present; partial or unverified |
| `languages.registerDocumentSemanticTokensProvider` | Present; partial or unverified |
| `languages.registerDocumentSymbolProvider` | Present; partial or unverified |
| `languages.registerEvaluatableExpressionProvider` | Unsupported |
| `languages.registerFoldingRangeProvider` | Present; partial or unverified |
| `languages.registerHoverProvider` | Present; partial or unverified |
| `languages.registerImplementationProvider` | Present; partial or unverified |
| `languages.registerInlayHintsProvider` | Present; partial or unverified |
| `languages.registerInlineCompletionItemProvider` | Present; partial or unverified |
| `languages.registerInlineValuesProvider` | Unsupported |
| `languages.registerLinkedEditingRangeProvider` | Present; partial or unverified |
| `languages.registerOnTypeFormattingEditProvider` | Present; partial or unverified |
| `languages.registerReferenceProvider` | Present; partial or unverified |
| `languages.registerRenameProvider` | Present; partial or unverified |
| `languages.registerSelectionRangeProvider` | Present; partial or unverified |
| `languages.registerSignatureHelpProvider` | Present; partial or unverified |
| `languages.registerTypeDefinitionProvider` | Present; partial or unverified |
| `languages.registerTypeHierarchyProvider` | Unsupported |
| `languages.registerWorkspaceSymbolProvider` | Unsupported |
| `languages.setLanguageConfiguration` | Unsupported |
| `languages.setTextDocumentLanguage` | Unsupported |
| `notebooks.createNotebookController` | Present; partial or unverified |
| `notebooks.createRendererMessaging` | Unsupported |
| `notebooks.registerNotebookCellStatusBarItemProvider` | Unsupported |
| `scm.createSourceControl` | Present; partial or unverified |
| `scm.inputBox` | Unsupported |
| `debug.activeDebugConsole` | Present; partial or unverified |
| `debug.activeDebugSession` | Present; partial or unverified |
| `debug.addBreakpoints` | Present; partial or unverified |
| `debug.asDebugSourceUri` | Unsupported |
| `debug.breakpoints` | Present; partial or unverified |
| `debug.onDidChangeActiveDebugSession` | Present; partial or unverified |
| `debug.onDidChangeBreakpoints` | Present; partial or unverified |
| `debug.onDidReceiveDebugSessionCustomEvent` | Present; partial or unverified |
| `debug.onDidStartDebugSession` | Present; partial or unverified |
| `debug.onDidTerminateDebugSession` | Present; partial or unverified |
| `debug.registerDebugAdapterDescriptorFactory` | Present; partial or unverified |
| `debug.registerDebugAdapterTrackerFactory` | Present; partial or unverified |
| `debug.registerDebugConfigurationProvider` | Present; partial or unverified |
| `debug.removeBreakpoints` | Present; partial or unverified |
| `debug.startDebugging` | Present; partial or unverified |
| `debug.stopDebugging` | Present; partial or unverified |
| `extensions.all` | Present; partial or unverified |
| `extensions.getExtension` | Present; partial or unverified |
| `extensions.onDidChange` | Present; partial or unverified |
| `authentication.getSession` | Unsupported |
| `authentication.onDidChangeSessions` | Unsupported |
| `authentication.registerAuthenticationProvider` | Unsupported |
| `l10n.bundle` | Present; partial or unverified |
| `l10n.t` | Present; partial or unverified |
| `l10n.uri` | Present; partial or unverified |
| `tests.createTestController` | Present; partial or unverified |

## Top-level runtime value inventory

| Official value | Current host status |
| --- | --- |
| `Breakpoint` | Unsupported |
| `CallHierarchyIncomingCall` | Unsupported |
| `CallHierarchyItem` | Unsupported |
| `CallHierarchyOutgoingCall` | Unsupported |
| `CancellationError` | Present; behavior needs per-member verification |
| `CancellationTokenSource` | Present; behavior needs per-member verification |
| `CodeAction` | Present; behavior needs per-member verification |
| `CodeActionKind` | Present; behavior needs per-member verification |
| `CodeActionTriggerKind` | Present; behavior needs per-member verification |
| `CodeLens` | Present; behavior needs per-member verification |
| `Color` | Present; behavior needs per-member verification |
| `ColorInformation` | Present; behavior needs per-member verification |
| `ColorPresentation` | Present; behavior needs per-member verification |
| `ColorThemeKind` | Present; behavior needs per-member verification |
| `CommentMode` | Present; behavior needs per-member verification |
| `CommentThreadCollapsibleState` | Present; behavior needs per-member verification |
| `CommentThreadState` | Present; behavior needs per-member verification |
| `CompletionItem` | Present; behavior needs per-member verification |
| `CompletionItemKind` | Present; behavior needs per-member verification |
| `CompletionItemTag` | Present; behavior needs per-member verification |
| `CompletionList` | Present; behavior needs per-member verification |
| `CompletionTriggerKind` | Present; behavior needs per-member verification |
| `ConfigurationTarget` | Present; behavior needs per-member verification |
| `CustomExecution` | Present; behavior needs per-member verification |
| `DataTransfer` | Unsupported |
| `DataTransferItem` | Unsupported |
| `DebugAdapterExecutable` | Present; behavior needs per-member verification |
| `DebugAdapterInlineImplementation` | Present; behavior needs per-member verification |
| `DebugAdapterNamedPipeServer` | Unsupported |
| `DebugAdapterServer` | Present; behavior needs per-member verification |
| `DebugConfigurationProviderTriggerKind` | Present; behavior needs per-member verification |
| `DebugConsoleMode` | Present; behavior needs per-member verification |
| `DecorationRangeBehavior` | Present; behavior needs per-member verification |
| `Diagnostic` | Present; behavior needs per-member verification |
| `DiagnosticRelatedInformation` | Present; behavior needs per-member verification |
| `DiagnosticSeverity` | Present; behavior needs per-member verification |
| `DiagnosticTag` | Present; behavior needs per-member verification |
| `Disposable` | Present; behavior needs per-member verification |
| `DocumentDropEdit` | Unsupported |
| `DocumentHighlight` | Present; behavior needs per-member verification |
| `DocumentHighlightKind` | Present; behavior needs per-member verification |
| `DocumentLink` | Present; behavior needs per-member verification |
| `DocumentSymbol` | Present; behavior needs per-member verification |
| `EndOfLine` | Present; behavior needs per-member verification |
| `EnvironmentVariableMutatorType` | Present; behavior needs per-member verification |
| `EvaluatableExpression` | Unsupported |
| `EventEmitter` | Present; behavior needs per-member verification |
| `ExtensionKind` | Present; behavior needs per-member verification |
| `ExtensionMode` | Present; behavior needs per-member verification |
| `FileChangeType` | Present; behavior needs per-member verification |
| `FileDecoration` | Unsupported |
| `FilePermission` | Present; behavior needs per-member verification |
| `FileSystemError` | Present; behavior needs per-member verification |
| `FileType` | Present; behavior needs per-member verification |
| `FoldingRange` | Present; behavior needs per-member verification |
| `FoldingRangeKind` | Present; behavior needs per-member verification |
| `FunctionBreakpoint` | Present; behavior needs per-member verification |
| `Hover` | Present; behavior needs per-member verification |
| `IndentAction` | Present; behavior needs per-member verification |
| `InlayHint` | Present; behavior needs per-member verification |
| `InlayHintKind` | Present; behavior needs per-member verification |
| `InlayHintLabelPart` | Present; behavior needs per-member verification |
| `InlineCompletionItem` | Present; behavior needs per-member verification |
| `InlineCompletionList` | Present; behavior needs per-member verification |
| `InlineCompletionTriggerKind` | Present; behavior needs per-member verification |
| `InlineValueEvaluatableExpression` | Unsupported |
| `InlineValueText` | Unsupported |
| `InlineValueVariableLookup` | Unsupported |
| `InputBoxValidationSeverity` | Present; behavior needs per-member verification |
| `LanguageStatusSeverity` | Present; behavior needs per-member verification |
| `LinkedEditingRanges` | Present; behavior needs per-member verification |
| `Location` | Present; behavior needs per-member verification |
| `LogLevel` | Present; behavior needs per-member verification |
| `MarkdownString` | Present; behavior needs per-member verification |
| `NotebookCellData` | Present; behavior needs per-member verification |
| `NotebookCellKind` | Present; behavior needs per-member verification |
| `NotebookCellOutput` | Present; behavior needs per-member verification |
| `NotebookCellOutputItem` | Present; behavior needs per-member verification |
| `NotebookCellStatusBarAlignment` | Present; behavior needs per-member verification |
| `NotebookCellStatusBarItem` | Unsupported |
| `NotebookControllerAffinity` | Present; behavior needs per-member verification |
| `NotebookData` | Present; behavior needs per-member verification |
| `NotebookEdit` | Present; behavior needs per-member verification |
| `NotebookEditorRevealType` | Present; behavior needs per-member verification |
| `NotebookRange` | Present; behavior needs per-member verification |
| `OverviewRulerLane` | Present; behavior needs per-member verification |
| `ParameterInformation` | Present; behavior needs per-member verification |
| `Position` | Present; behavior needs per-member verification |
| `ProcessExecution` | Present; behavior needs per-member verification |
| `ProgressLocation` | Present; behavior needs per-member verification |
| `QuickInputButtons` | Unsupported |
| `QuickPickItemKind` | Present; behavior needs per-member verification |
| `Range` | Present; behavior needs per-member verification |
| `RelativePattern` | Present; behavior needs per-member verification |
| `Selection` | Present; behavior needs per-member verification |
| `SelectionRange` | Present; behavior needs per-member verification |
| `SemanticTokens` | Present; behavior needs per-member verification |
| `SemanticTokensBuilder` | Present; behavior needs per-member verification |
| `SemanticTokensEdit` | Present; behavior needs per-member verification |
| `SemanticTokensEdits` | Present; behavior needs per-member verification |
| `SemanticTokensLegend` | Present; behavior needs per-member verification |
| `ShellExecution` | Present; behavior needs per-member verification |
| `ShellQuoting` | Present; behavior needs per-member verification |
| `SignatureHelp` | Present; behavior needs per-member verification |
| `SignatureHelpTriggerKind` | Present; behavior needs per-member verification |
| `SignatureInformation` | Present; behavior needs per-member verification |
| `SnippetString` | Present; behavior needs per-member verification |
| `SnippetTextEdit` | Unsupported |
| `SourceBreakpoint` | Present; behavior needs per-member verification |
| `StatusBarAlignment` | Present; behavior needs per-member verification |
| `SymbolInformation` | Present; behavior needs per-member verification |
| `SymbolKind` | Present; behavior needs per-member verification |
| `SymbolTag` | Present; behavior needs per-member verification |
| `SyntaxTokenType` | Present; behavior needs per-member verification |
| `TabInputCustom` | Unsupported |
| `TabInputNotebook` | Unsupported |
| `TabInputNotebookDiff` | Unsupported |
| `TabInputTerminal` | Unsupported |
| `TabInputText` | Unsupported |
| `TabInputTextDiff` | Unsupported |
| `TabInputWebview` | Unsupported |
| `Task` | Present; behavior needs per-member verification |
| `TaskGroup` | Present; behavior needs per-member verification |
| `TaskPanelKind` | Present; behavior needs per-member verification |
| `TaskRevealKind` | Present; behavior needs per-member verification |
| `TaskScope` | Present; behavior needs per-member verification |
| `TelemetryTrustedValue` | Unsupported |
| `TerminalExitReason` | Present; behavior needs per-member verification |
| `TerminalLink` | Unsupported |
| `TerminalLocation` | Present; behavior needs per-member verification |
| `TerminalProfile` | Unsupported |
| `TestMessage` | Present; behavior needs per-member verification |
| `TestRunProfileKind` | Present; behavior needs per-member verification |
| `TestRunRequest` | Present; behavior needs per-member verification |
| `TestTag` | Present; behavior needs per-member verification |
| `TextDocumentChangeReason` | Present; behavior needs per-member verification |
| `TextDocumentSaveReason` | Present; behavior needs per-member verification |
| `TextEdit` | Present; behavior needs per-member verification |
| `TextEditorCursorStyle` | Present; behavior needs per-member verification |
| `TextEditorLineNumbersStyle` | Present; behavior needs per-member verification |
| `TextEditorRevealType` | Present; behavior needs per-member verification |
| `TextEditorSelectionChangeKind` | Present; behavior needs per-member verification |
| `ThemeColor` | Present; behavior needs per-member verification |
| `ThemeIcon` | Present; behavior needs per-member verification |
| `TreeItem` | Present; behavior needs per-member verification |
| `TreeItemCheckboxState` | Present; behavior needs per-member verification |
| `TreeItemCollapsibleState` | Present; behavior needs per-member verification |
| `TypeHierarchyItem` | Unsupported |
| `UIKind` | Present; behavior needs per-member verification |
| `Uri` | Present; behavior needs per-member verification |
| `ViewColumn` | Present; behavior needs per-member verification |
| `WorkspaceEdit` | Present; behavior needs per-member verification |
| `version` | Present; behavior needs per-member verification |

Regenerate this document with the inventory.cjs command above. Behavioral evidence must be updated separately when integration tests run. Current local work remains unpublished until the requested compatibility implementation and integration validation are complete. Keep platform and compatibility gaps explicit; exports, builds and passing tests do not certify unsupported APIs or Windows integration.

