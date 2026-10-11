import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import type { FormatOptionsAnswer, FormatterInfo } from "./formattingIpc";
import {
  FormattingService,
  type FormatTarget,
  type FormattingHost,
  LSP_FORMATTER_ID,
  statusText,
} from "./formattingService";

const MINIFIED = '{"name":"r","scripts":{"dev":"vite"}}';
const PRETTY = '{\n  "name": "r",\n  "scripts": {\n    "dev": "vite"\n  }\n}';

const BUILTIN: FormatterInfo = {
  id: "builtin.json",
  name: "Built-in JSON formatter",
  source: "builtIn",
  mode: "builtIn",
  available: true,
  reason: null,
  path: null,
};
const PRETTIER_MISSING: FormatterInfo = {
  id: "prettier",
  name: "Prettier",
  source: null,
  mode: "stdin",
  available: false,
  reason: "Prettier not found. Add it to the project (`npm i -D prettier`).",
  path: null,
};

function answer(formatters: FormatterInfo[], overrides: Partial<FormatOptionsAnswer> = {}) {
  const firstAvailable = formatters.find((f) => f.available);
  return {
    languageId: "json",
    languageName: "JSON",
    formatters,
    selected: firstAvailable?.id ?? null,
    reason: firstAvailable ? null : "No formatter available for JSON. Prettier not found.",
    ...overrides,
  } satisfies FormatOptionsAnswer;
}

interface Rig {
  service: FormattingService;
  ipc: ReturnType<typeof createFakeIpc>;
  host: {
    texts: Map<string, string>;
    applied: string[];
    focus: { value: FormatTarget | string };
  };
  events: EventBus<AppEvents>;
  errors: string[];
  notices: string[];
  settings: Record<string, boolean | number | string>;
  log: string[];
}

function rig(
  options: {
    lsp?: { available: boolean | (() => boolean); text?: string | null };
    extension?: { text: string | null };
  } = {},
): Rig {
  const ipc = createFakeIpc({
    formatOptions: vi.fn().mockResolvedValue(answer([BUILTIN, PRETTIER_MISSING])),
    formatRun: vi.fn().mockResolvedValue({
      text: PRETTY,
      formatterId: "builtin.json",
      formatterName: "Built-in JSON formatter",
      source: "builtIn",
    }),
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  });
  const target: FormatTarget = {
    id: "d1",
    path: "C:/My Project/package.json",
    language: "json",
    eol: "\n",
    indent: "  ",
  };
  const texts = new Map([["d1", MINIFIED]]);
  const applied: string[] = [];
  const active: { value: FormatTarget | string } = { value: target };
  const host = { texts, applied, focus: active };
  const impl: FormattingHost = {
    active: () =>
      typeof active.value === "string" ? { reason: active.value } : { target: active.value },
    target: (id) => (id === "d1" ? target : null),
    text: (id) => texts.get(id) ?? "",
    apply: (id, text) => {
      texts.set(id, text);
      applied.push(text);
    },
    lsp: () => {
      const given = options.lsp?.available ?? false;
      const available = typeof given === "function" ? given() : given;
      return {
        available,
        reason: available ? null : "No language server for JSON.",
        run: () => Promise.resolve(options.lsp?.text ?? null),
      };
    },
    ...(options.extension
      ? {
          extensionFormatters: () => [
            {
              id: "ext:pub.fmt",
              name: "Fmt (extension)",
              run: () => Promise.resolve(options.extension?.text ?? null),
            },
          ],
        }
      : {}),
  };
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  const notices: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  events.on("appNotice", ({ message }) => notices.push(message));
  const settings: Rig["settings"] = {};
  const log: string[] = [];
  const service = new FormattingService(
    ipc,
    impl,
    {
      bool: (id, fallback) => (settings[id] as boolean | undefined) ?? fallback,
      number: (id, fallback) => (settings[id] as number | undefined) ?? fallback,
      string: (id, fallback) => (settings[id] as string | undefined) ?? fallback,
    },
    events,
    (line) => log.push(line),
  );
  return {
    service,
    ipc,
    host,
    events,
    errors,
    notices,
    settings,
    log,
  };
}

let r: Rig;
beforeEach(() => {
  r = rig();
});

describe("Format Document", () => {
  it("formats a one-line package.json: the answer replaces the text and nothing else is touched", async () => {
    const outcome = await r.service.formatActive();
    expect(outcome).toEqual({ kind: "formatted", formatter: "Built-in JSON formatter" });
    expect(r.host.texts.get("d1")).toBe(PRETTY);
    expect(r.host.applied).toEqual([PRETTY]);
    const request = vi.mocked(r.ipc.formatRun).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      path: "C:/My Project/package.json",
      language: "json",
      text: MINIFIED,
      toolId: "builtin.json",
      indent: "  ",
      eol: "\n",
      timeoutMs: 10_000,
      policy: { project: true, bundled: true, system: false },
    });
    expect(r.errors).toEqual([]);
  });

  it("invalid JSON shows the parse error with its position and leaves the text exactly as it was", async () => {
    vi.mocked(r.ipc.formatRun).mockRejectedValue(
      "The document is not valid JSON: Unexpected ',', expected a property name in double quotes (line 1, column 9)",
    );
    r.host.texts.set("d1", '{"a": 1,, }');
    const outcome = await r.service.formatActive();
    expect(outcome.kind).toBe("failed");
    expect(r.errors[0]).toContain("line 1, column 9");
    expect(r.host.texts.get("d1")).toBe('{"a": 1,, }');
    expect(r.host.applied).toEqual([]);
  });

  it("an already formatted file is not touched (so it does not become dirty)", async () => {
    r.host.texts.set("d1", PRETTY);
    const outcome = await r.service.formatActive();
    expect(outcome.kind).toBe("unchanged");
    expect(r.host.applied).toEqual([]);
  });

  it("a preview tab (or no editor) can't be formatted: a reason, no formatter call", async () => {
    r.host.focus.value =
      "A preview is read-only and can't be formatted. Open the file as text first.";
    expect(r.service.unavailableReason()).toContain("A preview is read-only");
    const outcome = await r.service.formatActive();
    expect(outcome.kind).toBe("skipped");
    expect(r.notices[0]).toContain("A preview is read-only");
    expect(r.ipc.formatOptions).not.toHaveBeenCalled();
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
  });

  it("with no formatter it says why and does not pretend", async () => {
    vi.mocked(r.ipc.formatOptions).mockResolvedValue(
      answer([{ ...PRETTIER_MISSING }], {
        languageName: "TypeScript",
        reason: "No formatter available for TypeScript. Prettier not found. Add it to the project.",
      }),
    );
    const outcome = await r.service.formatActive();
    expect(outcome.kind).toBe("none");
    expect(r.notices[0]).toMatch(/^No formatter available for TypeScript\./);
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
    expect(r.host.applied).toEqual([]);
  });

  it("text changed while the formatter ran: nothing is applied", async () => {
    vi.mocked(r.ipc.formatRun).mockImplementation(() => {
      r.host.texts.set("d1", MINIFIED + " ");
      return Promise.resolve({ text: PRETTY, formatterId: "x", formatterName: "x", source: null });
    });
    const outcome = await r.service.formatActive();
    expect(outcome.kind).toBe("skipped");
    expect(r.host.applied).toEqual([]);
  });

  it("a file over the limit is refused before any tool is asked", async () => {
    r.host.texts.set("d1", "x".repeat(2_000_001));
    const outcome = await r.service.formatActive();
    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
  });

  it("the user's default formatter is passed to the backend and the time limit and policy come from settings", async () => {
    r.settings["editor.defaultFormatter"] = "prettier";
    r.settings["formatter.timeoutMs"] = 3000;
    r.settings["formatter.useSystemTools"] = true;
    await r.service.formatActive();
    expect(vi.mocked(r.ipc.formatOptions).mock.calls[0]?.[2]).toBe("prettier");
    const request = vi.mocked(r.ipc.formatRun).mock.calls[0]?.[0];
    expect(request?.preferred).toBe("prettier");
    expect(request?.timeoutMs).toBe(3000);
    expect(request?.policy.system).toBe(true);
  });
});

describe("language server formatting", () => {
  it("is used when no other formatter is available and its text is applied", async () => {
    r = rig({ lsp: { available: true, text: PRETTY } });
    vi.mocked(r.ipc.formatOptions).mockResolvedValue(
      answer([PRETTIER_MISSING], { languageName: "TypeScript" }),
    );
    const outcome = await r.service.formatActive();
    expect(outcome).toEqual({ kind: "formatted", formatter: "Language server" });
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
    expect(r.host.texts.get("d1")).toBe(PRETTY);
  });

  it("a tool formatter that is available wins over the server unless the user prefers the server", async () => {
    r = rig({ lsp: { available: true, text: "from server" } });
    await r.service.formatActive();
    expect(vi.mocked(r.ipc.formatRun).mock.calls).toHaveLength(1);
    r.host.texts.set("d1", MINIFIED);
    r.settings["editor.defaultFormatter"] = LSP_FORMATTER_ID;
    await r.service.formatActive();
    expect(r.host.texts.get("d1")).toBe("from server");
    expect(vi.mocked(r.ipc.formatRun).mock.calls).toHaveLength(1);
  });
});

describe("Format Document With... and the default formatter", () => {
  it("lists every formatter with its source or the reason it is unavailable", async () => {
    await r.service.openDialog("with");
    const dialog = r.service.getState().dialog;
    expect(dialog?.status.choices.map((c) => [c.id, c.available])).toEqual([
      ["builtin.json", true],
      ["prettier", false],
    ]);
    expect(dialog?.status.choices[1]?.reason).toContain("npm i -D prettier");
  });

  it("choosing one formats with it and, when asked, remembers it for the language", async () => {
    await r.service.openDialog("with");
    r.service.setRemember(true);
    await r.service.pick("builtin.json");
    expect(vi.mocked(r.ipc.formatRun).mock.calls[0]?.[0].toolId).toBe("builtin.json");
    expect(r.ipc.settingsSet).toHaveBeenCalledWith(
      "formatting.defaults",
      JSON.stringify({ json: "builtin.json" }),
    );
    expect(r.service.preferredFor("json")).toBe("builtin.json");
    expect(r.service.getState().dialog).toBeNull();
  });

  it("an unavailable formatter can't be picked", async () => {
    await r.service.openDialog("with");
    await r.service.pick("prettier");
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
    expect(r.service.getState().dialog).not.toBeNull();
  });

  it("Configure Default Formatter only saves the choice (nothing is formatted)", async () => {
    await r.service.openDialog("configure");
    await r.service.pick("builtin.json");
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
    expect(r.notices.at(-1)).toContain("default formatter for JSON");
  });

  it("saved defaults are read back on start and can be cleared", async () => {
    vi.mocked(r.ipc.settingsGet).mockResolvedValue('{"json":"biome","python":7}');
    await r.service.initialize();
    expect(r.service.preferredFor("json")).toBe("biome");
    expect(r.service.preferredFor("python")).toBeNull();
    await r.service.clearDefault("json");
    expect(r.service.preferredFor("json")).toBeNull();
  });
});

describe("Format on Save", () => {
  it("does nothing while the setting is off", async () => {
    r.settings["editor.formatOnSave"] = false;
    await r.service.beforeSave("d1");
    expect(r.ipc.formatOptions).not.toHaveBeenCalled();
    expect(r.host.applied).toEqual([]);
  });

  it("is on by default and formats before the save", async () => {
    await r.service.beforeSave("d1");
    expect(r.host.texts.get("d1")).toBe(PRETTY);
  });

  it("a failing formatter reports it, never throws and never blocks the save", async () => {
    r.settings["editor.formatOnSave"] = true;
    vi.mocked(r.ipc.formatRun).mockRejectedValue("Prettier failed: SyntaxError");
    await expect(r.service.beforeSave("d1")).resolves.toBeUndefined();
    expect(r.errors[0]).toContain("Format on Save: Prettier failed");
    expect(r.errors[0]).toContain("saved as it was");
    expect(r.host.texts.get("d1")).toBe(MINIFIED);
  });

  it("a language with no formatter is silent on save (a note in the log only)", async () => {
    r.settings["editor.formatOnSave"] = true;
    vi.mocked(r.ipc.formatOptions).mockResolvedValue(
      answer([], { reason: "No formatter configured for Plain Text." }),
    );
    await r.service.beforeSave("d1");
    expect(r.errors).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.log.join("\n")).toContain("No formatter configured for Plain Text.");
  });

  it("an unsaved file and a huge file are skipped", async () => {
    r.settings["editor.formatOnSave"] = true;
    r.host.texts.set("d1", "x".repeat(2_000_001));
    await r.service.beforeSave("d1");
    expect(r.ipc.formatRun).not.toHaveBeenCalled();
    expect(r.log.join("\n")).toContain("too large");
  });
});

describe("status", () => {
  it("reads like the spec's examples", async () => {
    await r.service.refreshStatus();
    const status = r.service.getState().status;
    expect(status && statusText(status)).toBe("JSON — Built-in JSON formatter");

    vi.mocked(r.ipc.formatOptions).mockResolvedValue(
      answer(
        [
          { ...PRETTIER_MISSING, id: "black", name: "Black" },
          { ...PRETTIER_MISSING, id: "ruff", name: "Ruff" },
        ],
        { languageName: "Python" },
      ),
    );
    await r.service.refreshStatus();
    const python = r.service.getState().status;
    expect(python && statusText(python)).toBe("Python — Black missing, Ruff missing");

    vi.mocked(r.ipc.formatOptions).mockResolvedValue(
      answer([{ ...BUILTIN, id: "prettier", name: "Prettier", source: "project", mode: "stdin" }], {
        languageName: "TypeScript",
      }),
    );
    await r.service.refreshStatus();
    const ts = r.service.getState().status;
    expect(ts && statusText(ts)).toBe("TypeScript — Prettier (from the project)");
  });

  it("there is no status while no text file is in front", async () => {
    r.host.focus.value = "Open a text file first.";
    await r.service.refreshStatus();
    expect(r.service.getState().status).toBeNull();
  });
});

describe("extension formatters (Milestone 18)", () => {
  it("are offered but never chosen ahead of the built-in or tool formatters", async () => {
    const x = rig({ extension: { text: "FROM EXTENSION" } });
    const outcome = await x.service.formatActive();
    expect(outcome).toEqual({ kind: "formatted", formatter: "Built-in JSON formatter" });
    expect(x.host.texts.get("d1")).toBe(PRETTY);
  });

  it("run when the user picks one explicitly", async () => {
    const x = rig({ extension: { text: "FROM EXTENSION" } });
    const outcome = await x.service.formatActive("ext:pub.fmt");
    expect(outcome).toEqual({ kind: "formatted", formatter: "Fmt (extension)" });
    expect(x.host.texts.get("d1")).toBe("FROM EXTENSION");
    expect(x.ipc.formatRun).not.toHaveBeenCalled();
  });

  it("are the last resort when nothing else can format the file", async () => {
    const x = rig({ extension: { text: "FROM EXTENSION" } });
    vi.mocked(x.ipc.formatOptions).mockResolvedValue(answer([PRETTIER_MISSING]));
    const outcome = await x.service.formatActive();
    expect(outcome).toEqual({ kind: "formatted", formatter: "Fmt (extension)" });
  });
});

describe("the formatter status while typing", () => {
  it("is looked up once per file in front, not on every edit (local or a collaborator's)", async () => {
    for (let i = 0; i < 50; i++) await r.service.refreshStatusIfChanged();
    expect(r.ipc.formatOptions).toHaveBeenCalledTimes(1);
    // Another file in front, or the same file now another language: looked up again.
    r.host.focus.value = {
      ...(r.host.focus.value as FormatTarget),
      id: "d2",
      path: "C:/My Project/b.json",
    };
    await r.service.refreshStatusIfChanged();
    r.host.focus.value = { ...(r.host.focus.value), language: "jsonc" };
    await r.service.refreshStatusIfChanged();
    await r.service.refreshStatusIfChanged();
    expect(r.ipc.formatOptions).toHaveBeenCalledTimes(3);
    // No editor in front: nothing to look up.
    r.host.focus.value = "Open a text file first.";
    await r.service.refreshStatusIfChanged();
    expect(r.ipc.formatOptions).toHaveBeenCalledTimes(3);
    expect(r.service.getState().status).toBeNull();
  });

  it("is looked up again when the file's language server becomes available", async () => {
    let available = false;
    const lsp = rig({ lsp: { available: () => available } });
    await lsp.service.refreshStatusIfChanged();
    await lsp.service.refreshStatusIfChanged();
    available = true;
    await lsp.service.refreshStatusIfChanged();
    expect(lsp.ipc.formatOptions).toHaveBeenCalledTimes(2);
  });
});
