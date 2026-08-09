import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * Integrated terminal (plan §6, 3.6).
 *
 * Runs in the *thread's* cwd, which is the worktree when one is active — the
 * user's shell and the agent see the same files. A terminal pointing at the
 * main checkout while the agent works in a worktree is exactly the confusion
 * the isolation feature exists to prevent.
 *
 * The PTY lives in the main process; this is only a view onto it, so the
 * shell survives a renderer reload.
 */
export function TerminalPane({
  id,
  visible,
  onClose,
  embedded = false,
}: {
  id: string;
  visible: boolean;
  onClose: () => void;
  /**
   * Inside a workbench panel the tab strip owns hiding and closing, so the
   * pane drops its own header. `Kill` moves to the strip's actions — it is a
   * distinct, destructive action and must not merge into "close tab".
   */
  embedded?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;

    const term = new Terminal({
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      theme: {
        background: "#0e0f10",
        foreground: "#eef0f0",
        cursor: "#b9bfc0",
        selectionBackground: "rgba(232,76,39,0.28)",
      },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const start = async () => {
      fit.fit();
      const ok = await window.codexDesk.termOpen(id, term.cols, term.rows);
      if (disposed) return;
      if (!ok) {
        term.writeln(
          "\x1b[31mTerminal unavailable.\x1b[0m The native PTY module could " +
            "not be loaded.",
        );
        term.writeln("Run \x1b[36mnpm run rebuild\x1b[0m and restart.");
      }
    };
    void start();

    term.onData((data) => void window.codexDesk.termWrite(id, data));

    const off = window.codexDesk.onEvent((ev) => {
      if (ev.type === "terminalData" && ev.id === id) term.write(ev.data);
      if (ev.type === "terminalExit" && ev.id === id) {
        term.writeln(`\r\n\x1b[90m[process exited: ${ev.code}]\x1b[0m`);
      }
    });

    const onResize = () => {
      if (!visible) return;
      fit.fit();
      void window.codexDesk.termResize(id, term.cols, term.rows);
    };
    window.addEventListener("resize", onResize);

    /*
      The window is no longer the only thing that changes the terminal's size:
      dragging the bottom panel's splitter resizes it while the window stays
      put, and xterm does not reflow on its own. Without this the shell keeps
      its old column count and output wraps at the wrong width.
    */
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => onResize())
        : null;
    if (observer && hostRef.current) observer.observe(hostRef.current);

    return () => {
      disposed = true;
      off();
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // `visible` is read inside the handler; re-running on it would tear down
    // the shell every time the pane is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Refit when the pane becomes visible: it was sized to a hidden (zero) box.
  useEffect(() => {
    if (!visible || !termRef.current || !fitRef.current) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) void window.codexDesk.termResize(id, term.cols, term.rows);
    }, 30);
    return () => clearTimeout(t);
  }, [visible, id]);

  return (
    <div
      className={`terminal-pane${embedded ? " embedded" : ""}`}
      style={{ display: visible ? "flex" : "none" }}
    >
      {!embedded && (
        <div className="terminal-head">
          <span className="muted">terminal</span>
          <span className="spacer" />
          {/*
            Hiding and killing are separate actions.
            `Close` used to call `termClose`, which disposes the PTY — so the
            button that looks like "put this away" silently discarded a running
            shell and any state in it, while the `Mod+\`` toggle only hid the
            pane. Two controls that appear equivalent were not, and the
            destructive one was the unlabelled one.
          */}
          <button
            className="linkish"
            title="Kill the shell and close the panel"
            onClick={() => {
              void window.codexDesk.termClose(id);
              onClose();
            }}
          >
            Kill
          </button>
          <button
            className="linkish"
            title="Hide the panel; the shell keeps running (⌘`)"
            onClick={onClose}
          >
            Hide
          </button>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
