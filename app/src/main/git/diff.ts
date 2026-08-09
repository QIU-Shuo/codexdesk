/**
 * Unified-diff parsing into a structured model (plan §7.1).
 *
 * The changes pane needs more than a blob of diff text: file status and
 * counts, hunks addressable by id, and per-line numbers on **both sides** so a
 * comment can anchor to the left or the right of a split view and cover a
 * multi-line range (§7.3).
 *
 * Parsing is deliberately tolerant. `git diff` output varies with config
 * (rename detection, binary markers, `\ No newline at end of file`), and a
 * parser that throws on an unfamiliar line would blank the pane for changes
 * the user needs to see. Unknown lines inside a hunk are kept as context; a
 * file we cannot parse still appears, marked so the UI can offer to open it
 * externally rather than pretend it has no changes.
 */

/** Which side of a split diff a line belongs to. */
export type DiffSide = "left" | "right";

export type DiffLineKind = "context" | "add" | "delete" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old file, null for added lines. */
  leftLine: number | null;
  /** 1-based line number in the new file, null for deleted lines. */
  rightLine: number | null;
};

export type DiffHunk = {
  /** Stable within a file: `<filePath>:<hunkIndex>`. Comments anchor to it. */
  hunkId: string;
  hunkIndex: number;
  /** The `@@ -a,b +c,d @@` header, verbatim. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Trailing text after the closing `@@`, e.g. the enclosing function. */
  context: string;
  lines: DiffLine[];
};

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "binary";

export type DiffFile = {
  /** Path as the user should see it — the new path for renames. */
  path: string;
  /** Set only for renames, so the UI can show `old → new`. */
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /**
   * True when there is no textual diff to render — binary content, or a file
   * large enough that we chose not to. §7.1: these get a summary and an
   * open-externally action rather than freezing the renderer.
   */
  suppressed: boolean;
  /** Why it was suppressed, for the summary line. */
  suppressedReason: "binary" | "too-large" | null;
};

export type ParsedDiff = {
  files: DiffFile[];
  additions: number;
  deletions: number;
};

/**
 * Above this many lines a single file's diff is summarized instead of
 * rendered. A very large generated-file diff is not useful review material
 * and must not make the UI unresponsive.
 */
const MAX_FILE_DIFF_LINES = 4000;

const EMPTY: ParsedDiff = { files: [], additions: 0, deletions: 0 };

export function parseUnifiedDiff(text: string): ParsedDiff {
  if (!text.trim()) return EMPTY;

  const files: DiffFile[] = [];
  const lines = text.split("\n");

  const isFileHeader = (n: number) =>
    (lines[n] ?? "").startsWith("diff --git ");

  let i = 0;
  while (i < lines.length) {
    if (!isFileHeader(i)) {
      i++;
      continue;
    }
    const start = i;
    i++;
    // Everything up to the next `diff --git` belongs to this file.
    while (i < lines.length && !isFileHeader(i)) i++;
    const file = parseFile(lines.slice(start, i));
    if (file) files.push(file);
  }

  return {
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/**
 * Paths in `diff --git a/x b/x` are prefixed; quoted when they need escaping.
 *
 * Git appends a **trailing tab** to the `---`/`+++` path when the path
 * contains whitespace (verified against real `git diff` output, not inferred).
 * Without stripping it, `"spaced name.txt\t"` becomes the file's identity and
 * every lookup keyed on path — comment anchors, the open-file action — misses.
 */
function stripPrefix(p: string): string {
  const detabbed = p.replace(/\t$/, "");
  const unquoted =
    detabbed.startsWith('"') && detabbed.endsWith('"')
      ? unquote(detabbed)
      : detabbed;
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }
  return unquoted;
}

/** Git C-quotes paths containing spaces, quotes, or non-ASCII bytes. */
function unquote(s: string): string {
  const body = s.slice(1, -1);
  return body.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return c;
    }
  });
}

function parseFile(block: string[]): DiffFile | null {
  const header = block[0] ?? "";
  // `diff --git a/<old> b/<new>`. Splitting on " b/" is wrong for paths that
  // contain it, so prefer the explicit ---/+++ lines below and treat this as
  // a fallback only.
  let path = "";
  let oldPath: string | null = null;
  let status: FileStatus = "modified";
  let suppressed = false;
  let suppressedReason: "binary" | "too-large" | null = null;

  let hunkStart = -1;
  for (let i = 1; i < block.length; i++) {
    const l = block[i] ?? "";
    if (l.startsWith("@@")) {
      hunkStart = i;
      break;
    }
    if (l.startsWith("new file mode")) status = "added";
    else if (l.startsWith("deleted file mode")) status = "deleted";
    else if (l.startsWith("rename from ")) {
      status = "renamed";
      oldPath = l.slice("rename from ".length);
    } else if (l.startsWith("rename to ")) {
      status = "renamed";
      path = l.slice("rename to ".length);
    } else if (l.startsWith("--- ")) {
      const p = l.slice(4);
      if (p !== "/dev/null") oldPath = oldPath ?? stripPrefix(p);
    } else if (l.startsWith("+++ ")) {
      const p = l.slice(4);
      if (p !== "/dev/null") path = stripPrefix(p);
    } else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) {
      status = "binary";
      suppressed = true;
      suppressedReason = "binary";
    }
  }

  if (!path) {
    // Deleted files have no `+++` path; fall back to the old one, then to the
    // `diff --git` header.
    path = oldPath ?? headerPath(header);
  }
  if (!path) return null;

  const hunkLines = hunkStart >= 0 ? block.slice(hunkStart) : [];
  if (hunkLines.length > MAX_FILE_DIFF_LINES) {
    suppressed = true;
    suppressedReason = suppressedReason ?? "too-large";
  }

  const hunks = suppressed ? [] : parseHunks(path, hunkLines);
  const counted = suppressed
    ? countRaw(hunkLines)
    : {
        additions: hunks.reduce(
          (n, h) => n + h.lines.filter((l) => l.kind === "add").length,
          0,
        ),
        deletions: hunks.reduce(
          (n, h) => n + h.lines.filter((l) => l.kind === "delete").length,
          0,
        ),
      };

  return {
    path,
    oldPath: status === "renamed" ? oldPath : null,
    status,
    additions: counted.additions,
    deletions: counted.deletions,
    hunks,
    suppressed,
    suppressedReason,
  };
}

/** Counts for a file we chose not to render, so totals stay honest. */
function countRaw(lines: string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) additions++;
    else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

function headerPath(header: string): string {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  return m?.[2] ?? "";
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunks(filePath: string, lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let leftNo = 0;
  let rightNo = 0;

  // `git diff` output ends with a newline, so splitting on "\n" leaves a
  // trailing empty entry. Treated as content it became a context line with
  // real line numbers — the UI rendered a clickable row `0 / 9` under an
  // eight-line file, for a line that does not exist. Only the *final* entry is
  // dropped: a genuine blank context line inside a hunk is " " before the
  // leading space is stripped, and matters.
  const body =
    lines.length > 0 && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines;

  for (const raw of body) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const index = hunks.length;
      current = {
        hunkId: `${filePath}:${index}`,
        hunkIndex: index,
        header: raw,
        oldStart,
        oldCount,
        newStart,
        newCount,
        context: (m[5] ?? "").trim(),
        lines: [],
      };
      hunks.push(current);
      leftNo = oldStart;
      rightNo = newStart;
      continue;
    }
    if (!current) continue;

    if (raw.startsWith("+")) {
      current.lines.push({
        kind: "add",
        text: raw.slice(1),
        leftLine: null,
        rightLine: rightNo++,
      });
    } else if (raw.startsWith("-")) {
      current.lines.push({
        kind: "delete",
        text: raw.slice(1),
        leftLine: leftNo++,
        rightLine: null,
      });
    } else if (raw.startsWith("\\")) {
      // `\ No newline at end of file` annotates the previous line; it is not
      // itself a line of either file.
      current.lines.push({
        kind: "meta",
        text: raw,
        leftLine: null,
        rightLine: null,
      });
    } else {
      // Context. A leading space is the norm, but an empty string appears for
      // blank context lines when trailing whitespace is stripped in transit.
      current.lines.push({
        kind: "context",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        leftLine: leftNo++,
        rightLine: rightNo++,
      });
    }
  }

  return hunks;
}

/**
 * Find the hunk a comment anchor still belongs to after the diff changed.
 *
 * §7.3 requires comments to be re-anchored or visibly invalidated when the
 * underlying diff moves. Matching on hunk index alone breaks as soon as an
 * earlier hunk appears; matching on the anchored line's *content* survives
 * most edits elsewhere in the file.
 */
export function findAnchor(
  diff: ParsedDiff,
  anchor: { path: string; side: DiffSide; startLine: number },
): DiffHunk | null {
  const file = diff.files.find((f) => f.path === anchor.path);
  if (!file) return null;
  const key = anchor.side === "left" ? "leftLine" : "rightLine";
  return (
    file.hunks.find((h) => h.lines.some((l) => l[key] === anchor.startLine)) ??
    null
  );
}

/** Lines covered by a comment range, for rendering the quoted excerpt. */
export function linesInRange(
  hunk: DiffHunk,
  side: DiffSide,
  startLine: number,
  endLine: number,
): DiffLine[] {
  const key = side === "left" ? "leftLine" : "rightLine";
  return hunk.lines.filter((l) => {
    const n = l[key];
    return n !== null && n >= startLine && n <= endLine;
  });
}
