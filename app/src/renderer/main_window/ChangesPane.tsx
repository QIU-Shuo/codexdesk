import { useMemo, useState } from "react";
import type {
  ChangesView,
  DiffFileView,
  DiffHunkView,
  DiffLineView,
  DiffSideView,
  ChangesScope,
} from "../../shared/ipc";
import type { CurrentReviewComment } from "../compatibility/reviewPresentation";

/**
 * The changes pane (plan §7.1).
 *
 * Shows the whole change set rather than one turn's diff, because that is what
 * a person reviews before shipping. Two view modes: unified for reading, split
 * for commenting — comments anchor to a **side**, and a split view is what
 * makes choosing a side a physical act rather than a dropdown.
 *
 * Selection is the interaction that matters. Click a line number to start a
 * comment; shift-click a second to extend it into a range, because §7.3's
 * `startLine`/`endLine` say ranges are the norm, not an edge case.
 */

export function ChangesPane({
  changes,
  comments,
  onAddComment,
  onRemoveComment,
  onOpenFile,
  onRefresh,
  onSetScope,
}: {
  changes: ChangesView | null;
  comments: CurrentReviewComment[];
  onAddComment: (draft: {
    filePath: string;
    side: DiffSideView;
    startLine: number;
    endLine: number;
    text: string;
  }) => void;
  onRemoveComment: (commentId: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onSetScope: (scope: ChangesScope) => void;
}) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const files = changes?.files ?? [];
  const commentsByFile = useMemo(() => {
    const map = new Map<string, CurrentReviewComment[]>();
    for (const c of comments) {
      const list = map.get(c.filePath) ?? [];
      list.push(c);
      map.set(c.filePath, list);
    }
    return map;
  }, [comments]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="changes-shell">
      <div className="changes-head">
        <span>Changes</span>
        <div className="changes-head-actions">
          {changes && !changes.error && files.length > 0 && (
            <span className="changes-total">
              <span className="add">+{changes.additions}</span>
              <span className="del">−{changes.deletions}</span>
            </span>
          )}
          {/* Scope first: "what am I reviewing" comes before "how is it
              drawn". Hidden when there is no worktree, since a thread in your
              checkout has no base commit and only the turn scope exists. */}
          {changes?.sessionAvailable && (
            <div className="seg">
              <button
                className={changes.scope === "turn" ? "on" : ""}
                onClick={() => onSetScope("turn")}
                title="The diff app-server reported at the end of the last turn"
              >
                Turn
              </button>
              <button
                className={changes.scope === "session" ? "on" : ""}
                onClick={() => onSetScope("session")}
                title="Everything since this thread started"
              >
                Session
              </button>
            </div>
          )}
          <div className="seg">
            <button
              className={mode === "unified" ? "on" : ""}
              onClick={() => setMode("unified")}
            >
              Unified
            </button>
            <button
              className={mode === "split" ? "on" : ""}
              onClick={() => setMode("split")}
            >
              Split
            </button>
          </div>
          <button className="ghost tiny" onClick={onRefresh} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {changes?.baseSha && (
        <div className="changes-base">
          against <code>{changes.baseSha.slice(0, 7)}</code>
        </div>
      )}

      <div className="changes-body">
        {changes?.error ? (
          // Never render this as "no changes" — that would read as "your work
          // is gone" when the truth is "we could not compute the diff".
          <div className="changes-error">
            <strong>Could not compute the diff.</strong>
            <pre>{changes.error}</pre>
          </div>
        ) : files.length === 0 ? (
          <div className="changes-empty">
            {changes?.scope === "turn"
              ? changes.sessionAvailable
                ? "No file changes reported for the last turn. Switch to Session to diff against the thread's base commit."
                : "No file changes reported for the last turn."
              : "No changes yet."}
          </div>
        ) : (
          files.map((file) => (
            <FileBlock
              key={file.path}
              file={file}
              mode={mode}
              collapsed={collapsed.has(file.path)}
              comments={commentsByFile.get(file.path) ?? []}
              onToggle={() => toggle(file.path)}
              onAddComment={onAddComment}
              onRemoveComment={onRemoveComment}
              onOpenFile={onOpenFile}
            />
          ))
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<DiffFileView["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  binary: "binary",
};

function FileBlock({
  file,
  mode,
  collapsed,
  comments,
  onToggle,
  onAddComment,
  onRemoveComment,
  onOpenFile,
}: {
  file: DiffFileView;
  mode: "unified" | "split";
  collapsed: boolean;
  comments: CurrentReviewComment[];
  onToggle: () => void;
  onAddComment: (draft: {
    filePath: string;
    side: DiffSideView;
    startLine: number;
    endLine: number;
    text: string;
  }) => void;
  onRemoveComment: (commentId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className={`diff-file${collapsed ? " collapsed" : ""}`}>
      <div className="diff-file-head">
        <button className="diff-file-toggle" onClick={onToggle}>
          <span className="caret">{collapsed ? "▸" : "▾"}</span>
          <span className="diff-path" title={file.path}>
            {file.oldPath ? (
              <>
                <span className="muted">{file.oldPath}</span> → {file.path}
              </>
            ) : (
              file.path
            )}
          </span>
        </button>
        <span className={`diff-status ${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="diff-counts">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
        {comments.length > 0 && (
          <span className="diff-comment-count">{comments.length}</span>
        )}
        <button
          className="ghost tiny"
          onClick={() => onOpenFile(file.path)}
          title="Open file"
        >
          ↗
        </button>
      </div>

      {!collapsed &&
        (file.suppressed ? (
          // §7.1: a summary and a way out, not a frozen renderer.
          <div className="diff-suppressed">
            {file.suppressedReason === "binary"
              ? "Binary file — not shown."
              : "This file is too large to render here."}{" "}
            <button className="linkish" onClick={() => onOpenFile(file.path)}>
              Open it
            </button>
          </div>
        ) : (
          file.hunks.map((hunk) => (
            <Hunk
              key={hunk.hunkId}
              hunk={hunk}
              filePath={file.path}
              mode={mode}
              comments={comments.filter((c) => c.hunkId === hunk.hunkId)}
              onAddComment={onAddComment}
              onRemoveComment={onRemoveComment}
            />
          ))
        ))}

      {/* Comments whose anchor no longer resolves still belong to the file —
          dropping them would silently discard what the user wrote. */}
      {!collapsed &&
        comments
          .filter((c) => c.stale)
          .map((c) => (
            <CommentCard key={c.commentId} comment={c} onRemove={onRemoveComment} />
          ))}
    </div>
  );
}

type Selection = { side: DiffSideView; start: number; end: number };

function Hunk({
  hunk,
  filePath,
  mode,
  comments,
  onAddComment,
  onRemoveComment,
}: {
  hunk: DiffHunkView;
  filePath: string;
  mode: "unified" | "split";
  comments: CurrentReviewComment[];
  onAddComment: (draft: {
    filePath: string;
    side: DiffSideView;
    startLine: number;
    endLine: number;
    text: string;
  }) => void;
  onRemoveComment: (commentId: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState("");

  /** Click starts a range; shift-click extends it, per §7.3's multi-line anchors. */
  const pick = (side: DiffSideView, line: number, extend: boolean) => {
    setSelection((prev) =>
      extend && prev && prev.side === side
        ? { side, start: Math.min(prev.start, line), end: Math.max(prev.end, line) }
        : { side, start: line, end: line },
    );
  };

  const submit = () => {
    if (!selection || !draft.trim()) return;
    onAddComment({
      filePath,
      side: selection.side,
      startLine: selection.start,
      endLine: selection.end,
      text: draft.trim(),
    });
    setSelection(null);
    setDraft("");
  };

  const selected = (side: DiffSideView, line: number | null) =>
    line !== null &&
    selection?.side === side &&
    line >= selection.start &&
    line <= selection.end;

  return (
    <div className="diff-hunk">
      <div className="hunk-head">
        <span className="hunk-range">{hunk.header.split("@@")[1]?.trim()}</span>
        {hunk.context && <span className="hunk-context">{hunk.context}</span>}
      </div>

      <table className={`diff-table ${mode}`}>
        <tbody>
          {mode === "unified"
            ? hunk.lines.map((line, i) => (
                <UnifiedRow
                  key={i}
                  line={line}
                  selected={
                    selected("right", line.rightLine) ||
                    selected("left", line.leftLine)
                  }
                  onPick={pick}
                />
              ))
            : toSplitRows(hunk.lines).map((row, i) => (
                <SplitRow
                  key={i}
                  left={row.left}
                  right={row.right}
                  leftSelected={selected("left", row.left?.leftLine ?? null)}
                  rightSelected={selected("right", row.right?.rightLine ?? null)}
                  onPick={pick}
                />
              ))}
        </tbody>
      </table>

      {selection && (
        <div className="comment-editor">
          <div className="comment-editor-head">
            Commenting on{" "}
            {selection.start === selection.end
              ? `line ${selection.start}`
              : `lines ${selection.start}–${selection.end}`}
            {selection.side === "left" && " (before)"}
          </div>
          <textarea
            autoFocus
            rows={3}
            value={draft}
            placeholder="What should change here?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSelection(null);
                setDraft("");
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="comment-editor-actions">
            <button
              className="ghost"
              onClick={() => {
                setSelection(null);
                setDraft("");
              }}
            >
              Cancel
            </button>
            <button className="primary" disabled={!draft.trim()} onClick={submit}>
              Comment
            </button>
          </div>
        </div>
      )}

      {comments.map((c) => (
        <CommentCard key={c.commentId} comment={c} onRemove={onRemoveComment} />
      ))}
    </div>
  );
}

function UnifiedRow({
  line,
  selected,
  onPick,
}: {
  line: DiffLineView;
  selected: boolean;
  onPick: (side: DiffSideView, line: number, extend: boolean) => void;
}) {
  // A deleted line can only be commented on the left, an added line only on
  // the right; context resolves to the right, which is the current file.
  const side: DiffSideView = line.kind === "delete" ? "left" : "right";
  const number = side === "left" ? line.leftLine : line.rightLine;

  return (
    <tr className={`dl ${line.kind}${selected ? " selected" : ""}`}>
      <td
        className="gutter"
        onClick={(e) => number !== null && onPick("left", line.leftLine ?? 0, e.shiftKey)}
      >
        {line.leftLine ?? ""}
      </td>
      <td
        className="gutter"
        onClick={(e) =>
          line.rightLine !== null && onPick("right", line.rightLine, e.shiftKey)
        }
      >
        {line.rightLine ?? ""}
      </td>
      <td className="sign">
        {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}
      </td>
      <td className="code">
        <span
          onClick={(e) => number !== null && onPick(side, number, e.shiftKey)}
        >
          {line.text || " "}
        </span>
      </td>
    </tr>
  );
}

function SplitRow({
  left,
  right,
  leftSelected,
  rightSelected,
  onPick,
}: {
  left: DiffLineView | null;
  right: DiffLineView | null;
  leftSelected: boolean;
  rightSelected: boolean;
  onPick: (side: DiffSideView, line: number, extend: boolean) => void;
}) {
  return (
    <tr className="dl split-row">
      <td
        className={`gutter${leftSelected ? " selected" : ""}`}
        onClick={(e) =>
          left?.leftLine != null && onPick("left", left.leftLine, e.shiftKey)
        }
      >
        {left?.leftLine ?? ""}
      </td>
      <td
        className={`code ${left?.kind ?? "empty"}${leftSelected ? " selected" : ""}`}
        onClick={(e) =>
          left?.leftLine != null && onPick("left", left.leftLine, e.shiftKey)
        }
      >
        {left ? left.text || " " : ""}
      </td>
      <td
        className={`gutter${rightSelected ? " selected" : ""}`}
        onClick={(e) =>
          right?.rightLine != null && onPick("right", right.rightLine, e.shiftKey)
        }
      >
        {right?.rightLine ?? ""}
      </td>
      <td
        className={`code ${right?.kind ?? "empty"}${rightSelected ? " selected" : ""}`}
        onClick={(e) =>
          right?.rightLine != null && onPick("right", right.rightLine, e.shiftKey)
        }
      >
        {right ? right.text || " " : ""}
      </td>
    </tr>
  );
}

/**
 * Pair deletions with additions for the split view.
 *
 * Runs of deletes and adds are zipped so a modified line shows old on the left
 * and new on the right, which is the whole point of a split view. Context sits
 * on both sides; an unmatched delete or add leaves the other cell empty.
 */
export function toSplitRows(
  lines: DiffLineView[],
): { left: DiffLineView | null; right: DiffLineView | null }[] {
  const rows: { left: DiffLineView | null; right: DiffLineView | null }[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;

    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    if (line.kind === "meta") {
      i++;
      continue;
    }

    // Collect the run of deletes, then the run of adds that follows it.
    const dels: DiffLineView[] = [];
    while (lines[i]?.kind === "delete") dels.push(lines[i]!), i++;
    // A no-newline marker can sit between the two runs.
    while (lines[i]?.kind === "meta") i++;
    const adds: DiffLineView[] = [];
    while (lines[i]?.kind === "add") adds.push(lines[i]!), i++;

    const pairs = Math.max(dels.length, adds.length);
    for (let n = 0; n < pairs; n++) {
      rows.push({ left: dels[n] ?? null, right: adds[n] ?? null });
    }

    // Nothing matched: avoid spinning on an unexpected line kind.
    if (dels.length === 0 && adds.length === 0) i++;
  }

  return rows;
}

function CommentCard({
  comment,
  onRemove,
}: {
  comment: CurrentReviewComment;
  onRemove: (commentId: string) => void;
}) {
  return (
    <div className={`diff-comment${comment.stale ? " stale" : ""}`}>
      <div className="diff-comment-head">
        <span className="muted">
          {comment.startLine === comment.endLine
            ? `line ${comment.startLine}`
            : `lines ${comment.startLine}–${comment.endLine}`}
          {comment.side === "left" && " (before)"}
        </span>
        {comment.stale && (
          <span className="stale-badge" title="The diff changed under this comment">
            stale
          </span>
        )}
        <button
          className="ghost tiny"
          onClick={() => onRemove(comment.commentId)}
          aria-label="Remove comment"
        >
          ✕
        </button>
      </div>
      {comment.quotedLines.length > 0 && (
        <pre className="diff-comment-quote">{comment.quotedLines.join("\n")}</pre>
      )}
      <div className="diff-comment-text">{comment.commentText}</div>
    </div>
  );
}
