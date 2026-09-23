import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "theme_get") return Promise.resolve("dark");
    if (command === "session_load") return Promise.resolve({ openPaths: [], activePath: null });
    if (command === "recent_files_list") return Promise.resolve([]);
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

import { App } from "./App";

describe("App", () => {
  it("renders the title bar immediately", () => {
    render(<App />);

    expect(screen.getByText("OpenMind Studio")).toBeInTheDocument();
    expect(screen.getByLabelText("editor area")).toBeInTheDocument();
  });

  it("shows the welcome pane once the empty session finishes restoring", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Open File...")).toBeInTheDocument();
    });
    expect(screen.getByText("New File")).toBeInTheDocument();
  });
});
