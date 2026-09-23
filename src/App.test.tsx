import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the Openmind Studio shell", () => {
    render(<App />);

    expect(screen.getByText("Openmind Studio")).toBeInTheDocument();
    expect(screen.getByLabelText("editor area")).toBeInTheDocument();
  });
});
