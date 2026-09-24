import { extensionOf } from "./editorAssociationService";
import type { HeaderMenuRow } from "./editorHeaderMenu";
import type { RunConfigurationService } from "./runConfigurationService";
import type { RunCodeService } from "./runCodeService";

export interface RunMenuContext {
  runCode: RunCodeService;
  configs: RunConfigurationService;
  /** Runs a command by id (the same path menus and shortcuts take). */
  run: (id: string, ...args: unknown[]) => void;
}

/**
 * The dropdown beside the Run button. Every row either works or is disabled
 * with the real reason (the same one the button's tooltip gives); "Stop
 * Running Code" only appears while something is running.
 */
export function buildRunMenu(ctx: RunMenuContext): HeaderMenuRow[] {
  const { runCode, configs } = ctx;
  const view = runCode.buttonView();
  const editor = runCode.activeEditor();
  const extension = extensionOf(editor?.path ?? null);
  const availability = runCode.getState().availability;
  const canStart = view.enabled && !view.canStop;
  const running = view.canStop;

  const start = (label: string, command: string, showReason = false): HeaderMenuRow => ({
    kind: "item",
    label,
    enabled: canStart,
    reason: canStart ? undefined : running ? "Already running — stop it first." : view.tooltip,
    showReason: !running && showReason,
    onSelect: () => {
      ctx.run(command);
    },
  });

  const rows: HeaderMenuRow[] = [
    start("Run Code", "run.code", true),
    start("Run Code in Terminal", "run.codeInTerminal"),
    start("Run Code and Show Output", "run.codeShowOutput"),
  ];

  if (availability?.previewable === true) {
    rows.push(
      { kind: "separator" },
      {
        kind: "item",
        label: "Open Markdown Preview",
        enabled: true,
        onSelect: () => {
          ctx.run("editor.openPreview");
        },
      },
      {
        kind: "item",
        label: "Open Preview to the Side",
        enabled: true,
        onSelect: () => {
          ctx.run("editor.openPreviewToSide");
        },
      },
    );
  }

  const configurable = configs.supports(extension);
  rows.push(
    { kind: "separator" },
    {
      kind: "item",
      label: "Configure Run Command…",
      enabled: configurable,
      reason: configurable
        ? undefined
        : editor?.path == null
          ? "Save the file first, then choose its run command."
          : "Run Code doesn't support this file type, so there is no command to configure.",
      onSelect: () => {
        ctx.run("run.configure");
      },
    },
    {
      kind: "item",
      label: "Select Runtime…",
      enabled: true,
      onSelect: () => {
        ctx.run("run.selectRuntime");
      },
    },
  );

  if (runCode.isRunning()) {
    rows.push(
      { kind: "separator" },
      {
        kind: "item",
        label: "Stop Running Code",
        enabled: true,
        onSelect: () => {
          ctx.run("run.stop");
        },
      },
    );
  }
  return rows;
}
