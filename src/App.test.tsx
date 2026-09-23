import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the OpenMind Studio shell", () => {
    render(<App />);

    expect(screen.getByText("OpenMind Studio")).toBeInTheDocument();
    expect(screen.getByLabelText("editor area")).toBeInTheDocument();
  });
});
