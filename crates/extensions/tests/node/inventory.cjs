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

Verified Linux run on 2026-10-23: 46 Node tests passed; 100 Vitest tests passed across 8 extension-related files. Strict TypeScript validation of the extension workbench, service, Monaco adapter and their integration tests/imported dependencies passed. Full-project lint/build and Windows execution remain unverified.

- Real child-process host activation: concurrent callers, shared dependencies, dependency exports, manifest cycles, runtime activation cycles, failure rollback/retry, uninstall during activation, concurrent deactivation and command ownership permissions.
- File operations on actual temporary files: copy, rename, overwrite rejection, missing source after rename, provider delegation and read-only rejection.
- Permission regression cases: outside destinations, existing symlink targets, future paths under symlinks and dangling symlinks. These are regression checks, not proof of a sandbox.
- Core contracts: command thisArg and disposal, nested workspace selection, relative paths and all 22 exported numeric enum objects against the official declaration values. Parent cancellation and late-listener disposal are covered.
- Notebook edits and saves: serializer inputs are copied to keep extension-owned/frozen objects from corrupting transaction state. Save As uses guarded exclusive writes and retains the original document when serialization fails or newer edits arrive.
- Workbench: real-host tests cover test discovery/execution/cancellation, SCM commands/validation, notebook editing/execution/save, trust grants and adapter permissions. React integration renders the actual dialog against the child-process host. Frontend tests also cover stale responses, dirty notebook retention and failed-edit barriers. Native Tauri rendering remains unverified.
- Language providers: real stdio-host tests cover references, type definitions, implementations, highlights, nested symbols, folding, selectors and cancellation/disposal. Vitest sends requests through the real host and HostBridge into mocked Monaco registrations to verify coordinate conversion, URI schemes, reference context, disposal and cancellation. This does not establish browser rendering behavior.

## Implemented subsets and remaining work

| Area | Observed implementation and remaining work |
| --- | --- |
| Debug | Executable, socket and inline DAP transports, configuration/factory registration, sessions, source/function breakpoints and a dedicated workbench are implemented. A real debugpy adapter launched Python, stopped at a conditional breakpoint, returned threads/frames/scopes/variables, evaluated an expression and disconnected in the Node suite. Attach/restart are not integration-tested; reverse requests (including runInTerminal), trackers, data breakpoints and native editor gutter integration remain unsupported. |
| Testing | Controllers, hierarchical discovery, run profiles, selected execution, results/diffs/output and cancellation are connected to the dedicated workbench and tested with actual extension code. Continuous testing and detailed coverage reporting remain unsupported. This is not a marketplace test-extension certification. |
| Notebooks | Serializers, file-backed documents/cells, metadata, text edits, controller execution, textual outputs and save are connected to the dedicated workbench. Tests verify actual file persistence and dirty-cell preservation when an extension is disabled. NotebookEdit cell insertion/replacement/deletion and cell/notebook metadata updates now work through notebook-only WorkspaceEdit transactions, with validation before mutation, stable cell identities, reindexing and change events. The workbench supports New notebook, add/delete cells and Save As to a new file; exclusive creation refuses existing destinations and failures retain unsaved source text. Tests cover permissions, symlink containment, invalid/overlapping edits, serialization races and actual UI-to-file persistence. Mixed notebook/text/file WorkspaceEdit transactions, rich output renderers, native Jupyter integration and editor selections/affinity remain unsupported. No undo/redo integration is claimed. |
| SCM | Providers, resource groups, input validation, selection, accept/resource commands and quick-diff URI resolution are exercised through the real host. The workbench displays groups and can compare original/current text through guarded workspace.fs. Advanced contribution menus/status commands remain incomplete; built-in Git is separate. |
| Languages | Completion, hover, definition, document/range formatting and diagnostics retain their implementations. References, type definitions, implementations, document highlights, document symbols and folding are now connected through HostBridge to Monaco. Navigation links preserve URI schemes and selection ranges. Selectors retain scheme/glob/relative bases and are checked in the host. Provider cancellation reaches extension tokens; deactivation and provider disposal cancel outstanding requests. Additional families, completion/item resolution, folding change events and full selector semantics remain incomplete. No browser rendering test was run here. |
| Tasks/terminals | Existing shell/process task and terminal bridges need live workbench validation. CustomExecution and problem matchers remain unsupported. |
| Webviews/trees | Existing host modules and UI bridge need actual rendering, restore, messaging, CSP and resource-policy validation. |
| Lifecycle | Local tests cover the cases above. Recovery after an OS-level host crash, activation timeouts, ESM loading and orphan-process cleanup still need validation or implementation. |
| Activation events | Rust Trigger currently covers startup, command, language, view and workspace contains. URI/filesystem/debug/task/test/notebook triggers are not implemented by this dispatch enum. |
| Filesystems | Same-scheme file rename and file copy plus custom-provider delegation implemented. Cross-scheme transfers and local directory copy explicitly reject. Local rename overwrite=false has a check/rename race and needs an atomic platform implementation for a strict no-clobber guarantee. Provider file-change events still require integration work. |
| Profiles/install/marketplace | Existing implementation has not been fully audited or executed here. VSIX install, dependencies, imports, updates, native modules and legal distribution sources require separate end-to-end evidence. |
| Permissions/isolation | Node require guards are not a security sandbox. Native code, process.binding, alternative loaders, shared module state, file descriptors and filesystem races remain limitations. Do not run hostile extensions as though isolated by these guards. Workspace Trust defaults to untrusted; workbench execution requires an explicit session grant for the exact current roots, and manifests explicitly rejecting untrusted workspaces cannot activate there. These checks are tested; full VS Code restricted-settings semantics and an OS isolation boundary are not provided. |
| Platforms | Node and focused Vitest tests ran on Linux with Node 24.19.0. A strict TypeScript check of the Monaco adapter, integration test and their imported dependency graph passed against Monaco 0.56.0; this is not a full-project build. Rust/Cargo is unavailable; Rust, Tauri and Windows builds were not run. No real marketplace extension compatibility or Windows result is claimed. |

## Namespace member inventory

| Official member | Current host status |
| --- | --- |
${rows.join('\n')}

## Top-level runtime value inventory

| Official value | Current host status |
| --- | --- |
${topRows.join('\n')}

Regenerate this document with the inventory.cjs command above. Behavioral evidence must be updated separately when integration tests run. Keep PR #32 in draft until required validation and integration work are complete.
`);
disposeApi(api);
