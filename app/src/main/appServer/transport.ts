import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Newline-delimited JSON over the app-server's stdio.
 *
 * Two invariants worth naming, because both are silent when broken:
 * - stdout arrives in arbitrary chunks, so a message can be split across
 *   reads. We buffer until a newline rather than parsing per chunk.
 * - stderr is not noise. The server logs real failures there (model cache
 *   errors, auth problems) that never appear on the JSON channel.
 */
export type TransportEvents = {
  message: (msg: unknown) => void;
  stderr: (line: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export class StdioTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private handlers: Partial<TransportEvents> = {};

  constructor(private readonly command: string = "codex") {}

  on<K extends keyof TransportEvents>(ev: K, fn: TransportEvents[K]): void {
    this.handlers[ev] = fn;
  }

  start(): void {
    if (this.child) throw new Error("transport already started");

    const child = spawn(this.command, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    child.on("exit", (code, signal) => {
      this.child = null;
      this.handlers.exit?.(code, signal);
    });
  }

  /** Exposed for tests: feed raw stdout text through the line buffer. */
  onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        this.handlers.message?.(JSON.parse(line));
      } catch {
        // A malformed line is a server bug, not a reason to tear down the
        // connection. Report it and keep reading.
        this.handlers.stderr?.(`unparseable message: ${line.slice(0, 500)}`);
      }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let idx: number;
    while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (line.trim()) this.handlers.stderr?.(line);
    }
  }

  send(msg: unknown): void {
    if (!this.child) throw new Error("transport not started");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
