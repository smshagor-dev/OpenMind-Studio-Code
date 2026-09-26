/**
 * Start-up diagnostics: how long each start-up phase took, in milliseconds. Only the phase names and durations are kept
 * (no paths, no settings), reported once to the backend, which writes one line to the app log. Nothing is sent
 * anywhere else.
 */
export class StartupTimings {
  private readonly marks: [string, number][] = [];
  private last: number;
  private readonly began: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.began = this.now();
    this.last = this.began;
  }

  /** Records that the phase called `name` just finished (its duration is the time since the previous mark). */
  mark(name: string): void {
    const at = this.now();
    this.marks.push([name, Math.max(0, Math.round(at - this.last))]);
    this.last = at;
  }

  /** The phases so far, in order. */
  phases(): [string, number][] {
    return [...this.marks];
  }

  /** Milliseconds since the timings started. */
  elapsed(): number {
    return Math.max(0, Math.round(this.now() - this.began));
  }
}
