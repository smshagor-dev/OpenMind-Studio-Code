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

- Real child-process host activation: concurrent callers, shared dependencies, dependency exports, manifest cycles, runtime activation cycles, failure rollback/retry, uninstall during activation, concurrent deactivation and command ownership permissions.
- File operations on actual temporary files: copy, rename, overwrite rejection, missing source after rename, provider delegation and read-only rejection.
- Permission regression cases: outside destinations, existing symlink targets, future paths under symlinks and dangling symlinks. These are regression checks, not proof of a sandbox.
- Core contracts: command thisArg and disposal, nested workspace selection, relative paths and all 19 exported numeric enum objects against the official declaration values.

## Infrastructure still required

| Area | Observed implementation and remaining work |
| --- | --- |
| Debug | No debug namespace; extension adapter execution and workbench integration unsupported. Built-in debugging is a separate facility. |
| Testing | No tests namespace; extension test controllers, runs and Test Explorer integration unsupported. |
| Notebooks | No notebooks namespace; extension serializers/controllers and notebook WorkspaceEdit operations unsupported. |
| SCM | No scm namespace; extension providers unsupported. Built-in Git does not establish SCM API compatibility. |
| Languages | Completion, hover, definition, document/range formatting and diagnostics have host implementations. Additional provider families, resolution, cancellation and full selector fidelity remain incomplete. No Monaco UI tests were run here. |
| Tasks/terminals | Existing shell/process task and terminal bridges need live workbench validation. CustomExecution and problem matchers remain unsupported. |
| Webviews/trees | Existing host modules and UI bridge need actual rendering, restore, messaging, CSP and resource-policy validation. |
| Lifecycle | Local tests cover the cases above. Recovery after an OS-level host crash, activation timeouts, ESM loading and orphan-process cleanup still need validation or implementation. |
| Activation events | Rust Trigger currently covers startup, command, language, view and workspace contains. URI/filesystem/debug/task/test/notebook triggers are not implemented by this dispatch enum. |
| Filesystems | Same-scheme file rename and file copy plus custom-provider delegation implemented. Cross-scheme transfers and local directory copy explicitly reject. Local rename overwrite=false has a check/rename race and needs an atomic platform implementation for a strict no-clobber guarantee. Provider file-change events still require integration work. |
| Profiles/install/marketplace | Existing implementation has not been fully audited or executed here. VSIX install, dependencies, imports, updates, native modules and legal distribution sources require separate end-to-end evidence. |
| Permissions/isolation | Node require guards are not a security sandbox. Native code, process.binding, alternative loaders, shared module state, file descriptors and filesystem races remain limitations. Do not run hostile extensions as though isolated by these guards. Workspace Trust is not a verified enforcement boundary. |
| Platforms | Node tests ran on Linux with Node 24.19.0. Rust/Cargo is unavailable; Rust, TypeScript, Tauri and Windows builds were not run. No real marketplace extension compatibility or Windows result is claimed. |

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
