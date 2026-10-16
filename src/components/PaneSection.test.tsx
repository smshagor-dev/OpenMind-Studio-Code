import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PaneSection } from "./PaneSection";

it("keeps Explorer actions available while the section is collapsed", () => {
  const onRun = vi.fn();
  const onToggle = vi.fn();
  render(<PaneSection title="Documents" expanded={false} onToggle={onToggle} actions={[{label: "New file", icon: "+", onRun}]}><div>Files</div></PaneSection>);
  const action = screen.getByRole("button", { name: "New file" });
  fireEvent.keyDown(action, { key: "Enter" });
  expect(onToggle).not.toHaveBeenCalled();
  fireEvent.click(action);
  expect(onRun).toHaveBeenCalledOnce();
  expect(onToggle).not.toHaveBeenCalled();
});
