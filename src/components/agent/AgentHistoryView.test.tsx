import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HistorySummary } from "../../services/agent/agentHistory";

const harness = vi.hoisted(() => ({
  restoreHistory: vi.fn(() => Promise.resolve(true)),
  deleteHistory: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/agent", async () => {
  const { StarredChats } = await import("../../services/agent/agentStarred");
  const values = new Map<string, string>();
  return {
    agent: harness,
    starredChats: new StarredChats(
      (key) => Promise.resolve(values.get(key) ?? null),
      (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
    ),
  };
});

import { starredChats } from "../../services/agent";
import { AgentHistoryView, StarCurrentChat } from "./AgentHistoryView";

const item = (id: string, title: string, updatedAt: number): HistorySummary => ({
  id,
  title,
  providerId: "openmind-agent",
  updatedAt,
  messageCount: 2,
});

const items = [item("a", "Fix login", 1), item("b", "Add tests", 2)];

describe("AgentHistoryView", () => {
  it("stars a conversation into a Starred section above Recent, and unstars it", async () => {
    render(<AgentHistoryView items={items} />);
    expect(screen.queryByText("Starred")).toBeNull();
    const row = screen.getByText("Fix login").closest(".agent-history__row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Star conversation" }));
    const groups = await screen.findAllByRole("heading", { level: 4 });
    expect(groups.map((g) => g.textContent)).toEqual(["Starred", "Recent"]);
    const order = screen.getAllByRole("button", { name: /Fix login|Add tests/ }).map((b) => b.textContent);
    expect(order[0]).toContain("Fix login");
    fireEvent.click(screen.getByRole("button", { name: "Remove star" }));
    expect(screen.queryByText("Starred")).toBeNull();
  });

  it("opens a conversation, and deleting one removes its star too", () => {
    starredChats.toggle("b");
    render(<AgentHistoryView items={items} />);
    fireEvent.click(screen.getByText("Fix login"));
    expect(harness.restoreHistory).toHaveBeenCalledWith("a");
    const row = screen.getByText("Add tests").closest(".agent-history__row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Delete conversation" }));
    expect(harness.deleteHistory).toHaveBeenCalledWith("b");
    expect(starredChats.has("b")).toBe(false);
  });
});

describe("StarCurrentChat", () => {
  it("is hidden until the conversation is saved, then stars and unstars it", () => {
    const view = render(<StarCurrentChat id="c" saved={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<StarCurrentChat id="c" saved />);
    fireEvent.click(screen.getByRole("button", { name: "Star this conversation" }));
    expect(starredChats.has("c")).toBe(true);
    expect(screen.getByRole("button", { name: "Remove this conversation's star" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove this conversation's star" }));
    expect(starredChats.has("c")).toBe(false);
  });
});
