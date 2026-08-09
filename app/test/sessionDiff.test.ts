import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { changedFiles, sessionDiff, DiffError } from "../src/main/git/sessionDiff";

const run = promisify(execFile);

/**
 * These run against **real repositories**, not a fake git.
 *
 * The whole risk in this module is how git actually behaves — which files
 * `diff` omits, what mutates the index, how untracked and binary files are
 * reported. A fake runner would only prove that the code calls the arguments
 * it was written to call. Every bug worth catching here lives in git.
 */

let repo: string;
let base: string;

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout;
}

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "codexdesk-sd-"));
  await git(["init", "-q", "."]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Test"]);
  await write("tracked.txt", "a\nb\nc\n");
  await write("keep.txt", "unchanged\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  base = (await git(["rev-parse", "HEAD"])).trim();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("sessionDiff", () => {
  it("includes untracked files, which plain `git diff` omits entirely", async () => {
    await write("brand-new.txt", "hello\n");
    const { parsed } = await sessionDiff(repo, base);

    const file = parsed.files.find((f) => f.path === "brand-new.txt");
    expect(file).toBeDefined();
    expect(file).toMatchObject({ status: "added", additions: 1 });
  });

  it("leaves the user's index untouched", async () => {
    // The invariant from §7.2: never disturb the user's staged state. The
    // obvious `git add -N .` approach passes every other test in this file
    // and violates exactly this one.
    await write("untracked.txt", "new\n");
    await write("tracked.txt", "a\nCHANGED\nc\n");
    const before = await git(["status", "--porcelain"]);

    await sessionDiff(repo, base);

    expect(await git(["status", "--porcelain"])).toBe(before);
    // Specifically: the untracked file must still be untracked, not staged.
    expect(await git(["status", "--porcelain"])).toContain("?? untracked.txt");
  });

  it("diffs against the given base, not against HEAD", async () => {
    // The base SHA is preserved so a later commit cannot change what the user
    // is approving (§7.1). After committing, `git diff HEAD` would be empty;
    // the session diff must still show the change.
    await write("tracked.txt", "a\nCHANGED\nc\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "work"]);

    const { parsed } = await sessionDiff(repo, base);
    expect(parsed.files.map((f) => f.path)).toContain("tracked.txt");
    expect(parsed.additions).toBeGreaterThan(0);
  });

  it("reports a deleted file", async () => {
    await rm(path.join(repo, "tracked.txt"));
    const { parsed } = await sessionDiff(repo, base);
    expect(parsed.files.find((f) => f.path === "tracked.txt")).toMatchObject({
      status: "deleted",
    });
  });

  it("omits files that did not change", async () => {
    await write("tracked.txt", "a\nCHANGED\nc\n");
    const { parsed } = await sessionDiff(repo, base);
    expect(parsed.files.map((f) => f.path)).not.toContain("keep.txt");
  });

  it("marks a binary file as suppressed rather than rendering it", async () => {
    await writeFile(
      path.join(repo, "blob.bin"),
      Buffer.from([0, 1, 2, 255, 0, 3]),
    );
    const { parsed } = await sessionDiff(repo, base);
    const file = parsed.files.find((f) => f.path === "blob.bin");
    expect(file).toMatchObject({ suppressed: true, suppressedReason: "binary" });
    expect(file?.hunks).toEqual([]);
  });

  it("handles a path containing a space end to end", async () => {
    // The trailing-tab bug the parser had: only real git output produces it.
    await write("a dir/spaced name.txt", "content\n");
    const { parsed } = await sessionDiff(repo, base);
    expect(parsed.files.map((f) => f.path)).toContain("a dir/spaced name.txt");
  });

  it("echoes the base sha it compared against", async () => {
    const result = await sessionDiff(repo, base);
    expect(result.baseSha).toBe(base);
    expect(result.scope).toBe("session");
  });

  it("returns an empty file list for a clean worktree", async () => {
    const { parsed } = await sessionDiff(repo, base);
    expect(parsed.files).toEqual([]);
    expect(parsed.additions).toBe(0);
  });

  it("throws a typed error for a bad base rather than pretending it is clean", async () => {
    // Silently reporting "no changes" for a broken base would tell the user
    // their work vanished.
    await expect(sessionDiff(repo, "0000000000000000000000000000000000000000"))
      .rejects.toBeInstanceOf(DiffError);
  });
});

describe("changedFiles", () => {
  it("lists tracked and untracked changes with counts", async () => {
    await write("tracked.txt", "a\nCHANGED\nc\nEXTRA\n");
    await write("added.txt", "one\ntwo\n");

    const files = await changedFiles(repo, base);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(Object.keys(byPath).sort()).toEqual(["added.txt", "tracked.txt"]);
    expect(byPath["added.txt"]).toMatchObject({ additions: 2, deletions: 0 });
  });

  it("reports zero counts for binary files instead of NaN", async () => {
    // numstat prints "-" for binary; Number("-") is NaN, which renders as
    // "NaN changes" in the pane.
    await writeFile(path.join(repo, "b.bin"), Buffer.from([0, 1, 2, 255]));
    const files = await changedFiles(repo, base);
    const bin = files.find((f) => f.path === "b.bin");
    expect(bin).toMatchObject({ additions: 0, deletions: 0 });
    expect(Number.isNaN(bin?.additions)).toBe(false);
  });

  it("leaves the index untouched", async () => {
    await write("untracked.txt", "x\n");
    const before = await git(["status", "--porcelain"]);
    await changedFiles(repo, base);
    expect(await git(["status", "--porcelain"])).toBe(before);
  });

  it("returns an empty list rather than throwing on a bad base", async () => {
    // Called on every watcher tick, so it degrades quietly.
    expect(await changedFiles(repo, "deadbeef")).toEqual([]);
  });
});
