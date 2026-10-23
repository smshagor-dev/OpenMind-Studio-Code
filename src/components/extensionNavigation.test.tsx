import { beforeEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ExtensionWorkbench } from "./ExtensionWorkbench";
import { extensionWorkbench as service } from "../services/extensionWorkbench";
beforeEach(() => { cleanup(); HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; }; service.hide(); service.handle("workbench/reset", {}); });
it("browses hierarchy through the service with zero-based coordinates and opens returned locations", async () => {
  const request = vi.fn((p: Record<string, unknown>) => Promise.resolve(p.op === "snapshot" ? { providers: [{ handle: "provider", kind: "callHierarchy", extension: "test.navigation" }] } : p.op === "prepare" ? [{ id: "root", name: "root", uri: "file:///project/file.ts" }] : p.op === "incoming" ? [{ item: { id: "caller", name: "caller", uri: "file:///project/caller.ts" } }] : true));
  service.connect(request); await service.show("languages"); render(<ExtensionWorkbench />);
  fireEvent.change(screen.getByLabelText("Open file path"), { target: { value: "/project/file.ts" } });
  fireEvent.change(screen.getByLabelText("Line"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByText(/root · file/);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ domain: "languages", op: "prepare", position: { line: 1, character: 0 } }));
  fireEvent.click(screen.getByRole("button", { name: "Callers" })); await screen.findByText(/caller · file/);
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await waitFor(() => { expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "open", uri: "file:///project/caller.ts" })); });
});
