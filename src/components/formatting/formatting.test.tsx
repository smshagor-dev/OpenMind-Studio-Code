import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { EventBus } from "../../services/eventBus";
import type { AppEvents } from "../../services/events";
import type { FormatterInfo } from "../../services/formatting/formattingIpc";
import { FormattingService } from "../../services/formatting/formattingService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { FormatterDialog } from "./FormatterDialog";
import { FormatterStatusItem } from "./FormatterStatusItem";

const BUILTIN: FormatterInfo = {
  id: "builtin.json",
  name: "Built-in JSON formatter",
  source: "builtIn",
  mode: "builtIn",
  available: true,
  reason: null,
  path: null,
};
const PRETTIER: FormatterInfo = {
  id: "prettier",
  name: "Prettier",
  source: null,
  mode: "stdin",
  available: false,
  reason: "Prettier not found. Add it to the project (`npm i -D prettier`).",
  path: null,
};

function setup(formatters: FormatterInfo[], languageName = "JSON") {
  const ipc = createFakeIpc({
    formatOptions: vi.fn().mockResolvedValue({
      languageId: "json",
      languageName,
      formatters,
      selected: formatters.find((f) => f.available)?.id ?? null,
      reason: formatters.some((f) => f.available)
        ? null
        : `No formatter available for ${languageName}. Prettier not found.`,
    }),
    formatRun: vi.fn().mockResolvedValue({
      text: "{}",
      formatterId: "builtin.json",
      formatterName: "Built-in JSON formatter",
      source: "builtIn",
    }),
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  });
  const target = {
    id: "d1",
    path: "C:/w/a.json",
    language: "json",
    eol: "\n" as const,
    indent: "  ",
  };
  const events = new EventBus<AppEvents>();
  const service = new FormattingService(
    ipc,
    {
      active: () => ({ target }),
      target: () => target,
      text: () => "{ }",
      apply: vi.fn(),
      lsp: () => ({ available: false, reason: null, run: () => Promise.resolve(null) }),
    },
    { bool: (_id, f) => f, number: (_id, f) => f, string: (_id, f) => f },
    events,
  );
  const run = vi.fn();
  harness.current = { formatting: service, run };
  return { service, run, ipc };
}

beforeEach(() => {
  harness.current = null;
});

describe("formatter status item", () => {
  it("shows the formatter of the file in front", async () => {
    const { service } = setup([BUILTIN, PRETTIER]);
    await act(async () => {
      await service.refreshStatus();
    });
    render(<FormatterStatusItem />);
    expect(
      screen.getByRole("button", { name: "JSON — Built-in JSON formatter" }),
    ).toBeInTheDocument();
  });

  it("says plainly when nothing can format the file and opens the status list on click", async () => {
    const { service, run } = setup([PRETTIER], "TypeScript");
    await act(async () => {
      await service.refreshStatus();
    });
    render(<FormatterStatusItem />);
    const item = screen.getByRole("button", { name: /TypeScript — Prettier missing/ });
    expect(item).toHaveAttribute(
      "title",
      expect.stringContaining("No formatter available for TypeScript."),
    );
    fireEvent.click(item);
    expect(run).toHaveBeenCalledWith("format.showStatus");
  });

  it("renders nothing while no text file is in front", () => {
    setup([BUILTIN]);
    const { container } = render(<FormatterStatusItem />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("formatter dialog", () => {
  it("Format Document With... lists each formatter; an unavailable one is disabled and shows why", async () => {
    const { service, ipc } = setup([BUILTIN, PRETTIER]);
    render(<FormatterDialog />);
    await act(async () => {
      await service.openDialog("with");
    });
    const list = within(screen.getByRole("list", { name: "Formatters" }));
    expect(list.getByText("Built-in JSON formatter")).toBeInTheDocument();
    expect(list.getByText("In use")).toBeInTheDocument();
    expect(list.getByText(/npm i -D prettier/)).toBeInTheDocument();
    const buttons = list.getAllByRole("button", { name: "Format" });
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[0] as HTMLElement);
    await vi.waitFor(() => {
      expect(ipc.formatRun).toHaveBeenCalledWith(
        expect.objectContaining({ toolId: "builtin.json" }),
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the status mode is read-only and offers Configure Default", async () => {
    const { service } = setup([BUILTIN]);
    render(<FormatterDialog />);
    await act(async () => {
      await service.openDialog("status");
    });
    expect(screen.getByRole("heading", { name: "Formatter Status" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Format" })).toBeNull();
    expect(screen.getByRole("button", { name: "Configure Default..." })).toBeInTheDocument();
  });

  it("with no formatter at all it says nothing is installed automatically", async () => {
    const { service } = setup([], "Plain Text");
    render(<FormatterDialog />);
    await act(async () => {
      await service.openDialog("status");
    });
    expect(
      screen.getByText(/Nothing is installed or downloaded automatically/),
    ).toBeInTheDocument();
  });

  it("Escape and Close dismiss it", async () => {
    const { service } = setup([BUILTIN]);
    render(<FormatterDialog />);
    await act(async () => {
      await service.openDialog("status");
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
