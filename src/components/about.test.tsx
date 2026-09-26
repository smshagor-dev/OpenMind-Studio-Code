import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { initials, pickAuthorImage } from "./aboutAuthor";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { AboutDialog } from "./AboutDialog";

function setup(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc(overrides);
  const events = new EventBus<AppEvents>();
  const run = vi.fn();
  const errors: string[] = [];
  events.on("appError", ({ message }) => {
    errors.push(message);
  });
  harness.current = { ipc, events, run };
  return { ipc, run, errors };
}

beforeEach(() => {
  harness.current = null;
});

describe("About window", () => {
  it("shows the product, version, build, platform and licence", async () => {
    setup();
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const dialog = screen.getByRole("dialog", { name: "OpenMind Studio" });
    expect(await within(dialog).findByText("v0.1.0")).toBeInTheDocument();
    const system = within(screen.getByRole("region", { name: "System" }));
    expect(system.getByText("abc1234")).toBeInTheDocument();
    expect(system.getByText("windows (x86_64)")).toBeInTheDocument();
    expect(system.getByText("153.0.1")).toBeInTheDocument();
    expect(system.getByText("2.11.6")).toBeInTheDocument();
    expect(system.getByText("Proprietary — all rights reserved")).toBeInTheDocument();
    expect(within(dialog).getByText("Rust")).toBeInTheDocument();
  });

  it("shows the author with their role and a GitHub link that opens only on a click", async () => {
    const { ipc } = setup({ openExternalUrl: vi.fn().mockResolvedValue(undefined) });
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const author = within(screen.getByRole("region", { name: "Author" }));
    expect(author.getByText("Md Shahanur Islam Shagor")).toBeInTheDocument();
    expect(author.getByText("Founder & Developer, OpenMind Studio")).toBeInTheDocument();
    expect(author.getByText("Independent Researcher and Software Engineer")).toBeInTheDocument();
    const link = await author.findByRole("button", { name: /GitHub/ });
    expect(ipc.openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(ipc.openExternalUrl).toHaveBeenCalledWith("https://github.com/smshagor-dev");
  });

  it("shows the author's initials when no picture is bundled", () => {
    setup();
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const avatar = screen.getByRole("img", { name: "Md Shahanur Islam Shagor" });
    expect(avatar).toHaveTextContent("MS");
  });

  it("shows the bundled picture when there is one, and the initials if it cannot be shown", () => {
    setup();
    render(<AboutDialog onClose={vi.fn()} authorImage="/assets/author-abc.png" />);
    const picture = screen.getByRole("img", { name: "Md Shahanur Islam Shagor" });
    expect(picture).toHaveAttribute("src", "/assets/author-abc.png");
    fireEvent.error(picture);
    expect(screen.getByRole("img", { name: "Md Shahanur Islam Shagor" })).toHaveTextContent("MS");
  });

  it("copies the system information the backend built — versions and paths, no secrets", async () => {
    const { ipc } = setup();
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const copy = screen.getByRole("button", { name: "Copy System Info" });
    await waitFor(() => {
      expect(copy).toBeEnabled();
    });
    fireEvent.click(copy);
    await waitFor(() => {
      expect(ipc.clipboardWriteText).toHaveBeenCalledWith("OpenMind Studio 0.1.0\nCommit: abc1234");
    });
    const copied = vi.mocked(ipc.clipboardWriteText).mock.calls[0]?.[0] ?? "";
    expect(copied.toLowerCase()).not.toMatch(/password|api key|token|secret/);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("Open Logs runs the open-logs command and Close closes", () => {
    const { run } = setup();
    const onClose = vi.fn();
    render(<AboutDialog onClose={onClose} authorImage={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Logs" }));
    expect(run).toHaveBeenCalledWith("help.openLogsFolder");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("still opens, with the author, when the backend cannot answer, and says so", async () => {
    const { errors } = setup({ aboutInfo: vi.fn().mockRejectedValue("boom") });
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    await waitFor(() => {
      expect(errors).toEqual(["Could not read the About information: boom"]);
    });
    expect(screen.getByRole("button", { name: "Copy System Info" })).toBeDisabled();
    expect(screen.getByText("Md Shahanur Islam Shagor")).toBeInTheDocument();
  });
});

describe("author picture helpers", () => {
  it("picks the first bundled picture and returns null when there is none", () => {
    expect(pickAuthorImage({})).toBeNull();
    expect(pickAuthorImage({ "../assets/about/author.png": "/a.png" })).toBe("/a.png");
    expect(
      pickAuthorImage({ "../assets/about/author.jpg": 5, "../assets/about/author.png": "/a.png" }),
    ).toBe("/a.png");
  });

  it("makes initials from the first and last word", () => {
    expect(initials("Md Shahanur Islam Shagor")).toBe("MS");
    expect(initials("Ada")).toBe("A");
    expect(initials("  ")).toBe("?");
  });
});
