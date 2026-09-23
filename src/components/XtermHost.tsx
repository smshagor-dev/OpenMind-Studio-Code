import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { container } from "../services/container";
import "@xterm/xterm/css/xterm.css";

interface XtermHostProps {
  id: string;
  /** Only the active session's view is displayed; the others stay mounted so their scrollback survives tab switches. */
  active: boolean;
  themeKind: string;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Mounts one xterm.js instance for a terminal session. UI-only, like
 * `MonacoHost`: keystrokes go out through `container.terminal.write`, output
 * comes in through the sink registered with `attachSink`, and the pty is
 * resized to whatever the fit addon computes. No terminal logic lives here.
 */
export function XtermHost({ id, active, themeKind }: XtermHostProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 14,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // Ctrl+` / Ctrl+Shift+` belong to the app (toggle / new terminal): keep xterm from
      // consuming them so they still reach the window keybinding listener.
      if (event.ctrlKey && event.code === "Backquote") return false;
      const ctrl = event.ctrlKey || event.metaKey;
      // Copy: with a selection Ctrl+C / Ctrl+Shift+C copy it (via the system clipboard, since the
      // webview's own clipboard API doesn't work here); without one, Ctrl+C stays the shell's interrupt.
      if (ctrl && event.code === "KeyC" && (event.shiftKey || terminal.hasSelection())) {
        void container.terminal.copyToClipboard(terminal.getSelection());
        return false;
      }
      // Paste goes into this view's terminal only. `preventDefault` stops the browser's own paste
      // event from also firing and pasting a second time.
      if (ctrl && event.code === "KeyV") {
        event.preventDefault();
        void container.terminal.readClipboard().then((text) => {
          if (text !== "") terminal.paste(text);
        });
        return false;
      }
      return true;
    });

    const detachSink = container.terminal.attachSink(id, {
      write: (data) => {
        terminal.write(data);
      },
      clear: () => {
        terminal.clear();
      },
    });
    const input = terminal.onData((data) => {
      container.terminal.write(id, data);
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      container.terminal.resize(id, cols, rows);
    });

    const observer = new ResizeObserver(() => {
      // Hidden (display: none) panes measure 0x0; fitting then would collapse the pty.
      if (element.offsetWidth > 0 && element.offsetHeight > 0) fit.fit();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      resize.dispose();
      input.dispose();
      detachSink();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = {
      background: cssVar("--editor-bg", "#1e1e1e"),
      foreground: cssVar("--fg", "#cccccc"),
      cursor: cssVar("--fg", "#cccccc"),
    };
  }, [themeKind]);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }
  }, [active]);

  return (
    <div
      ref={elementRef}
      className={active ? "xterm-host" : "xterm-host xterm-host--hidden"}
      role="region"
      aria-label="Terminal"
    />
  );
}
