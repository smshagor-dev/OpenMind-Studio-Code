import { useState } from "react";

import { extensionOf } from "../services/editorAssociationService";
import { container } from "../services/container";
import type { RunTarget } from "../services/runConfigurationService";

/** Configure Run Command: the command template and where output goes, for the active file's type. */
export function RunConfigurationDialog({ onClose }: { onClose: () => void }) {
  const editor = container.runCode.activeEditor();
  const extension = extensionOf(editor?.path ?? null);
  const current = container.runConfigs.get(extension);
  const [command, setCommand] = useState(current?.command ?? "");
  const [target, setTarget] = useState<RunTarget>(current?.target ?? "output");
  const [error, setError] = useState<string | null>(null);

  if (extension === null || current === null) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" role="dialog" aria-modal="true" aria-label="Configure Run Command">
          <h2>Configure Run Command</h2>
          <p>Run Code doesn&apos;t support this file type, so there is no command to configure.</p>
          <div className="modal__actions">
            <button type="button" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  const defaultCommand = container.runConfigs.defaultCommand(extension) ?? "";

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="modal modal--run-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-config-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="run-config-title">Configure Run Command for {extension}</h2>
        <p className="run-config__hint">
          Run as a program with arguments — there is no shell, so <code>&amp;&amp;</code>,{" "}
          <code>|</code> and <code>&gt;</code> are just text. Variables: <code>{"${file}"}</code>,{" "}
          <code>{"${fileDir}"}</code>, <code>{"${fileBasename}"}</code>,{" "}
          <code>{"${workspaceFolder}"}</code>.
        </p>
        <label className="run-config__field">
          Command
          <input
            type="text"
            aria-label="Run command"
            value={command}
            spellCheck={false}
            onChange={(event) => {
              setCommand(event.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="run-config__field">
          Run in
          <select
            aria-label="Run target"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value === "terminal" ? "terminal" : "output");
            }}
          >
            <option value="output">Output panel</option>
            <option value="terminal">Terminal</option>
          </select>
        </label>
        <p className="run-config__hint">
          Default: <code>{defaultCommand}</code>
        </p>
        {error ? (
          <p className="run-config__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal__actions">
          <button
            type="button"
            onClick={() => {
              void container.runConfigs.reset(extension).then(onClose);
            }}
          >
            Reset to Default
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              void container.runConfigs.set(extension, command, target).then((problem) => {
                if (problem === null) onClose();
                else setError(problem);
              });
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
