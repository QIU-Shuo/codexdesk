import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  ChangesPane,
  toSplitRows,
} from "../src/renderer/main_window/ChangesPane";
import type { ChangesView, DiffLineView } from "../src/shared/ipc";
import type { CurrentReviewComment } from "../src/renderer/compatibility/reviewPresentation";

/**
 * The changes pane's two risky parts are the split-view pairing (a modified
 * line must show old beside new, not on separate rows) and the promise that a
 * failed diff never renders as "no changes".
 */

afterEach(cleanup);

function line(
  kind: DiffLineView["kind"],
  text: string,
  leftLine: number | null,
  rightLine: number | null,
): DiffLineView {
  return { kind, text, leftLine, rightLine };
}

describe("toSplitRows", () => {
  it("pairs a deletion with the addition that replaced it", () => {
    const rows = toSplitRows([
      line("context", "keep", 1, 1),
      line("delete", "old", 2, null),
      line("add", "new", null, 2),
      line("context", "tail", 3, 3),
    ]);

    expect(rows).toHaveLength(3);
    // The modified line occupies one row with both sides filled.
    expect(rows[1].left?.text).toBe("old");
    expect(rows[1].right?.text).toBe("new");
  });

  it("pairs runs of unequal length, leaving the shorter side empty", () => {
    const rows = toSplitRows([
      line("delete", "a", 1, null),
      line("delete", "b", 2, null),
      line("add", "x", null, 1),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      left: { text: "a" },
      right: { text: "x" },
    });
    // Second deletion has nothing opposite it.
    expect(rows[1].left?.text).toBe("b");
    expect(rows[1].right).toBeNull();
  });

  it("puts context on both sides", () => {
    const rows = toSplitRows([line("context", "same", 5, 7)]);
    expect(rows[0].left?.leftLine).toBe(5);
    expect(rows[0].right?.rightLine).toBe(7);
  });

  it("skips the no-newline marker without consuming a row", () => {
    const rows = toSplitRows([
      line("delete", "old", 1, null),
      line("meta", "\\ No newline at end of file", null, null),
      line("add", "new", null, 1),
    ]);
    // Still one paired row, not three.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      left: { text: "old" },
      right: { text: "new" },
    });
  });

  it("terminates on an additions-only hunk", () => {
    const rows = toSplitRows([
      line("add", "one", null, 1),
      line("add", "two", null, 2),
    ]);
    expect(rows.map((r) => r.right?.text)).toEqual(["one", "two"]);
    expect(rows.every((r) => r.left === null)).toBe(true);
  });
});

function changes(over: Partial<ChangesView> = {}): ChangesView {
  return {
    scope: "session",
    baseSha: "abc1234def",
    sessionAvailable: true,
    files: [],
    additions: 0,
    deletions: 0,
    error: null,
    ...over,
  };
}

const FILE = {
  path: "src/app.ts",
  oldPath: null,
  status: "modified" as const,
  additions: 1,
  deletions: 1,
  suppressed: false,
  suppressedReason: null,
  hunks: [
    {
      hunkId: "src/app.ts:0",
      hunkIndex: 0,
      header: "@@ -1,3 +1,3 @@ main()",
      context: "main()",
      lines: [
        line("context", "keep", 1, 1),
        line("delete", "old", 2, null),
        line("add", "new", null, 2),
      ],
    },
  ],
};

function renderPane(
  over: Partial<ChangesView> = {},
  comments: CurrentReviewComment[] = [],
) {
  const onAddComment = vi.fn();
  render(
    <ChangesPane
      changes={changes(over)}
      comments={comments}
      onAddComment={onAddComment}
      onRemoveComment={vi.fn()}
      onOpenFile={vi.fn()}
      onRefresh={vi.fn()}
      onSetScope={vi.fn()}
    />,
  );
  return { onAddComment };
}

describe("ChangesPane", () => {
  it("shows a diff failure as an error, never as 'no changes'", () => {
    // Reporting an empty pane for a diff we could not compute would read as
    // "your work is gone".
    renderPane({ error: "fatal: bad object", files: [] });
    expect(screen.getByText(/Could not compute the diff/)).toBeTruthy();
    expect(screen.queryByText("No changes yet.")).toBeNull();
  });

  it("says there are no changes only when there genuinely are none", () => {
    renderPane({ files: [] });
    expect(screen.getByText("No changes yet.")).toBeTruthy();
  });

  it("names the base commit being reviewed against", () => {
    renderPane({ files: [FILE] });
    expect(screen.getByText("abc1234")).toBeTruthy();
  });

  it("summarizes a binary file instead of rendering it", () => {
    renderPane({
      files: [
        {
          ...FILE,
          path: "logo.png",
          status: "binary",
          suppressed: true,
          suppressedReason: "binary",
          hunks: [],
        },
      ],
    });
    expect(screen.getByText(/Binary file/)).toBeTruthy();
  });

  it("anchors a comment to the side of the line that was clicked", async () => {
    const { onAddComment } = renderPane({ files: [FILE] });

    // Click the right gutter of the added line.
    const gutters = document.querySelectorAll(".diff-table .gutter");
    const rightGutterOfAdd = [...gutters].find(
      (g) => g.textContent === "2" && g.previousElementSibling !== null,
    )!;
    await act(async () => {
      rightGutterOfAdd.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const textarea = document.querySelector(
      ".comment-editor textarea",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "fix this");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (
        document.querySelector(
          ".comment-editor-actions .primary",
        ) as HTMLButtonElement
      ).click();
    });

    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/app.ts", text: "fix this" }),
    );
  });

  it("renders a stale comment with its text and a label, not hidden", () => {
    const stale: CurrentReviewComment = {
      commentId: "c1",
      filePath: "src/app.ts",
      side: "right",
      startLine: 2,
      endLine: 2,
      hunkId: "gone:0",
      commentText: "still my words",
      quotedLines: ["new"],
      stale: true,
      createdAtMs: 0,
    };
    renderPane({ files: [FILE] }, [stale]);
    expect(screen.getByText("still my words")).toBeTruthy();
    expect(screen.getByText("stale")).toBeTruthy();
  });

  it("says nothing changed when a non-worktree thread's turn is empty", () => {
    // No worktree means no base commit, so only the turn scope exists — the
    // scope control is hidden rather than offering something uncomputable.
    renderPane({
      scope: "turn",
      baseSha: null,
      sessionAvailable: false,
      files: [],
    });
    expect(screen.getByText(/No file changes reported/)).toBeTruthy();
    expect(screen.queryByText("Session")).toBeNull();
  });

  it("offers both scopes when a session diff is available", () => {
    renderPane({ scope: "session", files: [FILE] });
    expect(screen.getByText("Turn")).toBeTruthy();
    expect(screen.getByText("Session")).toBeTruthy();
  });

  it("points at the session scope when the last turn changed nothing", () => {
    // An empty turn is not the same as an empty thread, and saying so saves
    // the user concluding their work is gone.
    renderPane({ scope: "turn", baseSha: null, files: [] });
    expect(screen.getByText(/Switch to Session/)).toBeTruthy();
  });

  it("switches scope through the control", async () => {
    const onSetScope = vi.fn();
    render(
      <ChangesPane
        changes={changes({ scope: "session", files: [FILE] })}
        comments={[]}
        onAddComment={vi.fn()}
        onRemoveComment={vi.fn()}
        onOpenFile={vi.fn()}
        onRefresh={vi.fn()}
        onSetScope={onSetScope}
      />,
    );
    await act(async () => screen.getByText("Turn").click());
    expect(onSetScope).toHaveBeenCalledWith("turn");
  });
});
