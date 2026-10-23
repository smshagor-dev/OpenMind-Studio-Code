import { useEffect, useRef } from "react";
import type { DynamicQuickInput, ExtensionPromptService } from "../services/extensionPromptService";

export function DynamicExtensionQuickInput({ prompt, service }: { prompt: DynamicQuickInput; service: ExtensionPromptService }) {
  const input = useRef<HTMLInputElement>(null);
  const selectionStart = prompt.valueSelection?.[0], selectionEnd = prompt.valueSelection?.[1];
  const dialog = useRef<HTMLDivElement>(null);
  const event = (name: string, params?: Record<string, unknown>) => { service.quickInputEvent(name, params); };
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (selectionStart !== undefined && selectionEnd !== undefined) input.current?.setSelectionRange(selectionStart, selectionEnd); }, [selectionStart, selectionEnd]);
  const query = prompt.value.toLocaleLowerCase();
  const items = prompt.items.filter(item => item.kind === -1 || item.alwaysShow || [item.label, prompt.matchOnDescription ? item.description : "", prompt.matchOnDetail ? item.detail : ""].some(value => value?.toLocaleLowerCase().includes(query)));
  const validation = typeof prompt.validationMessage === "string" ? prompt.validationMessage : prompt.validationMessage?.message;
  const invalid = !!validation && (typeof prompt.validationMessage === "string" || prompt.validationMessage?.severity === 3);
  function accept() {
    if (!prompt.enabled || invalid) return;
    if (prompt.kind === "quickPick" && !prompt.canSelectMany && !prompt.selectedItems.length) { const active = prompt.activeItems.length ? prompt.activeItems : items.find(item => item.kind !== -1)?.id; event("selection", { items: Array.isArray(active) ? active : active ? [active] : [] }); }
    event("accept");
  }
  return <div className="modal-overlay modal-overlay--prompt" onMouseDown={e => { if (e.target === e.currentTarget && !prompt.ignoreFocusOut) event("hide"); }}>
    <div ref={dialog} className="modal ext-quickpick" role="dialog" aria-modal="true" aria-label={prompt.title || prompt.placeholder || prompt.extension}
      onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); event("hide"); }
        if (e.key === "Enter" && e.target === input.current) { e.preventDefault(); accept(); }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && prompt.kind === "quickPick") {
          const selectable = items.filter(item => item.kind !== -1);
          if (selectable.length) { const index = selectable.findIndex(item => prompt.activeItems.includes(item.id)); const next = index < 0 ? e.key === "ArrowDown" ? 0 : selectable.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + selectable.length) % selectable.length; const active = selectable[next]; if (active) event("active", { items: [active.id] }); e.preventDefault(); }
        }
        if (e.key === "Tab") {
          const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)") ?? [])];
          if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
          else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
        }
      }}>
      <h2>{prompt.title || prompt.extension}{prompt.step ? ` (${prompt.step}${prompt.totalSteps ? `/${prompt.totalSteps}` : ""})` : ""}</h2>
      {prompt.prompt ? <p>{prompt.prompt}</p> : null}
      <div>{prompt.buttons.map(button => <button key={button.id} type="button" disabled={!prompt.enabled} title={button.tooltip} onClick={() => { event("button", { button: button.id }); }}>{button.back ? "Back" : button.tooltip || "Action"}</button>)}</div>
      <input ref={input} type={prompt.password ? "password" : "text"} aria-label={prompt.placeholder || prompt.title || "Quick input"} placeholder={prompt.placeholder} value={prompt.value} disabled={!prompt.enabled} aria-invalid={invalid}
        onChange={e => { event("value", { value: e.target.value }); }} />
      {prompt.busy ? <p role="status">Working…</p> : null}
      {validation ? <p role="alert">{validation}</p> : null}
      {prompt.kind === "quickPick" ? <ul className="ext-plain-list" style={{ maxHeight: "45vh", overflowY: "auto" }}>{items.map(item => <li key={item.id}>
        {item.kind === -1 ? <strong>{item.label}</strong> : <>
          <button type="button" className={prompt.activeItems.includes(item.id) || prompt.selectedItems.includes(item.id) ? "ext-pick ext-pick--on" : "ext-pick"} disabled={!prompt.enabled}
            aria-pressed={prompt.selectedItems.includes(item.id)} onFocus={() => { event("active", { items: [item.id] }); }}
            onClick={() => { event("active", { items: [item.id] }); event("selection", { items: prompt.canSelectMany ? prompt.selectedItems.includes(item.id) ? prompt.selectedItems.filter(id => id !== item.id) : [...prompt.selectedItems, item.id] : [item.id] }); if (!prompt.canSelectMany) event("accept"); }}>
            <span>{item.label}</span>{item.description ? <span className="ext-note"> {item.description}</span> : null}{item.detail ? <span className="ext-note"> {item.detail}</span> : null}
          </button>
          {item.buttons.map(button => <button key={button.id} type="button" disabled={!prompt.enabled} title={button.tooltip} onClick={() => { event("itemButton", { item: item.id, button: button.id }); }}>{button.tooltip || "Action"}</button>)}
        </>}
      </li>)}</ul> : null}
      <div className="modal__actions"><button type="button" disabled={!prompt.enabled || invalid} onClick={accept}>OK</button><button type="button" onClick={() => { event("hide"); }}>Cancel</button></div>
    </div>
  </div>;
}
