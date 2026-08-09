import type { IPty } from "node-pty";

/**
 * PTY host for the integrated terminal (plan §6, 3.6).
 *
 * `node-pty` keeps terminal lifecycle local to the desktop process and gives
 * xterm a direct byte stream. The cost is a native rebuild against Electron's
 * ABI (`npm run rebuild`).
 *
 * The terminal deliberately runs in the *thread's* cwd, which is the worktree
 * when one is active. A terminal pointing somewhere other than where the
 * agent works is the exact confusion the worktree feature exists to avoid.
 */
export type TerminalEvents = {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
};

type Session = { pty: IPty; cwd: string };

export class TerminalHost {
  private sessions = new Map<string, Session>();
  private ptyModule: typeof import("node-pty") | null = null;

  constructor(private readonly events: TerminalEvents) {}

  /**
   * `node-pty` is loaded lazily: it is a native module, and a failed build
   * should disable the terminal rather than prevent the app from starting.
   */
  private load(): typeof import("node-pty") | null {
    if (this.ptyModule) return this.ptyModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.ptyModule = require("node-pty") as typeof import("node-pty");
      return this.ptyModule;
    } catch {
      return null;
    }
  }

  get available(): boolean {
    return this.load() !== null;
  }

  /** Used by the updater to avoid silently killing interactive shells. */
  get openSessionCount(): number {
    return this.sessions.size;
  }

  open(id: string, cwd: string, cols = 80, rows = 24): boolean {
    if (this.sessions.has(id)) return true;
    const pty = this.load();
    if (!pty) return false;

    const shell =
      process.env.SHELL ||
      (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

    try {
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      });
      proc.onData((data) => this.events.onData(id, data));
      proc.onExit(({ exitCode }) => {
        this.sessions.delete(id);
        this.events.onExit(id, exitCode);
      });
      this.sessions.set(id, { pty: proc, cwd });
      return true;
    } catch {
      return false;
    }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    // A resize to zero happens while the pane is hidden and kills some shells.
    if (cols < 1 || rows < 1) return;
    try {
      this.sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      // The process may have exited between the check and the call.
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
