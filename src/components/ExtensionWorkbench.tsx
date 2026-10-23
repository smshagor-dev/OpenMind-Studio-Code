import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { extensionWorkbench as service, type TestNode, type WorkbenchSnapshot, type ExtensionDomain } from "../services/extensionWorkbench";
import "../styles/extensionWorkbench.css";

const domains: { id: ExtensionDomain; label: string }[] = [
  { id: "tests", label: "Tests" }, { id: "debug", label: "Debug" }, { id: "notebooks", label: "Notebooks" }, { id: "scm", label: "Source Control" },
];
const act = (domain: ExtensionDomain, op: string, params?: Record<string, unknown>) => { void service.act(domain, op, params); };

export function ExtensionWorkbench() {
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state.visible && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!state.visible && dialog.current?.open) dialog.current.close();
  }, [state.visible]);
  return <dialog ref={dialog} className="extension-workbench" aria-label="Extension tools" onCancel={() => service.hide()}>
    <header><h2>Extension tools</h2><button type="button" onClick={() => service.hide()} aria-label="Close extension tools">Close</button></header>
    <nav aria-label="Extension tool categories">{domains.map(domain => <button key={domain.id} type="button" aria-pressed={state.domain === domain.id}
      onClick={() => { void service.show(domain.id); }}>{domain.label}</button>)}
      <button type="button" onClick={() => act(state.domain, "snapshot")}>Refresh</button></nav>
    {state.error ? <p role="alert" className="extension-workbench__error">{state.error}</p> : null}
    {!state.trusted && state.folders.length ? <section className="extension-workbench__trust"><p>Running tests, notebooks or debug targets can execute workspace code. Trust these folders only if you know their source.</p>
      <ul>{state.folders.map(folder => <li key={folder}>{folder}</li>)}</ul>
      <button type="button" onClick={() => act(state.domain, "trust", { folders: state.folders })}>Trust this workspace</button></section> : null}
    {state.pending > 0 ? <p role="status">Working…</p> : null}
    <main>
      {state.domain === "tests" ? <Tests value={state.snapshot.tests} /> : null}
      {state.domain === "scm" ? <Scm value={state.snapshot.scm} /> : null}
      {state.domain === "notebooks" ? <Notebooks value={state.snapshot.notebooks} /> : null}
      {state.domain === "debug" ? <Debug value={state.snapshot.debug} /> : null}
    </main>
  </dialog>;
}

function TestTree({ nodes, run }: { nodes: TestNode[]; run: (id: string) => void }) {
  return <ul>{nodes.map(node => <li key={node.id}><span>{node.label}</span> <button type="button" onClick={() => run(node.id)}>Run</button>
    {node.children.length ? <TestTree nodes={node.children} run={run} /> : null}</li>)}</ul>;
}
function Tests({ value }: { value: WorkbenchSnapshot["tests"] }) {
  return <>
    {!value.controllers.length ? <p>No active extension has registered a test controller. Enable a testing extension and run its activation command.</p> : null}
    {value.controllers.map(controller => <section key={controller.handle}><h3>{controller.label}</h3>
      <button type="button" onClick={() => act("tests", "discover", { controller: controller.handle })}>Discover tests</button>
      {controller.profiles.map(profile => <button key={profile.id} type="button" onClick={() => act("tests", "run", { controller: controller.handle, profile: profile.id })}>{profile.label}</button>)}
      <TestTree nodes={controller.items} run={id => {
        const profile = controller.profiles.find(p => p.kind === 1) || controller.profiles[0];
        if (profile) act("tests", "run", { controller: controller.handle, profile: profile.id, include: [id] });
      }} />
    </section>)}
    {value.runs.map(run => <section key={run.id}><h3>{run.name} · {run.ended ? "Finished" : "Running"}</h3>
      {!run.ended ? <button type="button" onClick={() => act("tests", "cancel", { run: run.id })}>Cancel run</button> : null}
      <ul>{run.results.map(result => <li key={result.id}><strong>{result.status}</strong> {result.label}
        {result.messages.map((message, i) => <pre key={i}>{message.message}</pre>)}</li>)}</ul><pre>{run.output}</pre>
    </section>)}
  </>;
}
function Scm({ value }: { value: WorkbenchSnapshot["scm"] }) {
  const [comparison, setComparison] = useState<{ original: string; current: string; truncated: boolean } | null>(null);
  return <>{!value.providers.length ? <p>No active extension has registered a source control provider. Built-in Git remains available in Source Control.</p> : null}
    {value.providers.map(provider => <section key={provider.handle}><h3>{provider.label}</h3>
      <button type="button" onClick={() => act("scm", "select", { provider: provider.handle })}>Select provider</button>
      <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); act("scm", "accept", { provider: provider.handle, value: String(data.get("message") || "") }); }}>
        <label>Message<textarea key={provider.input.value} name="message" defaultValue={provider.input.value} placeholder={provider.input.placeholder} disabled={!provider.input.enabled} /></label>
        {provider.canAccept ? <button type="submit" disabled={!provider.input.enabled}>Submit</button> : null}
      </form>
      {provider.groups.map(group => <div key={group.id}><h4>{group.label}</h4><ul>{group.resources.map(resource => <li key={resource.index} title={resource.tooltip}>
        {resource.hasCommand ? <button type="button" onClick={() => act("scm", "open", { provider: provider.handle, group: group.id, index: resource.index })}>{resource.uri}</button> : <span>{resource.uri}</span>}
        <button type="button" onClick={() => { void service.act("scm", "compare", { provider: provider.handle, group: group.id, index: resource.index }).then(result => {
          if (result && typeof result === "object" && "original" in result && "current" in result) setComparison({ original: String(result.original), current: String(result.current), truncated: "truncated" in result && result.truncated === true });
        }); }}>Compare</button>
      </li>)}</ul></div>)}
    </section>)}
    {comparison ? <section><h3>Original and current resource</h3>{comparison.truncated ? <p>Preview limited to 64 KB per resource.</p> : null}
      <div className="extension-workbench__compare"><div><h4>Original</h4><pre>{comparison.original}</pre></div><div><h4>Current</h4><pre>{comparison.current}</pre></div></div></section> : null}
  </>;
}
function Notebooks({ value }: { value: WorkbenchSnapshot["notebooks"] }) {
  const [controller, setController] = useState("");
  return <>
    <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); act("notebooks", "open", { type: data.get("type"), path: data.get("path") }); }}>
      <label>Notebook format<select name="type" required>{value.serializers.map(type => <option key={type}>{type}</option>)}</select></label>
      <label>File path<input name="path" placeholder="Path to your notebook" /></label><button type="submit" disabled={!value.serializers.length}>Open notebook</button>
      <button type="button" disabled={!value.serializers.length} onClick={event => { const form = event.currentTarget.form; if (form) act("notebooks", "new", { type: new FormData(form).get("type") }); }}>New notebook</button>
    </form>
    {!value.serializers.length ? <p>No active extension has registered a notebook serializer. Existing Jupyter notebooks remain available through the normal editor.</p> : null}
    {value.documents.map(document => <section key={document.uri}><h3>{document.uri}{document.dirty ? " · Unsaved" : ""}</h3>
      {document.unavailable ? <p role="alert">The notebook extension is unavailable. Your unsaved cells are retained.</p> : null}
      <label>Controller<select value={controller} onChange={event => setController(event.target.value)}><option value="">Choose a controller</option>
        {value.controllers.filter(c => c.notebookType === document.notebookType).map(c => <option key={c.handle} value={c.handle}>{c.label}</option>)}</select></label>
      <button type="button" disabled={!controller} onClick={() => act("notebooks", "execute", { uri: document.uri, controller })}>Run all</button>
      <button type="button" onClick={() => act("notebooks", "cancel", { uri: document.uri })}>Cancel execution</button>
      <button type="button" disabled={document.unavailable || document.uri.startsWith("untitled:")} onClick={() => act("notebooks", "save", { uri: document.uri })}>Save notebook</button>
      <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); act("notebooks", "saveAs", { uri: document.uri, path: data.get("destination") }); }}>
        <label>Save to a new file<input name="destination" required placeholder="New notebook file path" /></label>
        <button type="submit" disabled={document.unavailable || document.cells.some(cell => cell.running)}>Save as</button>
      </form>
      <button type="button" onClick={() => act("notebooks", "close", { uri: document.uri })}>Close notebook</button>
      <button type="button" disabled={document.unavailable || document.cells.some(cell => cell.running)} onClick={() => act("notebooks", "insert", { uri: document.uri, version: document.version, index: document.cells.length, cellIds: document.cells.map(cell => cell.id), languageId: document.cells.at(-1)?.languageId })}>Add code cell</button>
      {document.cells.map(cell => <article key={cell.id || cell.index}><label>Cell {cell.index + 1} · {cell.languageId}
        <textarea key={cell.id || `${document.uri}/${cell.index}`} defaultValue={cell.value} spellCheck={false} disabled={cell.running || document.unavailable}
          onBlur={event => { if (event.target.value !== cell.value) act("notebooks", "edit", { uri: document.uri, index: cell.index, version: document.version, previousValue: cell.value, value: event.target.value }); }} /></label>
        {cell.kind === 2 ? <button type="button" disabled={!controller || cell.running} onClick={() => act("notebooks", "execute", { uri: document.uri, controller, indices: [cell.index] })}>{cell.running ? "Running…" : "Run cell"}</button> : null}
        <button type="button" disabled={document.unavailable || document.cells.some(value => value.running)} onClick={() => act("notebooks", "delete", { uri: document.uri, version: document.version, index: cell.index, cellIds: document.cells.map(value => value.id) })}>Delete cell {cell.index + 1}</button>
        {cell.outputs.map((output, i) => <pre key={i} aria-label={output.mime}>{output.text}</pre>)}
      </article>)}
    </section>)}
  </>;
}
function Debug({ value }: { value: WorkbenchSnapshot["debug"] }) {
  const [result, setResult] = useState<unknown>(null);
  const request = async (session: string, op: string, args: Record<string, unknown>) => setResult(await service.act("debug", op, { session, arguments: args }));
  const objects = (value: unknown, key: string): Record<string, unknown>[] => {
    if (!value || typeof value !== "object") return [];
    const items: unknown = (value as Record<string, unknown>)[key]; return Array.isArray(items) ? items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  };
  return <>
    {!value.types.length ? <p>No active extension has registered a debug adapter. Built-in Run and Debug remains available.</p> : null}
    <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget);
      act("debug", "start", { configuration: { type: data.get("type"), request: data.get("request"), name: "Extension debug session", program: data.get("program"), stopOnEntry: true } }); }}>
      <label>Adapter<select name="type">{value.types.map(type => <option key={type}>{type}</option>)}</select></label>
      <label>Mode<select name="request"><option value="launch">Launch</option><option value="attach">Attach</option></select></label>
      <label>Program<input name="program" required /></label><button type="submit" disabled={!value.types.length}>Start debugging</button>
    </form>
    {value.sessions.map(session => <section key={session.id}><h3>{session.name} · {session.state}</h3>
      {([['continue', 'Continue'], ['pause', 'Pause'], ['next', 'Step over'], ['stepIn', 'Step into'], ['stepOut', 'Step out']] as const).map(([op, label]) =>
        <button key={op} type="button" disabled={session.threadId === undefined} onClick={() => { void request(session.id, op, { threadId: session.threadId }); }}>{label}</button>)}
      <button type="button" onClick={() => act("debug", "stop", { session: session.id })}>Stop</button>
      <button type="button" onClick={() => { void request(session.id, "threads", {}); }}>Threads</button>
      {objects(result, "threads").map(thread => <button key={String(thread.id)} type="button" onClick={() => { void request(session.id, "stackTrace", { threadId: thread.id }); }}>{String(thread.name)}</button>)}
      {objects(result, "stackFrames").map(frame => <button key={String(frame.id)} type="button" onClick={() => { void request(session.id, "scopes", { frameId: frame.id }); }}>{String(frame.name)} · {String(frame.line)}</button>)}
      {objects(result, "scopes").map(scope => <button key={String(scope.variablesReference)} type="button" onClick={() => { void request(session.id, "variables", { variablesReference: scope.variablesReference }); }}>{String(scope.name)}</button>)}
      <ul>{objects(result, "variables").map(variable => <li key={String(variable.name)}>{String(variable.name)} = {String(variable.value)}
        {Number(variable.variablesReference) > 0 ? <button type="button" onClick={() => { void request(session.id, "variables", { variablesReference: variable.variablesReference }); }}>Expand</button> : null}</li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void request(session.id, "evaluate", { expression: data.get("expression"), context: "repl" }); }}>
        <label>Evaluate<input name="expression" required /></label><button type="submit">Evaluate</button></form>
      {result && typeof result === "object" && "result" in result ? <pre>{String(result.result)}</pre> : null}
      <pre>{session.output.join("")}</pre>
    </section>)}
  </>;
}
