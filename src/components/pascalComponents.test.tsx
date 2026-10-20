import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeStatus } from "../services/ipc";
import type { PascalStatus } from "../services/pascal/pascalModel";

const harness = vi.hoisted((): { current: unknown; status: PascalStatus | null } => ({ current: null, status: null }));
vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
vi.mock("../services/pascal/pascalModel", async (original) => ({
  ...(await original<typeof import("../services/pascal/pascalModel")>()),
  pascalIpc: { status: () => Promise.resolve(harness.status) },
}));

import { PascalAbcSetupLine } from "./PascalAbcSetupLine";
import { PascalStatusItem } from "./PascalStatusItem";

function withCompiler(value: string) {
  const snapshot = { value };
  const settings = {
    subscribe: () => () => undefined,
    getState: () => snapshot,
    string: (_id: string, fallback: string) => value || fallback,
    set: vi.fn().mockResolvedValue({ ok: true }),
  };
  const preferencesPage = { open: vi.fn() };
  harness.current = { settings, preferencesPage };
  return { settings, preferencesPage };
}

const runtime = { id: "pascalabc", installed: [] } as unknown as RuntimeStatus;

afterEach(() => {
  cleanup();
  harness.current = null;
  harness.status = null;
});

describe("Pascal status bar item", () => {
  it("names the compiler Run Code uses and opens the Pascal settings", () => {
    const { preferencesPage } = withCompiler("pascalabc");
    render(<PascalStatusItem languageId="pascal" />);
    fireEvent.click(screen.getByRole("button", { name: "PascalABC.NET" }));
    expect(preferencesPage.open).toHaveBeenCalledWith("settings", { category: "Pascal" });
  });

  it("says Free Pascal by default and is absent for other languages", () => {
    withCompiler("");
    const { rerender, container } = render(<PascalStatusItem languageId="pascal" />);
    expect(screen.getByRole("button", { name: "Free Pascal" })).toBeInTheDocument();
    rerender(<PascalStatusItem languageId="python" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PascalABC.NET card line", () => {
  it("shows its requirements and makes it the Pascal compiler on request", async () => {
    const { settings } = withCompiler("fpc");
    harness.status = {
      compiler: "fpc",
      platformSupported: true,
      dotnetFramework: { version: "4.8.1", satisfied: true },
      bundledVersion: "4.0.0.3883",
      bundleProblem: null,
    };
    render(<PascalAbcSetupLine runtime={runtime} />);
    expect(await screen.findByText(".NET Framework 4.8.1: found")).toBeInTheDocument();
    expect(screen.getByText("Included with OpenMind: 4.0.0.3883 (installs without a download)")).toBeInTheDocument();
    expect(screen.getByText("Run Code uses Free Pascal for Pascal files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use for Pascal Files" }));
    expect(settings.set).toHaveBeenCalledWith("user", "pascal.compiler", "pascalabc");
  });

  it("flags a missing .NET Framework and offers no switch once it is the compiler", async () => {
    withCompiler("pascalabc");
    harness.status = {
      compiler: "pascalabc",
      platformSupported: true,
      dotnetFramework: { version: null, satisfied: false },
      bundledVersion: null,
      bundleProblem: null,
    };
    render(<PascalAbcSetupLine runtime={runtime} />);
    const missing = await screen.findByText(/\.NET Framework 4\.7\.2 or later: not found/);
    expect(missing).toHaveClass("runtime-card__setup-problem");
    expect(screen.getByText("Install downloads it from pascalabc.net")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
