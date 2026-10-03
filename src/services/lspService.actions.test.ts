import { describe, expect, it, vi } from "vitest";

import { PY, TXT, rig, server, snapshot } from "../testUtils/lspFixtures";
import type { LspServerInfo, LspSnapshot } from "./ipc";
import { removeBlocked } from "./lspAvailability";

describe("LspService: actions and status", () => {
  it("Restart stops the server and reopens the open files of its languages only", async () => {
    const r = await rig();
    await r.documents.openFromPath(PY);
    await r.documents.openFromPath(TXT);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    await r.lsp.restart("python");
    expect(r.ipc.lspStop).toHaveBeenCalledWith("python");
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    expect(r.log).toContain("Restarting Pyright…");
    r.lsp.dispose();
  });

  it("Install runs only when the backend says it can, then reopens the files", async () => {
    const r = await rig([server({ installed: false, state: "stopped", capabilities: null })]);
    await r.documents.openFromPath(PY);
    expect(await r.lsp.install("python")).toBe(true);
    expect(r.ipc.lspInstall).toHaveBeenCalledWith("python");

    const blocked = await rig([
      server({
        installed: false,
        state: "stopped",
        canInstall: false,
        installBlocked: "Node.js runtime is not installed yet.",
      }),
    ]);
    expect(await blocked.lsp.install("python")).toBe(false);
    expect(blocked.ipc.lspInstall).not.toHaveBeenCalled();
    r.lsp.dispose();
    blocked.lsp.dispose();
  });

  it("a failed install is reported and leaves the state readable", async () => {
    const r = await rig([server({ installed: false, state: "stopped" })]);
    vi.mocked(r.ipc.lspInstall).mockRejectedValue("npm exited with code 1.");
    const errors: string[] = [];
    r.events.on("appError", ({ message }) => errors.push(message));
    expect(await r.lsp.install("python")).toBe(false);
    expect(errors[0]).toContain("Installing Pyright failed");
    r.lsp.dispose();
  });

  it("server log lines go to the LSP output, with the level when it isn't plain info", async () => {
    const r = await rig();
    r.handlers.log?.({ server: "python", level: "info", text: "Pyright started" });
    r.handlers.log?.({ server: "python", level: "error", text: "boom" });
    expect(r.log).toEqual(["[python] Pyright started", "[python] error: boom"]);
    r.lsp.dispose();
  });

  it("a server that stops is announced so its diagnostics can be removed", async () => {
    const r = await rig();
    const stopped: string[] = [];
    r.events.on("lspServerStopped", ({ server: id }) => stopped.push(id));
    r.status.current = snapshot([
      server({ state: "error", message: "The language server stopped unexpectedly." }),
    ]);
    await r.lsp.refresh();
    expect(stopped).toEqual(["python"]);
    r.lsp.dispose();
  });

  it("the failed-start toast is shown once per server", async () => {
    const r = await rig();
    r.outcome.current = { state: "failed", server: "python", message: "initialize failed" };
    const errors: string[] = [];
    r.events.on("appError", ({ message }) => errors.push(message));
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    await r.lsp.syncNow(id);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Pyright couldn't start: initialize failed");
    r.lsp.dispose();
  });
});

describe("Removing a language server", () => {
  const fortls = (patch: Partial<LspServerInfo> = {}) =>
    server({
      id: "fortran",
      name: "fortls",
      languages: ["fortran"],
      runtime: "pythonModule",
      contents: "fortls 3.2.2",
      installSource: "download",
      ...patch,
    });

  it("asks first, then removes a downloaded server and reloads the status", async () => {
    const r = await rig([fortls()]);
    const confirm = vi.fn().mockResolvedValue(true);
    r.lsp.setRemoveConfirmation(confirm);
    const notices: string[] = [];
    r.events.on("appNotice", ({ message }) => notices.push(message));

    expect(await r.lsp.uninstall("fortran")).toBe(true);

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ id: "fortran" }));
    expect(r.ipc.lspUninstall).toHaveBeenCalledWith("fortran");
    expect(notices).toContain("fortls removed.");
    expect(r.ipc.lspStatus).toHaveBeenCalled();
  });

  it("a second click while the question is open asks nothing more", async () => {
    const r = await rig([fortls()]);
    let answer: (value: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    r.lsp.setRemoveConfirmation(confirm);
    const first = r.lsp.uninstall("fortran");
    expect(await r.lsp.uninstall("fortran")).toBe(false);
    answer(true);
    expect(await first).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(r.ipc.lspUninstall).toHaveBeenCalledOnce();
  });

  it("removes nothing when the user declines, or without a confirmation at all", async () => {
    const declined = await rig([fortls()]);
    declined.lsp.setRemoveConfirmation(() => Promise.resolve(false));
    expect(await declined.lsp.uninstall("fortran")).toBe(false);
    expect(declined.ipc.lspUninstall).not.toHaveBeenCalled();

    const unwired = await rig([fortls()]);
    expect(await unwired.lsp.uninstall("fortran")).toBe(false);
    expect(unwired.ipc.lspUninstall).not.toHaveBeenCalled();
  });

  it("refuses a server from the offline bundle, one not installed, and one installing", async () => {
    expect(removeBlocked(fortls({ installSource: "bundle" }))).toContain("offline bundle");
    expect(removeBlocked(fortls({ installed: false }))).toBe("fortls is not installed.");
    expect(removeBlocked(fortls({ state: "installing" }))).toContain("installing");
    expect(removeBlocked(fortls())).toBeNull();
    const r = await rig([fortls({ installSource: "bundle" })]);
    r.lsp.setRemoveConfirmation(() => Promise.resolve(true));
    expect(await r.lsp.uninstall("fortran")).toBe(false);
    expect(r.ipc.lspUninstall).not.toHaveBeenCalled();
  });
});

describe("LspService: the canonical language-server state", () => {
  it("follows a server's life cycle from the canonical state and only catches up instead of reading it again", async () => {
    const r = await rig([server({ state: "stopped" })]);
    const calls = vi.mocked(r.ipc.lspStatus).mock.calls.length;
    let listener: (data: LspSnapshot) => void = () => undefined;
    const catchUp = vi.fn(() => Promise.resolve());
    let current: LspSnapshot | undefined = snapshot([server({ state: "running" })]);
    r.lsp.useCanonical({
      current: () => current,
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      catchUp,
      ready: () => Promise.resolve(),
    });
    expect(r.lsp.servers()[0]?.state).toBe("running");

    const stopped: string[] = [];
    r.events.on("lspServerStopped", ({ server: id }) => stopped.push(id));
    current = snapshot([server({ state: "error" })]);
    listener(current);
    expect(r.lsp.servers()[0]?.state).toBe("error");
    expect(stopped.length).toBe(1);

    await r.lsp.refresh();
    expect(catchUp).toHaveBeenCalled();
    expect(r.ipc.lspStatus).toHaveBeenCalledTimes(calls);
    r.lsp.dispose();
  });
});
