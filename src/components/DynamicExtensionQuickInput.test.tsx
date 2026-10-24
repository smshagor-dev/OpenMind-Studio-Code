import { createRequire } from "node:module";
import { useSyncExternalStore } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DynamicExtensionQuickInput } from "./DynamicExtensionQuickInput";
import { ExtensionPromptService, type DynamicQuickInput } from "../services/extensionPromptService";
const require = createRequire(import.meta.url);
interface Fixture { request(method: string, params?: unknown): Promise<unknown>; onNotification(listener: (m: { method: string; params: Record<string, unknown> }) => void): () => void }
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as { fixture: (t: { after(callback: () => Promise<void>): void }, definitions: Record<string, { code: string }>) => Promise<Fixture> };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { cleanup(); for (const close of cleanups.splice(0).reverse()) await close(); });
function Shell({ service }: { service: ExtensionPromptService }) {
  const state = useSyncExternalStore(listener => service.subscribe(listener), () => service.getState());
  return state.dynamic ? <DynamicExtensionQuickInput prompt={state.dynamic} service={service} /> : null;
}
it("keeps dynamic items live across real stdio host events and accepts original selection objects", async () => {
  const host = await fixture({ after: callback => { cleanups.push(callback); } }, { "test.dynamic": { code: `const v=require('vscode');let accepted;exports.activate=()=>{v.commands.registerCommand('show',()=>{const pick=v.window.createQuickPick();pick.placeholder='Find item';pick.onDidChangeValue(value=>pick.items=[{label:value,secret:42}]);pick.onDidAccept(()=>{accepted=pick.selectedItems[0]?.secret;pick.hide()});pick.show()});v.commands.registerCommand('result',()=>accepted)}` } });
  const service = new ExtensionPromptService();
  const off = host.onNotification(message => { if (message.method === "quickInput/set") service.setQuickInput(message.params as unknown as DynamicQuickInput, event => { void host.request("host/quickInputEvent", event); }); });
  cleanups.push(() => { off(); service.dismissAll(); return Promise.resolve(); });
  await host.request("host/activate", { id: "test.dynamic" });
  await host.request("host/executeCommand", { command: "show" });
  render(<Shell service={service} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Find item" }), { target: { value: "New choice" } });
  fireEvent.click(await screen.findByRole("button", { name: "New choice" }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  expect(await host.request("host/executeCommand", { command: "result" })).toBe(42);
});

it("selects a workspace folder through the real host and filters duplicate names by path", async () => {
  const host = await fixture({ after: callback => { cleanups.push(callback); } }, { "test.workspace": { code: `const v=require('vscode');exports.activate=()=>v.commands.registerCommand('workspace.pick',async()=>{const folder=await v.window.showWorkspaceFolderPick({placeHolder:'Choose a workspace',ignoreFocusOut:true});return folder?{path:folder.uri.fsPath,index:folder.index,name:folder.name}:null;})` } });
  const service = new ExtensionPromptService();
  const off = host.onNotification(message => { if (message.method === "quickInput/set") service.setQuickInput(message.params as unknown as DynamicQuickInput, event => { void host.request("host/quickInputEvent", event); }); });
  cleanups.push(() => { off(); service.dismissAll(); return Promise.resolve(); });
  await host.request("host/activate", { id: "test.workspace" });
  await host.request("host/init", { workspaceFolders: [{path:"/workspace/folder-a",name:"Project"},{path:"/workspace/folder-b",name:"Project"}] });
  const opening = host.request("host/executeCommand", {command:"workspace.pick"});
  render(<Shell service={service} />);
  const input = await screen.findByRole("textbox", {name:"Choose a workspace"});
  const overlay = screen.getByRole("dialog").parentElement;
  if (!overlay) throw new Error("Picker overlay is missing");
  fireEvent.mouseDown(overlay);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.change(input, {target:{value:"folder-b"}});
  await waitFor(() => { expect(screen.getAllByRole("button", {name:/Project/})).toHaveLength(1); });
  fireEvent.click(screen.getByRole("button", {name:/Project/}));
  expect(await opening).toEqual({path:"/workspace/folder-b",index:1,name:"Project"});
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
});
