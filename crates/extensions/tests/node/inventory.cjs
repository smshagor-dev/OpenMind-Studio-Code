'use strict';

// Usage: node crates/extensions/tests/node/inventory.cjs /path/to/vscode.d.ts
// Use the 1.85.2 declaration file linked below. Symbol presence is never runtime evidence.
const fs = require('node:fs');
const { fixture } = require('./api-fixture.cjs');
const { disposeApi } = require('../../host/vscode.js');
if (!process.argv[2]) throw new Error('Pass the official VS Code 1.85.2 vscode.d.ts path.');
const declarations = fs.readFileSync(process.argv[2], 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const { api } = fixture();
const rows = [];
for (const match of declarations.matchAll(/\texport namespace (\w+) \{/g)) {
  const name = match[1];
  const start = match.index + match[0].length;
  // Namespace closing braces have one tab; nested declarations have at least two.
  const end = declarations.indexOf('\n\t}', start);
  const body = declarations.slice(start, end);
  const members = [...new Set([...body.matchAll(/^\t\texport (?:function|const|let) (\w+)/gm)].map(x => x[1]))].sort();
  const namespaceExists = Object.hasOwn(api, name);
  for (const member of members) {
    const exists = namespaceExists && Object.hasOwn(api[name], member);
    rows.push(`| \`${name}.${member}\` | ${exists ? 'Present; partial or unverified' : 'Unsupported'} |`);
  }
}
const topLevel = [...new Set([...declarations.matchAll(/^\texport (?:class|enum|(?:abstract )?class|(?:const|let)) (\w+)/gm)].map(x => x[1]))].sort();
const topRows = topLevel.map(name => `| \`${name}\` | ${Object.hasOwn(api, name) ? 'Present; behavior needs per-member verification' : 'Unsupported'} |`);
console.log(`# VS Code extension compatibility inventory

Reference: [VS Code 1.85.2 declarations](https://github.com/microsoft/vscode/blob/1.85.2/src/vscode-dts/vscode.d.ts).
The host currently exposes vscode.version = 1.85.0. This is a declaration comparison baseline, **not a claim of complete 1.85 compatibility**. No complete stable API version has been verified. Do not use the version or successful installation alone to classify an extension as compatible.

This inventory enumerates runtime namespace exports and top-level value exports against that baseline. Interfaces and type aliases are compile-time declarations, not runtime exports. Presence is detected with Object.hasOwn, so the unsupported-API proxy cannot masquerade as an implemented member. Overloads and individual class methods are not measured by this listing. Present means partial or unverified unless the behavioral evidence below says otherwise. It does not mean end-to-end workbench support.

## Verified behavior in the local Node tests

Run: node --test crates/extensions/tests/node/*.test.cjs

Verified Linux run on 2026-10-23: 72 Node tests passed with zero skips; the full frontend suite passed 2,684 tests across 254 files. Full-project TypeScript validation and the Vite production bundle passed. ESLint passed for the advanced-provider adapter and HostBridge; full-project lint was not run. The packaging prebuild needs Cargo metadata and could not run without Cargo. Rust/Tauri and Windows execution remain unverified.

- Real child-process host activation: concurrent callers, shared dependencies, dependency exports, manifest cycles, runtime activation cycles, failure rollback/retry, uninstall during activation, concurrent deactivation and command ownership permissions.
- File operations on actual temporary files: copy, rename, overwrite rejection, missing source after rename, provider delegation and read-only rejection.
- Permission regression cases: outside destinations, existing symlink targets, future paths under symlinks and dangling symlinks. These are regression checks, not proof of a sandbox.
- Core contracts: command thisArg and disposal, nested workspace selection, relative paths and all 23 exported numeric enum objects against the official declaration values. Parent cancellation and late-listener disposal are covered.
- Notebook edits and saves: serializer inputs are copied to keep extension-owned/frozen objects from corrupting transaction state. Save As uses guarded exclusive writes and retains the original document when serialization fails or newer edits arrive.
- Workbench: real-host tests cover test discovery/execution/cancellation, SCM commands/validation, notebook editing/execution/save, trust grants and adapter permissions. React integration renders the actual dialog against the child-process host. Frontend tests also cover stale responses, dirty notebook retention and failed-edit barriers. Native Tauri rendering remains unverified.
- Additional provider evidence: real-host/HostBridge tests cover declaration, signature context, selection parent flattening, linked word patterns, on-type edit mapping, lazy link and completion resolution, snippet flags, incomplete results and extra edits. Monaco registrations remain mocked.
- Advanced language providers: real host/HostBridge/Monaco-adapter tests now cover prepared multi-file rename with versioned text edits, code-action diagnostics/kind context and lazy resolution, CodeLens refresh/resolution, inlay-hint label-part commands/locations/resolution, color presentation edits and full/range semantic tokens with legends and sorted builders. Original extension objects and command arguments stay in the host. Write permissions, symlink escapes, stale/released items, disabled commands, cancellation and deactivation are covered by real-host tests. Extension diagnostic aggregation and change events retain URI identities; builtin LSP diagnostic collections are not mirrored into the host. Monaco registrations remain mocked.
- Language providers: real stdio-host tests cover references, type definitions, implementations, highlights, nested symbols, folding, selectors and cancellation/disposal. Vitest sends requests through the real host and HostBridge into mocked Monaco registrations to verify coordinate conversion, URI schemes, reference context, disposal and cancellation. This does not establish browser rendering behavior.

## Implemented subsets and remaining work

| Area | Observed implementation and remaining work |
| --- | --- |
| Debug | Executable, socket and inline DAP transports, configuration/factory registration, sessions, source/function breakpoints and a dedicated workbench are implemented. A real debugpy adapter launched Python, stopped at a conditional breakpoint, returned threads/frames/scopes/variables, evaluated an expression and disconnected in the Node suite. Attach/restart are not integration-tested; Tracker factories (including wildcard and multiple registrations) now observe real DAP, preserve callback owner permissions and isolate tracker exceptions/mutations. Adapter-confirmed source/function breakpoints are available through DebugSession.getDebugProtocolBreakpoint. Inline and loopback TCP transports have real host integration tests, including failure cleanup and adapter-initiated termination. Transport ownership remains tracked while disconnect is pending, so extension teardown can still close it. Reverse requests (including runInTerminal), virtual debug sources, data breakpoints and native editor gutter integration remain unsupported. |
| Testing | Controllers, hierarchical discovery, run profiles, selected execution, results/diffs/output and cancellation are connected to the dedicated workbench and tested with actual extension code. Continuous testing and detailed coverage reporting remain unsupported. This is not a marketplace test-extension certification. |
| Notebooks | Serializers, file-backed documents/cells, metadata, text edits, controller execution, textual outputs and save are connected to the dedicated workbench. Tests verify actual file persistence and dirty-cell preservation when an extension is disabled. NotebookEdit cell insertion/replacement/deletion and cell/notebook metadata updates now work through notebook-only WorkspaceEdit transactions, with validation before mutation, stable cell identities, reindexing and change events. The workbench supports New notebook, add/delete cells and Save As to a new file; exclusive creation refuses existing destinations and failures retain unsaved source text. Tests cover permissions, symlink containment, invalid/overlapping edits, serialization races and actual UI-to-file persistence. Mixed notebook/text/file WorkspaceEdit transactions, rich output renderers, native Jupyter integration and editor selections/affinity remain unsupported. No undo/redo integration is claimed. |
| SCM | Providers, resource groups, input validation, selection, accept/resource commands and quick-diff URI resolution are exercised through the real host. The workbench displays groups and can compare original/current text through guarded workspace.fs. Advanced contribution menus/status commands remain incomplete; built-in Git is separate. |
| Languages | Completion, hover, definition, document/range formatting and diagnostics retain their implementations. References, type definitions, implementations, document highlights, document symbols and folding are now connected through HostBridge to Monaco. Navigation links preserve URI schemes and selection ranges. Selectors retain scheme/glob/relative bases and are checked in the host. Provider cancellation reaches extension tokens; deactivation and provider disposal cancel outstanding requests. Declaration, signature help/context, selection ranges, linked editing, on-type formatting and document links (including lazy resolution) now connect through the real host and Monaco adapter. Completion preserves trigger context, incomplete lists, insert/replace ranges, snippets, label details, commit characters, tags and lazy resolution with additional edits. Completion acceptance commands route back through host-owned command execution and dispose with the provider. Rename, code actions, CodeLens, inlay hints, colors and document/range semantic tokens now connect through the real host and HostBridge to Monaco. Lazy object/command state remains host-owned; text edits carry document versions and require write permissions and symlink containment. Semantic tokens currently use full results rather than delta optimization. Extension diagnostics can be queried across collections with change events; builtin language-server diagnostics are not mirrored. Call/type hierarchy, inline completions, workspace symbols, folding change events and full selector semantics remain incomplete. No browser rendering test was run here. |
| Tasks/terminals | Existing shell/process task and terminal bridges need live workbench validation. CustomExecution and problem matchers remain unsupported. |
| Webviews/trees | Existing host modules and UI bridge need actual rendering, restore, messaging, CSP and resource-policy validation. |
| Lifecycle | Local tests cover the cases above. Recovery after an OS-level host crash, activation timeouts, ESM loading and orphan-process cleanup still need validation or implementation. |
| Activation events | Rust Trigger currently covers startup, command, language, view and workspace contains. The Node host now activates onFileSystem providers, onNotebook serializers and onDebug/onDebugResolve/onDebugAdapterProtocolTracker/onDebugInitialConfigurations handlers at their actual call sites. Notebook/debug contributions provide implicit type activation, and concurrent activation is coalesced. The SCM workbench emits onView:workbench.scm. These direct Node paths do not expand the Rust Trigger enum; URI/task triggers and a comprehensive event dispatch surface still require work. No invented onTest event is claimed. |
| Virtual documents | workspace.registerTextDocumentContentProvider now loads read-only content, coalesces concurrent opens, preserves URI query/fragment, refreshes on change with versioned full-replacement text events, cancels superseded reads and removes stale responses. Provider disposal/closure settle reads even when cancellation is ignored. Callbacks retain provider-owner permissions. The UI bridge refreshes an existing preview without switching focus or reopening a closed tab; closing its last tab releases the host mirror. Real-host and actual workspace/preview-service integration tests cover these paths. One provider per scheme is supported; multiple content-provider arbitration and fully editable virtual Monaco models remain unsupported. |
| Filesystems | Same-scheme file rename and file copy plus custom-provider delegation implemented. Cross-scheme transfers and local directory copy explicitly reject. Local rename overwrite=false has a check/rename race and needs an atomic platform implementation for a strict no-clobber guarantee. Provider file-change events still require integration work. |
| Profiles/install/marketplace | Existing implementation has not been fully audited or executed here. VSIX install, dependencies, imports, updates, native modules and legal distribution sources require separate end-to-end evidence. |
| Permissions/isolation | Node require guards are not a security sandbox. Native code, process.binding, alternative loaders, shared module state, file descriptors and filesystem races remain limitations. Do not run hostile extensions as though isolated by these guards. Workspace Trust defaults to untrusted; workbench execution requires an explicit session grant for the exact current roots, and manifests explicitly rejecting untrusted workspaces cannot activate there. These checks are tested; full VS Code restricted-settings semantics and an OS isolation boundary are not provided. |
| Platforms | Node and focused Vitest tests ran on Linux with Node 24.19.0. Full-project TypeScript checks and the Vite production build passed against Monaco 0.56.0. Rust/Cargo is unavailable; Rust, Tauri and Windows builds were not run. No real marketplace extension compatibility or Windows result is claimed. |

## Namespace member inventory

| Official member | Current host status |
| --- | --- |
${rows.join('\n')}

## Top-level runtime value inventory

| Official value | Current host status |
| --- | --- |
${topRows.join('\n')}

Regenerate this document with the inventory.cjs command above. Behavioral evidence must be updated separately when integration tests run. The implemented subset can be integrated independently of full VS Code parity. Keep the remaining platform and compatibility gaps explicit; merging does not certify unsupported APIs or Windows integration.
`);
disposeApi(api);
