import { describe, expect, it } from "vitest";
import {
  findAnchor,
  linesInRange,
  parseUnifiedDiff,
} from "../src/main/git/diff";

/**
 * The diff parser is the substrate for the changes pane, comments, and the
 * commit flow (§7.1). Its non-obvious job is per-line numbering on *both*
 * sides — that is what lets a comment anchor to the left or right of a split
 * view — so most of these tests are about line numbers rather than text.
 */

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ export function main() {
 const a = 1;
 const b = 2;
-const c = 3;
+const c = 4;
+const d = 5;
 return a + b;
 }`;

describe("parseUnifiedDiff", () => {
  it("numbers lines on both sides independently", () => {
    const { files } = parseUnifiedDiff(MODIFIED);
    const hunk = files[0].hunks[0];

    // Context before the change: same number on both sides.
    expect(hunk.lines[0]).toMatchObject({
      kind: "context",
      leftLine: 10,
      rightLine: 10,
    });
    // The deleted line exists only on the left.
    const deleted = hunk.lines.find((l) => l.kind === "delete")!;
    expect(deleted).toMatchObject({ leftLine: 12, rightLine: null });
    // Added lines exist only on the right, and are consecutive there.
    const added = hunk.lines.filter((l) => l.kind === "add");
    expect(added.map((l) => l.rightLine)).toEqual([12, 13]);
    expect(added.every((l) => l.leftLine === null)).toBe(true);
    // Context after the change: the sides have diverged by one.
    const trailing = hunk.lines.filter((l) => l.kind === "context").at(-1)!;
    expect(trailing.leftLine).toBe(14);
    expect(trailing.rightLine).toBe(15);
  });

  it("counts additions and deletions per file and in total", () => {
    const diff = parseUnifiedDiff(MODIFIED);
    expect(diff.files[0]).toMatchObject({
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(diff).toMatchObject({ additions: 2, deletions: 1 });
  });

  it("captures the hunk header, range, and enclosing context", () => {
    const hunk = parseUnifiedDiff(MODIFIED).files[0].hunks[0];
    expect(hunk).toMatchObject({
      hunkId: "src/app.ts:0",
      hunkIndex: 0,
      oldStart: 10,
      oldCount: 7,
      newStart: 10,
      newCount: 8,
      context: "export function main() {",
    });
  });

  it("reads a hunk header with omitted counts as a single line", () => {
    const single = `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
+new`;
    const hunk = parseUnifiedDiff(single).files[0].hunks[0];
    expect(hunk).toMatchObject({ oldCount: 1, newCount: 1 });
  });

  it("marks an added file and takes its path from the +++ side", () => {
    const added = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two`;
    expect(parseUnifiedDiff(added).files[0]).toMatchObject({
      path: "new.ts",
      status: "added",
      additions: 2,
      deletions: 0,
    });
  });

  it("marks a deleted file and still knows its path with no +++ side", () => {
    const deleted = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index e69de29..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two`;
    expect(parseUnifiedDiff(deleted).files[0]).toMatchObject({
      path: "gone.ts",
      status: "deleted",
      additions: 0,
      deletions: 2,
    });
  });

  it("keeps both paths for a rename so the UI can show old to new", () => {
    const renamed = `diff --git a/old/name.ts b/new/name.ts
similarity index 95%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,3 +1,3 @@
 keep
-was
+now
 keep`;
    expect(parseUnifiedDiff(renamed).files[0]).toMatchObject({
      path: "new/name.ts",
      oldPath: "old/name.ts",
      status: "renamed",
    });
  });

  it("suppresses a binary file rather than trying to render it", () => {
    const binary = `diff --git a/logo.png b/logo.png
index 1234567..89abcde 100644
Binary files a/logo.png and b/logo.png differ`;
    expect(parseUnifiedDiff(binary).files[0]).toMatchObject({
      path: "logo.png",
      status: "binary",
      suppressed: true,
      suppressedReason: "binary",
      hunks: [],
    });
  });

  it("suppresses an enormous file but keeps its counts honest", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const huge = `diff --git a/big.txt b/big.txt
--- a/big.txt
+++ b/big.txt
@@ -0,0 +1,5000 @@
${body}`;
    const file = parseUnifiedDiff(huge).files[0];
    expect(file.suppressed).toBe(true);
    expect(file.suppressedReason).toBe("too-large");
    expect(file.hunks).toEqual([]);
    // The pane still shows "+5000" even though it will not render them.
    expect(file.additions).toBe(5000);
  });

  it("treats a no-newline marker as metadata, not a line of either file", () => {
    const noNewline = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file`;
    const hunk = parseUnifiedDiff(noNewline).files[0].hunks[0];
    const meta = hunk.lines.filter((l) => l.kind === "meta");
    expect(meta).toHaveLength(2);
    expect(meta.every((l) => l.leftLine === null && l.rightLine === null)).toBe(
      true,
    );
    // The marker must not consume a line number: the added line is still 2.
    expect(hunk.lines.find((l) => l.kind === "add")?.rightLine).toBe(2);
  });

  it("separates multiple files and multiple hunks", () => {
    const multi = `${MODIFIED}
@@ -40,3 +41,3 @@ function other() {
 x
-y
+z
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-title
+Title`;
    const diff = parseUnifiedDiff(multi);
    expect(diff.files.map((f) => f.path)).toEqual(["src/app.ts", "README.md"]);
    expect(diff.files[0].hunks).toHaveLength(2);
    // Hunk ids stay unique within the file, which is what comments anchor to.
    expect(diff.files[0].hunks.map((h) => h.hunkId)).toEqual([
      "src/app.ts:0",
      "src/app.ts:1",
    ]);
  });

  it("unquotes a path git escaped because it contains a space", () => {
    const spaced = `diff --git "a/my dir/file.ts" "b/my dir/file.ts"
--- "a/my dir/file.ts"
+++ "b/my dir/file.ts"
@@ -1 +1 @@
-a
+b`;
    expect(parseUnifiedDiff(spaced).files[0].path).toBe("my dir/file.ts");
  });

  it("strips the trailing tab git adds to paths containing whitespace", () => {
    // Found by parsing real `git diff` output rather than a hand-written
    // fixture: git does not quote `spaced name.txt`, it appends a tab to the
    // ---/+++ lines. Keeping the tab made the path "spaced name.txt\t", which
    // silently breaks every lookup keyed on it.
    const withTab =
      "diff --git a/spaced name.txt b/spaced name.txt\n" +
      "index 587be6b..975fbec 100644\n" +
      "--- a/spaced name.txt\t\n" +
      "+++ b/spaced name.txt\t\n" +
      "@@ -1 +1 @@\n" +
      "-x\n" +
      "+y";
    expect(parseUnifiedDiff(withTab).files[0].path).toBe("spaced name.txt");
  });

  it("does not invent a trailing line from git's final newline", () => {
    // `git diff` output ends with a newline, so split("\n") leaves an empty
    // entry. Treated as content it became a context line with real numbers —
    // the UI showed a clickable row `0 / 9` under an eight-line file.
    const withTrailingNewline =
      "diff --git a/new.txt b/new.txt\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/new.txt\n" +
      "@@ -0,0 +1,2 @@\n" +
      "+one\n" +
      "+two\n";
    const hunk = parseUnifiedDiff(withTrailingNewline).files[0].hunks[0];
    expect(hunk.lines).toHaveLength(2);
    expect(hunk.lines.every((l) => l.kind === "add")).toBe(true);
    // Specifically: no line numbered 0, which cannot exist.
    expect(hunk.lines.some((l) => l.leftLine === 0 || l.rightLine === 0)).toBe(
      false,
    );
  });

  it("keeps a genuine blank context line inside a hunk", () => {
    // The fix drops only the *final* empty entry; a real blank line is " "
    // before its leading space is stripped, and carries line numbers.
    const withBlank =
      "diff --git a/a.txt b/a.txt\n" +
      "--- a/a.txt\n" +
      "+++ b/a.txt\n" +
      "@@ -1,3 +1,3 @@\n" +
      " first\n" +
      " \n" +
      "-old\n" +
      "+new\n";
    const hunk = parseUnifiedDiff(withBlank).files[0].hunks[0];
    const blank = hunk.lines.find((l) => l.kind === "context" && l.text === "");
    expect(blank).toBeDefined();
    expect(blank?.rightLine).toBe(2);
  });

  it("returns nothing for empty or whitespace input", () => {
    expect(parseUnifiedDiff("")).toMatchObject({ files: [] });
    expect(parseUnifiedDiff("   \n  ")).toMatchObject({ files: [] });
  });
});

describe("comment anchoring", () => {
  it("finds the hunk holding a line on the requested side", () => {
    const diff = parseUnifiedDiff(MODIFIED);
    // Line 12 on the right is an added line; on the left it is the deleted one.
    expect(
      findAnchor(diff, { path: "src/app.ts", side: "right", startLine: 12 })
        ?.hunkId,
    ).toBe("src/app.ts:0");
    expect(
      findAnchor(diff, { path: "src/app.ts", side: "left", startLine: 12 })
        ?.hunkId,
    ).toBe("src/app.ts:0");
  });

  it("reports no anchor when the file is gone from the diff", () => {
    const diff = parseUnifiedDiff(MODIFIED);
    expect(
      findAnchor(diff, { path: "deleted.ts", side: "right", startLine: 1 }),
    ).toBeNull();
  });

  it("reports no anchor when the line no longer exists on that side", () => {
    const diff = parseUnifiedDiff(MODIFIED);
    // 999 is past the end of the hunk.
    expect(
      findAnchor(diff, { path: "src/app.ts", side: "right", startLine: 999 }),
    ).toBeNull();
  });

  it("collects a multi-line range from one side only", () => {
    const hunk = parseUnifiedDiff(MODIFIED).files[0].hunks[0];
    const range = linesInRange(hunk, "right", 12, 13);
    // Both added lines, and not the deleted one that shares the left numbering.
    expect(range.map((l) => l.text)).toEqual(["const c = 4;", "const d = 5;"]);
    expect(range.every((l) => l.kind === "add")).toBe(true);
  });
});
