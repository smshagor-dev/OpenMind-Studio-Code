import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the CodeForge shell", () => {
    render(<App />);

    expect(screen.getByText("CodeForge")).toBeInTheDocument();
    expect(screen.getByLabelText("editor area")).toBeInTheDocument();
  });
});
