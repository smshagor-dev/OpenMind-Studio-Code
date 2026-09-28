/**
 * Rebuilds the command line a user typed into a terminal from the raw input (keys and pastes), so a command that
 * failed on the network can be run again in a new, proxy-ready terminal. Backspace edits the line, Ctrl+C and
 * Ctrl+U clear it, Enter submits. Escape sequences that move in or recall a line (arrows, Home/End, Delete, history)
 * make the line unknown — the shell changed it; the terminal's own replies that share this channel (the cursor
 * position report PowerShell keeps asking for, device attributes, focus events) and bracketed-paste markers don't.
 */
export class CommandLineTracker {
  private line = "";
  private known = true;
  private escape: string | null = null;
  private lastSubmitted: string | null = null;

  /** Feeds input; returns the submitted command when the input contained Enter. */
  feed(data: string): string | null {
    let submitted: string | null = null;
    for (const ch of data) {
      if (this.escape !== null) {
        this.escape += ch;
        // ESC [ params final (CSI) ends with a letter or ~; ESC O x (SS3) and ESC x end after one more character.
        const csi = this.escape.startsWith("[");
        const done = csi ? /[A-Za-z~]/.test(ch) : this.escape.length >= (this.escape.startsWith("O") ? 2 : 1);
        if (done) {
          if (!neutral(this.escape)) this.known = false;
          this.escape = null;
        }
        continue;
      }
      if (ch === "\u001b") {
        this.escape = "";
      } else if (ch === "\r" || ch === "\n") {
        const text = this.line.trim();
        if (this.known && text !== "") {
          submitted = text;
          this.lastSubmitted = text;
        }
        this.line = "";
        this.known = true;
      } else if (ch === "\u007f" || ch === "\b") {
        this.line = this.line.slice(0, -1);
      } else if (ch === "\u0003" || ch === "\u0015") {
        this.line = "";
        this.known = true;
      } else if (ch >= " ") {
        this.line += ch;
      }
    }
    return submitted;
  }

  /** The last command submitted with a line OpenMind could follow, or `null`. */
  last(): string | null {
    return this.lastSubmitted;
  }
}

/** Escape sequences (without the ESC) that don't change what was typed. */
function neutral(sequence: string): boolean {
  return (
    /^\[\d+;\d+R$/.test(sequence) || // cursor position report (reply to ESC[6n)
    /^\[[?>]?[\d;]*c$/.test(sequence) || // device attributes reply
    /^\[\d*n$/.test(sequence) || // status report reply
    sequence === "[I" || // focus in
    sequence === "[O" || // focus out
    sequence === "[200~" || // bracketed paste start
    sequence === "[201~" // bracketed paste end
  );
}
