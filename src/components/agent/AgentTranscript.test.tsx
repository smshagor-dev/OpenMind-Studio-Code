import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Entry } from "../../services/agent/agentModel";

vi.mock("../../services/agent", () => ({ agent: { openFile: vi.fn() } }));
vi.mock("../../services/container", () => ({
  container: { ipc: { openExternalUrl: vi.fn(() => Promise.resolve()) } },
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../MarkdownPreview", () => ({ MarkdownText: ({ text }: { text: string }) => <p>{text}</p> }));

import { AgentTranscript } from "./AgentTranscript";

const entries: Entry[] = [
  { kind: "user", id: "u", text: "Fix the bug" },
  { kind: "assistant", id: "a", text: "Fixed it.", reasoning: "The loop starts at 1, so the first value is skipped." },
];

describe("agent transcript", () => {
  it("shows the model's thinking without a click, and folds it from its header", () => {
    render(<AgentTranscript entries={entries} busy={false} />);
    const thinking = screen.getByText("The loop starts at 1, so the first value is skipped.");
    expect(thinking).toBeVisible();
    const toggle = screen.getByRole("button", { name: /agent\.reasoning\.done/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.queryByText("The loop starts at 1, so the first value is skipped.")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("The loop starts at 1, so the first value is skipped.")).toBeVisible();
  });

  it("streams live thinking open, labelled as thinking", () => {
    const live: Entry[] = [entries[0] as Entry, { kind: "assistant", id: "a", text: "", reasoning: "Reading stats.js…" }];
    const { container } = render(<AgentTranscript entries={live} busy />);
    expect(screen.getByText("Reading stats.js…")).toBeVisible();
    expect(screen.getByRole("button", { name: /agent\.reasoning\.live/ })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".agent-reasoning--live")).not.toBeNull();
  });

  it("draws the user's message as a card without a terminal prompt sign", () => {
    const { container } = render(<AgentTranscript entries={entries} busy={false} />);
    const card = container.querySelector(".agent-message--user");
    expect(card).toHaveTextContent("Fix the bug");
    expect(card?.textContent.trim().startsWith(">")).toBe(false);
  });

  it("hides thinking entirely when the user turned it off", () => {
    render(<AgentTranscript entries={entries} busy={false} showReasoning={false} />);
    expect(screen.queryByText(/first value is skipped/)).toBeNull();
    expect(screen.getByText("Fixed it.")).toBeVisible();
  });
});
