# VS Code extension compatibility inventory

Reference: [VS Code 1.85.2 declarations](https://github.com/microsoft/vscode/blob/1.85.2/src/vscode-dts/vscode.d.ts).
The host currently exposes vscode.version = 1.85.0. This is a declaration comparison baseline, **not a claim of complete 1.85 compatibility**. No complete stable API version has been verified. Do not use the version or successful installation alone to classify an extension as compatible.

This inventory enumerates runtime namespace exports and top-level value exports against that baseline. Interfaces and type aliases are compile-time declarations, not runtime exports. Presence is detected with Object.hasOwn, so the unsupported-API proxy cannot masquerade as an implemented member. Overloads and individual class methods are not measured by this listing. Present means partial or unverified unless the behavioral evidence below says otherwise. It does not mean end-to-end workbench support.

## Verified behavior in the local Node tests

Run: node --test crates/extensions/tests/node/*.test.cjs

Verified Linux run on 2026-10-24: 120 Node tests passed with zero failures and zero skips, including the real Python/debugpy adapter. Focused navigation, debug-terminal and workbench UI tests passed. Full-project TypeScript and scoped ESLint passed. The full frontend regression suite passed 2,791 tests across 269 files. Rust/Tauri and Windows builds were not run; Cargo is unavailable.

- Real child-process host activation: concurrent callers, shared dependencies, dependency exports, manifest cycles, runtime activation cycles, failure rollback/retry, uninstall during activation, concurrent deactivation and command ownership permissions.
- File operations on actual temporary files: copy, rename, overwrite rejection, missing source after rename, provider delegation and read-only rejection.
- Permission regression cases: outside destinations, existing symlink targets, future paths under symlinks and dangling symlinks. These are regression checks, not proof of a sandbox.
- Core contracts: command thisArg and disposal, nested workspace selection, relative paths and all 58 public numeric enums, including named and reverse mappings, against the official declaration values. Parent cancellation and late-listener disposal are covered.
- Editor edits: TextEditor.edit requires workspaceWrite; builders expire after callbacks, including failures. TextEditorEdit.setEndOfLine and WorkspaceEdit TextEdit.setEndOfLine carry EOL changes to Monaco with explicit undo-stop options. Single-line EOL is mirrored explicitly, text/EOL can undo together, and the status follows model EOL without losing unchanged mixed-file metadata. All targets in multi-file open-buffer edits are prevalidated, including duplicate aliases and range overlap, before mutation; this is not a disk/notebook transaction or rollback guarantee for unexpected model failures. Tab-size/indentation setters (including auto detection), resolved option change events, and all four reveal modes have host/model test coverage. Other TextEditorOptions and broader editor APIs remain incomplete.
- Visible editor lifecycle: mounted text panes now have independent identities, even when they share a document. Ordered snapshots retain view columns, selections, resolved options and visible ranges, with coherent active/visible/selection/options/column/range events. Selection, reveal and option requests carry pane identities, and stale pane requests cannot fall back to a different pane. Temporary overlays preserve referenced editor identity through a weak cache. showTextDocument waits for its requested pane and cancels on extension teardown. Real-host tests cover startup, split views, reordering, closure, callback identity/thisArg and disposal; a copied Rust-embedded host bundle runs outside the source tree. Frontend tests cover Monaco models, pane targeting and snapshot/overlay synchronization. This is not a native Windows rendering certification; rendered-preview editor objects remain incomplete. File-backed showTextDocument now supports object and legacy numeric overloads, Active/Beside/One-through-Nine columns, editor-group focus preservation, explicit preview flags and clamped selections. UI replies carry the exact editor identity, including when the same file is open twice; snapshots flush before replies. Extension teardown and host reset cancel pending UI opens, and tab closure aborts waiting. Failed reads create no extra groups. Preserving a covering webview's focus rejects explicitly. Native desktop focus/rendering remains unverified.
- Notebook edits and saves: serializer inputs are copied to keep extension-owned/frozen objects from corrupting transaction state. Save As uses guarded exclusive writes and retains the original document when serialization fails or newer edits arrive.
- Workbench: real-host tests cover test discovery/execution/cancellation, SCM commands/validation, notebook editing/execution/save, trust grants and adapter permissions. React integration renders the actual dialog against the child-process host. Frontend tests also cover stale responses, dirty notebook retention and failed-edit barriers. Native Tauri rendering remains unverified.
- Additional provider evidence: real-host/HostBridge tests cover declaration, signature context, selection parent flattening, linked word patterns, on-type edit mapping, lazy link and completion resolution, snippet flags, incomplete results and extra edits. Monaco registrations remain mocked.
- Untitled text documents: openTextDocument() and content/language options create native unsaved Monaco models with stable untitled URIs. They participate in initial synchronization, document lifecycle, diagnostics, language providers, showTextDocument pane targeting, edits, snippets and decorations. Save As closes the untitled identity and opens the file identity while retaining the editor; pending text reaches retained closed documents. Cancelled or failed saves preserve the unsaved buffer, and saving over another open document rejects before writing. Real stdio-host/Monaco tests use mocked native save and file IPC; actual Windows dialogs remain unverified. Named untitled URIs now reuse their open document identity and derive title/language from the resource name. Absolute associated paths save directly without reading an existing file; relative names retain the Save As dialog. Empty associated documents are dirty until saved. Pending edits, initial synchronization, close and save failures preserve the named URI. Host tests cover encoded and relative names, outside-workspace permissions and reserved/query URI rejection, and the real host/Monaco test covers associated-path edit/save. Query/fragment-bearing untitled URIs remain unsupported.
- Workbench progress: withProgress and withScmProgress report through a status-bar item, with extension-owned cancellation commands and cleanup. Notification/window locations share this status-bar presentation; native notification progress widgets are not claimed. Clipboard uses the native frontend clipboard plugin; asExternalUri retains local URIs because this host has no remote tunneling.
- Tasks and terminals: real-host tests cover extension pseudoterminal input/output/resize/close ownership and CustomExecution tasks that finish during initialization. Frontend tests cover native tasks that finish before creation resolves, ordered process lifecycle, matcher output capture and stale-result rejection across task reruns/reset. The new native runner is source-reviewed; Windows process launch and native problem parsing were not executed here.
- Writable virtual documents: writable filesystem providers now open native Monaco models with URI identities, pane selection/options, WorkspaceEdit before a tab is shown, snippets, UTF-8 provider saves and Save All for hidden buffers. Clean buffers follow provider refreshes; dirty buffers reject refresh overwrite. Failed saves retain text, and edits made during a pending save stay dirty. Host restart initialization retains dirty models; provider registration rebinds their mirrors, and save activates an onFileSystem provider when needed. A provider already registering during activation is called directly so its own save cannot wait on that activation. Provider disposal makes subsequent saves fail without discarding the buffer. Real stdio-host/Monaco tests cover edit, snippet, Unicode save, URI authority/query preservation, refresh and failures; real host tests cover restart initialization and read-only edit rejection. Read-only/content-provider resources now create native models when first shown; provider deletion/conflict UI and native Windows rendering remain incomplete or unverified.
- Read-only virtual editors: content providers and read-only filesystems now return native TextEditor objects on showTextDocument, with view columns, preview/focus/selection options and decorations. Promotion retains the document identity and version without firing a duplicate open event. Provider refreshes go through the native model and preserve clean state; last-tab close releases the mirror. Monaco readOnly/domReadOnly follow model switches. Extension edits, snippets, mixed workspace edits, native typing, cut/paste/programmatic insertion and service saves reject writes. Real host/Monaco tests cover content refresh, version continuity, decoration, selection, blocked writes and closure; a React-mounted real Monaco test covers switching between read-only and writable models. A real stdio filesystem test covers cached opens and targeted editor replies. Native Windows UI behavior and provider-replacement edge cases remain unverified.
- Virtual Save As: native writable and read-only provider documents can be saved to a local file through the save dialog. The provider receives no write. Cancellation, disk errors and collisions with another open file preserve the virtual identity and text. A successful write closes the old URI and opens a writable local identity in the retained editor; filename-derived language follows the destination while explicit language choices remain. Pending changes retain the old virtual/untitled flags and version before closure. Reopening the source URI creates a new document; retained closed documents keep their text, remain closed and cannot save the replacement. Close events retain the original document object. Edits made while the write is pending remain dirty in the new local document. A real stdio-host/Monaco integration test checks retained closed documents and editor identity; native file/dialog calls are mocked. Actual Windows dialogs and cross-provider Save As destinations remain unverified or unsupported.
- Session recovery and provider Auto Save: versioned editor-layout records now include deduplicated native-file, virtual and untitled buffer text, saved baselines, URI, language, read-only state and untitled naming. Split tabs reuse one restored model; old version-1 and version-2 layouts still load. Recovery snapshots use the existing SQLite-backed settings IPC, debounce text changes for 300 ms and serialize writes. Unreadable prior data is preserved rather than overwritten. Validation bounds resource count, UTF-8 text and total record size; unknown URI tabs never reach native filesystem reads. The native close-request handler awaits the recovery flush and prevents closing on failure; flush retries edits arriving during a write. Writable provider buffers participate in after-delay, focus-change and window-change Auto Save; read-only and untitled resources never trigger automatic writes/dialogs. Slow saves are serialized, failures retain dirty text without a retry loop, host-availability changes retry pending work, and late provider writes cannot rebind a buffer exported with Save As. Cross-service tests use real Monaco models with injected settings/provider/native-window APIs. Native-file recovery retains encoding and saved baselines, reads disk without writing, and protects conflicting recovered buffers until Reload, Keep My Changes or Save As resolves them. Missing/unreadable files retain the recovered text; hidden dirty native buffers reopen in a tab. Clean successful saves remove native snapshots. Main keeps its existing recovery key while each extra editor-window label uses a separate settings key. Cross-service tests restore simultaneous main/extra snapshots without replacing one another, including identical generated untitled URIs. Extra windows no longer rely on the main-only editor.layout key that the backend ignores for secondary windows. Reopening a window label restores its saved layout and buffers; native descriptors now connect startup recreation and explicit workspace restoration, subject to the native validation limits below. Actual SQLite/Tauri/Windows execution is not certified by these tests. Abrupt termination can lose changes that have not completed a recovery write.
- Editor-window restart and close: the native backend persists each newly created extra-window label and explicit workspace in a separate descriptor. Main requests restoration once per native app run; folders are attached before editor pages start. Missing folders and window creation failures produce notices; malformed records remain preserved. Creation, workspace changes and close acknowledgements are serialized. Individually confirmed closes retire their descriptor; closing the last extra window keeps it for the next launch. Normal OS/title-bar close sends a targeted recovery request and waits for an explicit renderer acknowledgement before hiding/destroying the window or starting shutdown. Page-specific capability tokens reject acknowledgements queued across reloads; listener retirement cannot revoke a replacement page's token. The editable workbench waits for close-listener readiness. An empty loading/failed page can close without replacing its previous backup, while fresh buffers cannot overwrite an unread prior session. Snapshot capture and queued write order remain intact across the first settings read. Frontend tests cover real workspace/model recovery and injected native listener/IPC contracts. Rust repository/record tests were added but not run; only the prefix discovery query was separately checked with SQLite. Native compilation, cargo fmt, actual desktop restart, multi-window event routing and Windows close behavior remain unverified. App-wide shutdown now uses the acknowledgement preflight below; actual native execution remains unverified. Extra-window geometry/focus restoration and automatic discovery of pre-descriptor extra-window records remain incomplete or unverified.
- Native ESM: actual hosts cover default/named vscode imports, guarded builtin namespaces, top-level await, ownership across awaits, package-type and typeless entrypoints, CJS dynamic imports and helper-module reload after disable/update. Synchronous module hooks provide virtual CommonJS bridges without temporary source files. Node keeps historical ESM records until the host process exits; generation tags ensure reactivation loads current code. This is not an OS sandbox.

- App-wide Quit recovery: tray Quit, the final editor close and Restart to Update now prepare every ready editor renderer, including hidden main, before stopping managed processes or starting installation. Native requests bind both a shutdown ID and a page token; acknowledgements are gathered concurrently, bounded by 15 seconds, and page/window changes cancel the attempt. A failed or absent reply keeps the app running and retains the tray. Renderer input is temporarily inert until completion/cancellation; overlapping owners restore the original input/accessibility state only when the last owner releases. Replacement listeners ignore another registration's token, and cancelled or replaced requests cannot acknowledge late completions. Global flush-only requests do not invoke normal close again, avoiding the nested-close deadlock. Hidden-main resource cleanup retains its still-live page registration; actual reload/destruction retires it. Cross-service frontend tests use real document/workspace services to persist hidden native-file edits and extra-window untitled text before acknowledgement. Native coordinator and hidden-main lifecycle unit cases were added but not run because Rust tooling is unavailable. Tauri/Windows quit/update execution remains unverified. The input barrier blocks UI interaction; it is not an atomic freeze of all background/programmatic model writers. Forced termination can still lose uncommitted recovery writes.

- Additional local integrations: inline completions map trigger/selected-suggestion context, snippets, explicit/default word ranges and acceptance commands; stale model replies are discarded. Commands run after an edit or tab closure while released result capabilities are rejected. Open/save dialog requests run through the real stdio host and HostBridge to a mocked native adapter. Native dialog rendering remains unverified. Theme events retain configuration; stacked status messages restore earlier entries and clean up on timeout, settled promises and extension teardown.
- Advanced language providers: real host/HostBridge/Monaco-adapter tests now cover prepared multi-file rename with versioned text edits, code-action diagnostics/kind context and lazy resolution, CodeLens refresh/resolution, inlay-hint label-part commands/locations/resolution, color presentation edits and full/range semantic tokens with legends and sorted builders. Original extension objects and command arguments stay in the host. Write permissions, symlink escapes, stale/released items, disabled commands, cancellation and deactivation are covered by real-host tests. Extension diagnostic aggregation and change events retain URI identities; builtin LSP diagnostic collections are not mirrored into the host. Monaco registrations remain mocked.
- Language providers: real stdio-host tests cover references, type definitions, implementations, highlights, nested symbols, folding, selectors and cancellation/disposal. Vitest sends requests through the real host and HostBridge into mocked Monaco registrations to verify coordinate conversion, URI schemes, reference context, disposal and cancellation. This does not establish browser rendering behavior.

## Implemented subsets and remaining work

| Area | Observed implementation and remaining work |
| --- | --- |
| Debug | Executable, socket and inline DAP transports, configuration/factory registration, sessions, source/function breakpoints and a dedicated workbench are implemented. A real debugpy adapter launched Python, stopped at a conditional breakpoint, returned threads/frames/scopes/variables, evaluated an expression and disconnected in the Node suite. Attach/restart are not integration-tested; Tracker factories (including wildcard and multiple registrations) now observe real DAP, preserve callback owner permissions and isolate tracker exceptions/mutations. Adapter-confirmed source/function breakpoints are available through DebugSession.getDebugProtocolBreakpoint. Inline and loopback TCP transports have real host integration tests, including failure cleanup and adapter-initiated termination. Transport ownership remains tracked while disconnect is pending, so extension teardown can still close it. Reverse runInTerminal requests launch a dedicated integrated terminal with literal arguments and environment values, requiring terminal/process permissions and workspace trust. PowerShell and Git Bash are supported; external terminals and shell-interpreted arguments reject explicitly. startDebugging reverse requests launch child configurations. Real-host tests verify terminal routing, permission rejection and cleanup. Virtual debug sources, data breakpoints and native editor gutter integration remain unsupported. |
| Testing | Controllers, hierarchical discovery, run profiles, selected execution, results/diffs/output and cancellation are connected to the dedicated workbench and tested with actual extension code. Continuous profiles now retain request tokens across handler completion, support Watch tests / Stop watching, and cancel on controller disposal or workspace changes. Detailed coverage reporting remains unsupported. This is not a marketplace test-extension certification. |
| Editors | Open-buffer text edits prevalidate every target and range before mutation, reject duplicate model targets, enforce write permission, support EOL changes and undo-stop options. Editor option setters support tabSize/insertSpaces and auto detection with resolved change events. Range reveal respects Default/InCenter/InCenterIfOutsideViewport/AtTop. Tests cover real host contracts and Monaco models; native desktop rendering, file/notebook transactions, closed-file edits, all editor option fields remain incomplete. TextEditor decoration types and setDecorations now render editor-owned range/whole-line highlights, inline font styles, before/after text, safe Markdown hovers, overview ruler colors and range-edge tracking in Monaco. ThemeColor CSS variables and light/dark CSS overrides follow theme updates. Tests cover split-pane isolation, replacement/clear, model switches, editor closure, extension disposal, host reset, overlapping ranges, preflight validation and style reuse. Gutter icons, themed attachment content, attachment images, URL cursors, complete render-option parity, trusted hover commands and desktop visual rendering remain unsupported or unverified. TextEditor.insertSnippet now uses the installed Monaco snippet controller for current selections or explicit Position/Range lists, with placeholder navigation, mirrored tabstops, undo options, write permissions, range preflight and stale editor/version rejection. Nested SnippetString callbacks preserve automatic tabstop numbering. Real Monaco editor tests under jsdom cover insertion, selections, Tab navigation, undo and read-only rejection; the real stdio host tests cover request routing and permissions. CLIPBOARD variables now read the native clipboard bridge only when the installed Monaco parser finds a real clipboard variable; escaped literals and empty location lists do not read it. Real Monaco tests with a mocked clipboard bridge cover multiline cursor spreading, transforms, empty-value fallbacks and rejection after model/selection/pane/read-only changes. Explicit ranges remain independent of cursor movement. Host reset invalidates pending snippet edits, and clipboard failures leave the document/version unchanged. Native Windows clipboard integration and complete VS Code variable-resolution parity remain unverified. Split text panes now retain distinct identities, view columns and visible ranges, with lifecycle events, targeted actions and stale-pane rejection. showTextDocument waits for its requested visible pane. File-backed showTextDocument supports Active/Beside/One-through-Nine columns, numeric/object overloads, editor focus preservation, explicit preview flags and clamped selections, with exact pane replies and cancellation on teardown/reset/closure. New inactive panes do not replace the current editor. Rendered-preview editor objects and preserving a covering webview's focus remain unsupported or incomplete. Unexpected model failures during commit do not have cross-model rollback. |
| Notebooks | Serializers, file-backed documents/cells, metadata, text edits, controller execution, textual outputs and save are connected to the dedicated workbench. Tests verify actual file persistence and dirty-cell preservation when an extension is disabled. NotebookEdit cell insertion/replacement/deletion and cell/notebook metadata updates now work through notebook-only WorkspaceEdit transactions, with validation before mutation, stable cell identities, reindexing and change events. The workbench supports New notebook, add/delete cells and Save As to a new file; exclusive creation refuses existing destinations and failures retain unsaved source text. Tests cover permissions, symlink containment, invalid/overlapping edits, serialization races and actual UI-to-file persistence. Mixed notebook/text/file WorkspaceEdit transactions, rich output renderers, native Jupyter integration and editor selections/affinity remain unsupported. Workbench undo/redo now restores text, metadata and structural snapshots with monotonic versions, edit/execution barriers, permission checks and bounded history (30 snapshots, approximately 10 MB across multiple snapshots). It recreates cell document identities on restore. Mixed text/file transactions and full native notebook editor behavior remain unsupported. |
| SCM | Providers, resource groups, input validation, selection, accept/resource commands and quick-diff URI resolution are exercised through the real host. The workbench displays groups and can compare original/current text through guarded workspace.fs. Advanced contribution menus/status commands remain incomplete; built-in Git is separate. |
| Languages | Completion, hover, definition, document/range formatting and diagnostics retain their implementations. References, type definitions, implementations, document highlights, document symbols and folding are now connected through HostBridge to Monaco. Navigation links preserve URI schemes and selection ranges. Selectors retain scheme/glob/relative bases and are checked in the host. Provider cancellation reaches extension tokens; deactivation and provider disposal cancel outstanding requests. Declaration, signature help/context, selection ranges, linked editing, on-type formatting and document links (including lazy resolution) now connect through the real host and Monaco adapter. Completion preserves trigger context, incomplete lists, insert/replace ranges, snippets, label details, commit characters, tags and lazy resolution with additional edits. Completion acceptance commands route back through host-owned command execution and dispose with the provider. Rename, code actions, CodeLens, inlay hints, colors and document/range semantic tokens now connect through the real host and HostBridge to Monaco. Lazy object/command state remains host-owned; text edits carry document versions and require write permissions and symlink containment. Semantic tokens currently use full results rather than delta optimization. Extension diagnostics can be queried across collections with change events; builtin language-server diagnostics are not mirrored. Inline completions now connect through the host/bridge, including snippets, context, ranges, cancellation/stale-model checks and host-owned acceptance commands. Filter text is checked before returning results, but Monaco also applies its own visibility rules; complete VS Code filter behavior is not certified. Call/type hierarchy and workspace symbols are available in Extension tools > Code navigation. Original extension objects remain host-owned for hierarchy follow-ups and lazy symbol resolution. Real-host tests cover identity, disposal and cancellation, including providers that ignore tokens. Searches have a 20-second cancellation limit. The panel opens local files; native Monaco hierarchy widgets, exact source-range reveal, folding change events and full selector semantics remain incomplete. No browser rendering test was run here. |
| Tasks/terminals | CustomExecution and extension pseudoterminals support output, input, dimensions, close and cancellation through host/workbench bridges. Shell/process tasks have a dedicated native process runner, PID and exit-status lifecycle, with early-output/exit regression coverage in frontend tests. Native Windows execution remains unverified here. Task output is parsed by the existing native engine for $tsc, $gcc, $msCompile, $eslint-compact, $rustc and supported one/two-line custom patterns; unsupported matcher definitions are disclosed before execution. Background readiness, matcher inheritance/loops, task terminal reuse, shell override options and full ShellQuotedString semantics remain incomplete. |
| Webviews/trees | Existing host modules and UI bridge need actual rendering, restore, messaging, CSP and resource-policy validation. |
| Lifecycle | Local tests cover the cases above. Native ESM loading, top-level await and generation-based dependency reload are now covered locally. Recovery after an OS-level host crash, activation timeouts and orphan-process cleanup still need validation or implementation. |
| Activation events | Rust Trigger currently covers startup, command, language, view and workspace contains. The Node host now activates onFileSystem providers, onNotebook serializers and onDebug/onDebugResolve/onDebugAdapterProtocolTracker/onDebugInitialConfigurations handlers at their actual call sites. Notebook/debug contributions provide implicit type activation, and concurrent activation is coalesced. The SCM workbench emits onView:workbench.scm. These direct Node paths do not expand the Rust Trigger enum; Task providers activate onTaskType from explicit activation events or contributed task definitions. URI triggers and a comprehensive event dispatch surface still require work. No invented onTest event is claimed. |
| Virtual documents | workspace.registerTextDocumentContentProvider now loads read-only content, coalesces concurrent opens, preserves URI query/fragment, refreshes on change with versioned full-replacement text events, cancels superseded reads and removes stale responses. Provider disposal/closure settle reads even when cancellation is ignored. Callbacks retain provider-owner permissions. The UI bridge refreshes an existing preview without switching focus or reopening a closed tab; closing its last tab releases the host mirror. Real-host and actual workspace/preview-service integration tests cover these paths. One provider per scheme is supported; multiple content-provider arbitration remains unsupported. Writable filesystem resources use native Monaco models and provider-backed saves; see the writable virtual documents validation above. |
| Window/environment | Active color theme and change events follow the real theme service. Status messages stack, restore older entries, settle timers/thenables and dispose with their extension. Desktop UIKind and the local remoteName value are exposed. Native open/save dialogs support file URIs, multiple selections and filters; mixed file/folder requests ask which native mode to use. Custom dialog button labels and virtual-scheme dialogs are not supported. Native Tauri/Windows dialogs were not executed. Dynamic QuickPick/InputBox objects support live values/items, active and selected objects, acceptance/hide, validation, toolbar/item buttons, focus handling and disposal through the real host and UI. Original selection/button identities stay in Node. Filtering is simple text matching and icon rendering is limited to labels; full VS Code quick-input visual behavior is not certified. Clipboard uses the native plugin. Progress uses cancellable status-bar items rather than native location-specific widgets. URI handlers and broader workbench window events remain incomplete. |
| Filesystems | Same-scheme file rename and file copy plus custom-provider delegation implemented. Cross-scheme transfers and local directory copy explicitly reject. Local rename overwrite=false has a check/rename race and needs an atomic platform implementation for a strict no-clobber guarantee. Provider file-change events feed URI-relative watchers and refresh open previews with stale-read guards. URI-relative watchers invoke provider.watch and dispose it once on watcher/provider teardown. Dirty documents are retained, deleted previews keep their last text, and writable native models now save through provider.writeFile. Virtual deletion/conflict UI and full session/autosave behavior remain incomplete. |
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
| `env.asExternalUri` | Present; partial or unverified |
| `env.clipboard` | Present; partial or unverified |
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
| `window.createInputBox` | Present; partial or unverified |
| `window.createOutputChannel` | Present; partial or unverified |
| `window.createQuickPick` | Present; partial or unverified |
| `window.createStatusBarItem` | Present; partial or unverified |
| `window.createTerminal` | Present; partial or unverified |
| `window.createTextEditorDecorationType` | Present; partial or unverified |
| `window.createTreeView` | Present; partial or unverified |
| `window.createWebviewPanel` | Present; partial or unverified |
| `window.onDidChangeActiveColorTheme` | Present; partial or unverified |
| `window.onDidChangeActiveNotebookEditor` | Unsupported |
| `window.onDidChangeActiveTerminal` | Unsupported |
| `window.onDidChangeActiveTextEditor` | Present; partial or unverified |
| `window.onDidChangeNotebookEditorSelection` | Unsupported |
| `window.onDidChangeNotebookEditorVisibleRanges` | Unsupported |
| `window.onDidChangeTerminalState` | Unsupported |
| `window.onDidChangeTextEditorOptions` | Present; partial or unverified |
| `window.onDidChangeTextEditorSelection` | Present; partial or unverified |
| `window.onDidChangeTextEditorViewColumn` | Present; partial or unverified |
| `window.onDidChangeTextEditorVisibleRanges` | Present; partial or unverified |
| `window.onDidChangeVisibleNotebookEditors` | Unsupported |
| `window.onDidChangeVisibleTextEditors` | Present; partial or unverified |
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
| `window.withProgress` | Present; partial or unverified |
| `window.withScmProgress` | Present; partial or unverified |
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
| `languages.registerCallHierarchyProvider` | Present; partial or unverified |
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
| `languages.registerTypeHierarchyProvider` | Present; partial or unverified |
| `languages.registerWorkspaceSymbolProvider` | Present; partial or unverified |
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
| `CallHierarchyIncomingCall` | Present; behavior needs per-member verification |
| `CallHierarchyItem` | Present; behavior needs per-member verification |
| `CallHierarchyOutgoingCall` | Present; behavior needs per-member verification |
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
| `QuickInputButtons` | Present; behavior needs per-member verification |
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
| `TypeHierarchyItem` | Present; behavior needs per-member verification |
| `UIKind` | Present; behavior needs per-member verification |
| `Uri` | Present; behavior needs per-member verification |
| `ViewColumn` | Present; behavior needs per-member verification |
| `WorkspaceEdit` | Present; behavior needs per-member verification |
| `version` | Present; behavior needs per-member verification |

Regenerate this document with the inventory.cjs command above. Behavioral evidence must be updated separately when integration tests run. Keep platform and compatibility gaps explicit; exports, builds and passing tests do not certify unsupported APIs or Windows integration.

