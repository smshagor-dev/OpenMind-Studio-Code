/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "../i18n";

import { StartupErrorPage } from "./StartupErrorPage";
import {
  STARTUP_ERROR_WINDOW_LABEL,
  type StartupErrorApi,
  type StartupFailure,
} from "./startupErrorApi";
import { preloadLanguages } from "../testUtils/languages";

preloadLanguages("ru", "bn");

const FIRST_STEP = "Exit, and start the OpenMind Studio build that last used this folder.";

const FAILURE: StartupFailure = {
  failure: { kind: "checksumMismatch", version: 3 },
  category: "Migration checksum mismatch",
  title: "The local database doesn't match this build",
  explanation:
    "OpenMind Studio could not open the local database because migration 3's checksum does not match this build. This can happen if a previous development build used different SQL file line endings or a different version of that migration. Your data was not deleted.",
  nextSteps: [FIRST_STEP, "Back Up and Start Fresh moves the database ..."],
  dbPath: "C:\\Apps\\OpenMind Studio\\data\\openmind-studio.db",
  dataDir: "C:\\Apps\\OpenMind Studio\\data",
  errorChain: [
    "failed to run database migrations",
    "migration 3 was previously applied but has been modified",
  ],
  details:
    "OpenMind Studio could not open its local database.\nCategory: Migration checksum mismatch\nYour data was not deleted.",
  canBackUp: true,
};

function fakeApi(overrides: Partial<StartupErrorApi> = {}) {
  const api = {
    info: vi.fn(() => Promise.resolve(FAILURE)),
    openDataFolder: vi.fn(() => Promise.resolve()),
    copy: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
    backUp: vi.fn(() => Promise.resolve("C:\\Apps\\OpenMind Studio\\data\\db-backup-1")),
    restart: vi.fn(() => Promise.resolve()),
    exit: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return api;
}

/** Vitest runs from the repository root. */
function source(path: string): string {
  return join(process.cwd(), path);
}

async function shown(api: StartupErrorApi) {
  render(<StartupErrorPage api={api} />);
  await screen.findByText(FAILURE.title);
}

describe("start-up database error page", () => {
  it("explains the failure in sentences with the database path, not a panic message", async () => {
    await shown(fakeApi());
    expect(screen.getByText("OpenMind Studio couldn't start")).toBeTruthy();
    expect(screen.getByText(FAILURE.explanation)).toBeTruthy();
    expect(screen.getByText(FAILURE.dbPath)).toBeTruthy();
    expect(screen.getByText(FAILURE.category)).toBeTruthy();
    expect(screen.getByText(FIRST_STEP)).toBeTruthy();
    expect(document.body.textContent).not.toContain("panicked");
  });

  it("Copy Error Details copies the details text and says so", async () => {
    const api = fakeApi();
    await shown(api);
    fireEvent.click(screen.getByRole("button", { name: "Copy Error Details" }));
    await screen.findByText("Error details copied.");
    expect(api.copy).toHaveBeenCalledWith(FAILURE.details);
  });

  it("a failed copy is reported, not swallowed", async () => {
    await shown(fakeApi({ copy: vi.fn(() => Promise.reject(new Error("clipboard busy"))) }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Error Details" }));
    await screen.findByText("Couldn't copy the details: clipboard busy");
  });

  it("Open Data Folder and Exit call the backend", async () => {
    const api = fakeApi();
    await shown(api);
    fireEvent.click(screen.getByRole("button", { name: "Open Data Folder" }));
    await screen.findByText("Opened the data folder.");
    fireEvent.click(screen.getByRole("button", { name: "Exit" }));
    await waitFor(() => {
      expect(api.exit).toHaveBeenCalledTimes(1);
    });
    expect(api.backUp).not.toHaveBeenCalled();
  });

  it("nothing is moved until Back Up is confirmed, and Cancel moves nothing", async () => {
    const api = fakeApi();
    await shown(api);
    fireEvent.click(screen.getByRole("button", { name: "Back Up and Start Fresh…" }));
    expect(screen.getByRole("group", { name: "Back up and start fresh" }).textContent).toContain(
      "Nothing is deleted.",
    );
    expect(api.backUp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.backUp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back Up and Start Fresh…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move the Database and Continue" }));
    await screen.findByText(
      "The database was moved to C:\\Apps\\OpenMind Studio\\data\\db-backup-1. Nothing was deleted.",
    );
    expect(api.restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart OpenMind Studio" }));
    expect(api.restart).toHaveBeenCalledTimes(1);
  });

  it("a failed back-up says nothing was moved", async () => {
    await shown(fakeApi({ backUp: vi.fn(() => Promise.reject(new Error("file in use"))) }));
    fireEvent.click(screen.getByRole("button", { name: "Back Up and Start Fresh…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move the Database and Continue" }));
    await screen.findByText("Nothing was moved: file in use");
  });

  it("offers no back-up when there is no database file", async () => {
    await shown(fakeApi({ info: vi.fn(() => Promise.resolve({ ...FAILURE, canBackUp: false })) }));
    expect(screen.queryByRole("button", { name: "Back Up and Start Fresh…" })).toBeNull();
  });

  it("still offers Exit when even the details can't be read", async () => {
    const api = fakeApi({ info: vi.fn(() => Promise.reject(new Error("no state"))) });
    render(<StartupErrorPage api={api} />);
    await screen.findByText(/the details couldn't be read either: no state/);
    expect(screen.getByText("Your data was not deleted.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit" }));
    await waitFor(() => {
      expect(api.exit).toHaveBeenCalled();
    });
  });

  it("the entry page loads the workbench only outside the error window", () => {
    const main = readFileSync(source("src/main.tsx"), "utf8");
    expect(main).not.toMatch(/^import .* from "\.\/App";/m);
    expect(main).not.toMatch(/^import .* from "\.\/PhpServerWindow";/m);
    const php = readFileSync(source("src/PhpServerWindow.tsx"), "utf8");
    const phpLabel = /export const PHP_WINDOW_LABEL = "([^"]+)";/.exec(php)?.[1];
    expect(phpLabel).toBeTruthy();
    expect(main).toContain(`const PHP_WINDOW_LABEL = "${phpLabel ?? ""}";`);
    expect(STARTUP_ERROR_WINDOW_LABEL).toBe("startup-error");
    const rust = readFileSync(source("src-tauri/src/startup_error.rs"), "utf8");
    expect(rust).toContain(
      `pub const STARTUP_ERROR_WINDOW_LABEL: &str = "${STARTUP_ERROR_WINDOW_LABEL}";`,
    );
    const capability = readFileSync(source("src-tauri/capabilities/startup-error.json"), "utf8");
    expect(JSON.parse(capability)).toMatchObject({ windows: [STARTUP_ERROR_WINDOW_LABEL] });
  });
});

describe("start-up database error page in the UI language", () => {
  afterEach(() => {
    i18n.setLanguage("en");
  });

  it("explains the failure in Russian by its kind, and copies the English details for reports", async () => {
    i18n.setLanguage("ru");
    const api = fakeApi();
    render(<StartupErrorPage api={api} />);
    await screen.findByText("Локальная база данных не соответствует этой сборке");
    expect(screen.getByText("Не удалось запустить OpenMind Studio")).toBeTruthy();
    expect(screen.getByText(/контрольная сумма миграции 3 не совпадает/)).toBeTruthy();
    expect(screen.getByText(/Ваши данные не удалены\./)).toBeTruthy();
    expect(screen.getByText("Несовпадение контрольной суммы миграции")).toBeTruthy();
    expect(screen.getByText(FAILURE.dbPath)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Копировать сведения об ошибке" }));
    await screen.findByText("Сведения об ошибке скопированы.");
    expect(api.copy).toHaveBeenCalledWith(FAILURE.details);
    expect([...i18n.missing]).toEqual([]);
  });

  it("shows Bangla, and an unknown kind falls back to the backend's own English", async () => {
    i18n.setLanguage("bn");
    render(<StartupErrorPage api={fakeApi()} />);
    await screen.findByText("লোকাল ডেটাবেস এই বিল্ডের সঙ্গে মেলে না");
    expect(screen.getByRole("button", { name: "প্রস্থান" })).toBeTruthy();
  });

  it("a kind this page doesn't know keeps the backend's text", async () => {
    i18n.setLanguage("ru");
    const unknown = { ...FAILURE, failure: { kind: "somethingNew" }, title: "Backend title" };
    render(<StartupErrorPage api={fakeApi({ info: vi.fn(() => Promise.resolve(unknown)) })} />);
    await screen.findByText("Backend title");
    expect(screen.getByText(FAILURE.explanation)).toBeTruthy();
  });
});
