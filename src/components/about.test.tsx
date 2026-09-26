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
    expect(system.getByText("windows (x86_64)")).toBeInTheDocument();
    expect(system.getByText("153.0.1")).toBeInTheDocument();
    expect(system.getByText("2.11.6")).toBeInTheDocument();
    expect(system.getByText("Apache-2.0")).toBeInTheDocument();
    // Only the version is shown: no commit or build hash anywhere in the window.
    expect(within(dialog).queryByText("Build")).toBeNull();
    expect(dialog.textContent).not.toMatch(/abc1234|[0-9a-f]{7,40}/);
    expect(dialog.textContent).not.toMatch(/Proprietary|all rights reserved/i);
    expect(within(dialog).getByText("Rust")).toBeInTheDocument();
  });

  it("shows the author card with support email, Telegram, WhatsApp and GitHub — and no portfolio while none is set", async () => {
    setup();
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const author = within(screen.getByRole("region", { name: "Author" }));
    expect(author.getByText("Md Shahanur Islam Shagor")).toBeInTheDocument();
    expect(author.getByText("Founder & Developer, OpenMind Studio")).toBeInTheDocument();
    expect(author.getByText("Independent Researcher and Software Engineer")).toBeInTheDocument();
    const contact = within(await author.findByRole("list", { name: "Contact" }));
    expect(contact.getByText("smshagor.dev@gmail.com")).toBeInTheDocument();
    expect(contact.getByText("@smshagor1")).toBeInTheDocument();
    expect(contact.getByText("smshagor1")).toBeInTheDocument();
    expect(contact.getByText("smshagor-dev")).toBeInTheDocument();
    expect(contact.queryByText(/portfolio/i)).toBeNull();
    // WhatsApp is only a name to look for: no button, nothing that could open.
    expect(contact.queryByRole("button", { name: "smshagor1" })).toBeNull();
  });

  it("every link opens only after a click, with a mailto address for the email", async () => {
    const { ipc } = setup({ openExternalUrl: vi.fn().mockResolvedValue(undefined) });
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const contact = within(await screen.findByRole("list", { name: "Contact" }));
    expect(ipc.openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(contact.getByRole("button", { name: "smshagor.dev@gmail.com" }));
    expect(ipc.openExternalUrl).toHaveBeenLastCalledWith("mailto:smshagor.dev@gmail.com");
    fireEvent.click(contact.getByRole("button", { name: "@smshagor1" }));
    expect(ipc.openExternalUrl).toHaveBeenLastCalledWith("https://t.me/smshagor1");
    fireEvent.click(contact.getByRole("button", { name: "smshagor-dev" }));
    expect(ipc.openExternalUrl).toHaveBeenLastCalledWith("https://github.com/smshagor-dev");
    expect(ipc.openExternalUrl).toHaveBeenCalledTimes(3);
  });

  it("shows a Portfolio button only when an address is configured", async () => {
    const base = await createFakeIpc().aboutInfo();
    setup({
      aboutInfo: vi.fn().mockResolvedValue({
        ...base,
        author: { ...base.author, portfolio: "https://portfolio.example" },
      }),
    });
    render(<AboutDialog onClose={vi.fn()} authorImage={null} />);
    const contact = within(await screen.findByRole("list", { name: "Contact" }));
    expect(contact.getByRole("button", { name: "Open portfolio" })).toHaveAttribute(
      "title",
      "https://portfolio.example",
    );
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
      expect(ipc.clipboardWriteText).toHaveBeenCalledWith(
        expect.stringContaining("OpenMind Studio 0.1.0"),
      );
    });
    const copied = vi.mocked(ipc.clipboardWriteText).mock.calls[0]?.[0] ?? "";
    expect(copied.toLowerCase()).not.toMatch(/password|api key|token|secret|commit|build/);
    expect(copied).not.toMatch(/[0-9a-f]{7,40}/);
    expect(copied).toContain("License: Apache-2.0");
    expect(copied).toContain("Support: smshagor.dev@gmail.com");
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
