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

Verified Linux run on 2026-10-23: 29 Node tests passed; 95 Vitest tests passed across 7 extension-related files. Strict TypeScript validation of the Monaco adapter, its integration test, formatter registry and their imported dependencies passed. Full-project lint/build and Windows execution remain unverified.

- Real child-process host activation: concurrent callers, shared dependencies, dependency exports, manifest cycles, runtime activation cycles, failure rollback/retry, uninstall during activation, concurrent deactivation and command ownership permissions.
- File operations on actual temporary files: copy, rename, overwrite rejection, missing source after rename, provider delegation and read-only rejection.
- Permission regression cases: outside destinations, existing symlink targets, future paths under symlinks and dangling symlinks. These are regression checks, not proof of a sandbox.
- Core contracts: command thisArg and disposal, nested workspace selection, relative paths and all 20 exported numeric enum objects against the official declaration values. Parent cancellation and late-listener disposal are covered.
- Language providers: real stdio-host tests cover references, type definitions, implementations, highlights, nested symbols, folding, selectors and cancellation/disposal. Vitest sends requests through the real host and HostBridge into mocked Monaco registrations to verify coordinate conversion, URI schemes, reference context, disposal and cancellation. This does not establish browser rendering behavior.

## Infrastructure still required

| Area | Observed implementation and remaining work |
| --- | --- |
| Debug | No debug namespace; extension adapter execution and workbench integration unsupported. Built-in debugging is a separate facility. |
| Testing | No tests namespace; extension test controllers, runs and Test Explorer integration unsupported. |
| Notebooks | No notebooks namespace; extension serializers/controllers and notebook WorkspaceEdit operations unsupported. |
| SCM | No scm namespace; extension providers unsupported. Built-in Git does not establish SCM API compatibility. |
| Languages | Completion, hover, definition, document/range formatting and diagnostics retain their implementations. References, type definitions, implementations, document highlights, document symbols and folding are now connected through HostBridge to Monaco. Navigation links preserve URI schemes and selection ranges. Selectors retain scheme/glob/relative bases and are checked in the host. Provider cancellation reaches extension tokens; deactivation and provider disposal cancel outstanding requests. Additional families, completion/item resolution, folding change events and full selector semantics remain incomplete. No browser rendering test was run here. |
| Tasks/terminals | Existing shell/process task and terminal bridges need live workbench validation. CustomExecution and problem matchers remain unsupported. |
| Webviews/trees | Existing host modules and UI bridge need actual rendering, restore, messaging, CSP and resource-policy validation. |
| Lifecycle | Local tests cover the cases above. Recovery after an OS-level host crash, activation timeouts, ESM loading and orphan-process cleanup still need validation or implementation. |
| Activation events | Rust Trigger currently covers startup, command, language, view and workspace contains. URI/filesystem/debug/task/test/notebook triggers are not implemented by this dispatch enum. |
| Filesystems | Same-scheme file rename and file copy plus custom-provider delegation implemented. Cross-scheme transfers and local directory copy explicitly reject. Local rename overwrite=false has a check/rename race and needs an atomic platform implementation for a strict no-clobber guarantee. Provider file-change events still require integration work. |
| Profiles/install/marketplace | Existing implementation has not been fully audited or executed here. VSIX install, dependencies, imports, updates, native modules and legal distribution sources require separate end-to-end evidence. |
| Permissions/isolation | Node require guards are not a security sandbox. Native code, process.binding, alternative loaders, shared module state, file descriptors and filesystem races remain limitations. Do not run hostile extensions as though isolated by these guards. Workspace Trust is not a verified enforcement boundary. |
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
