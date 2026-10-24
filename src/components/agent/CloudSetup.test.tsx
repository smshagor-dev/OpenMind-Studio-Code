import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CloudStatus } from "../../services/agent/agentIpc";

const mock = vi.hoisted(() => ({
  cloudError: null as string | null,
  load: vi.fn(() => Promise.resolve()),
  saveAddress: vi.fn(() => Promise.resolve("")),
  saveKey: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(() => Promise.resolve()),
  test: vi.fn<() => Promise<unknown[] | null>>(() => Promise.resolve([])),
}));
vi.mock("../../services/agent", () => ({
  agent: {
    loadCloudStatus: mock.load,
    setCloudBaseUrl: mock.saveAddress,
    setCloudKey: mock.saveKey,
    clearCloudKey: mock.disconnect,
    testCloudConnection: mock.test,
    getState: () => ({ cloud: null, cloudError: mock.cloudError }),
  },
}));
vi.mock("../../services/container", () => ({
  container: { ipc: { openExternalUrl: vi.fn() } },
}));
import { CloudSetup } from "./AgentSetup";

const cloud: CloudStatus = {
  baseUrl: "https://api.openmindai.org/api/v1/openmindai",
  isDefaultBaseUrl: true,
  hasKey: true,
  models: [{ id: "openmindai-lite", name: "OpenMindAI Lite", available: true }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.cloudError = null;
});

it("shows configured credentials without claiming verified connectivity or exposing a saved key", () => {
  render(<CloudSetup cloud={cloud} />);
  expect(screen.getByText("API key configured")).toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  expect(screen.getByText("OpenMindAI Lite")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(screen.getByLabelText("API key")).toHaveAttribute("type", "text");
  expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("saves a new key and clears the input only after a successful save", async () => {
  let finish: () => void = () => undefined;
  mock.saveKey.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<CloudSetup cloud={cloud} />);
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "new-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect(mock.saveKey).toHaveBeenCalledWith("new-secret");
  expect(
    screen.getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(screen.getByLabelText("API key")).toHaveValue("");
});

it("displays disconnect errors and leaves the form usable", async () => {
  mock.disconnect.mockRejectedValueOnce(
    new Error("Could not clear credentials"),
  );
  render(<CloudSetup cloud={cloud} />);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not clear credentials",
  );
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
});

it("recovers from a rejected connection test and blocks conflicting saves while testing", async () => {
  let fail: (error: Error) => void = () => undefined;
  mock.test.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  render(<CloudSetup cloud={cloud} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(screen.getByRole("button", { name: "Save address" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  await act(async () => {
    fail(new Error("Server unavailable"));
    await Promise.resolve();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Server unavailable",
  );
  expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
});

it("reports failed initial loading instead of leaving an endless loading message", async () => {
  mock.load.mockRejectedValueOnce(new Error("Settings could not be loaded"));
  render(<CloudSetup cloud={null} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Settings could not be loaded",
  );
});

it("surfaces native connection failures without swallowing them", async () => {
  mock.cloudError = "The cloud rejected the connection.";
  mock.test.mockResolvedValueOnce(null);
  render(<CloudSetup cloud={cloud} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The cloud rejected the connection.",
    );
  });
});

it("keeps a draft key when the service reports a native save failure", async () => {
  mock.saveKey.mockImplementationOnce(() => {
    mock.cloudError = "Key storage failed";
    return Promise.resolve();
  });
  render(<CloudSetup cloud={cloud} />);
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "keep-this-draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Key storage failed",
  );
  expect(screen.getByLabelText("API key")).toHaveValue("keep-this-draft");
});
