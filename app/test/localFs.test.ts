import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalFileSystem, isBinary } from "../src/main/fs/localFs";
import { extensionOf } from "../src/application/domains/files/FilePresentation";

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "codexdesk-fs-"));
  writeFileSync(path.join(dir, "hello.ts"), "export const x = 1;\n");
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, ".git"));
  writeFileSync(path.join(dir, ".git", "config"), "secret");
  return dir;
}

describe("LocalFileSystem", () => {
  it("confines reads to the current roots", async () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(await fs.readDirectory("/etc")).toEqual([]);
    const outside = await fs.readFile("/etc/hosts");
    expect(outside).toMatchObject({ kind: "error" });
  });

  it("re-reads roots on every call, so worktrees created later work", async () => {
    // A static list captured at boot silently refused every read inside a
    // worktree, because worktrees appear after startup.
    const dir = scratch();
    let roots: string[] = [];
    const fs = new LocalFileSystem(() => roots);
    expect(await fs.readDirectory(dir)).toEqual([]);
    roots = [dir];
    expect((await fs.readDirectory(dir)).length).toBeGreaterThan(0);
  });

  it("hides .git and lists directories first", async () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    const entries = await fs.readDirectory(dir);
    expect(entries.map((e) => e.name)).toEqual(["src", "hello.ts"]);
  });

  it("reads text and reports binaries rather than dumping them", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    const fs = new LocalFileSystem(() => [dir]);
    expect(await fs.readFile(path.join(dir, "hello.ts"))).toMatchObject({
      kind: "text",
      text: "export const x = 1;\n",
    });
    expect(await fs.readFile(path.join(dir, "bin.dat"))).toMatchObject({
      kind: "external",
      presentation: { mode: "external", family: "unknown" },
    });
  });

  it("rejects a path that escapes the root by traversal", async () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    const escaped = path.join(dir, "..", "..", "etc", "hosts");
    expect(await fs.readFile(escaped)).toMatchObject({ kind: "error" });
  });
});

describe("isAllowed — the guard behind open-in-editor", () => {
  // `shell.openPath` launches whatever it is given, so it has to honour the
  // same confinement as reads. Without this, "Open" would be an IPC call that
  // launches any file on the machine.
  it("allows a file inside a root", () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(path.join(dir, "hello.ts"))).toBe(true);
  });

  it("allows the root itself", () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(dir)).toBe(true);
  });

  it("refuses a path outside every root", () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed("/etc/hosts")).toBe(false);
  });

  it("refuses a path that escapes by traversal", () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(path.join(dir, "..", "..", "etc", "hosts"))).toBe(
      false,
    );
  });

  it("refuses a sibling whose name merely starts with the root", () => {
    // `/tmp/root-evil` must not pass a `startsWith("/tmp/root")` check.
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(`${dir}-evil/secrets.txt`)).toBe(false);
  });

  it("sees roots added after construction", () => {
    const a = scratch();
    const b = scratch();
    let roots = [a];
    const fs = new LocalFileSystem(() => roots);
    expect(fs.isAllowed(path.join(b, "hello.ts"))).toBe(false);
    roots = [a, b];
    expect(fs.isAllowed(path.join(b, "hello.ts"))).toBe(true);
  });
});

describe("symlink confinement", () => {
  // Found by driving the running app: `path.resolve` normalizes `..` and `.`
  // but does NOT follow symlinks, so a link *inside* the workspace pointing at
  // /etc/passwd passed the guard and its contents were returned. Adding
  // `openPath` on the same guard would have escalated that from reading a file
  // to launching one.
  it("refuses a symlink inside the root that points outside it", async () => {
    const dir = scratch();
    symlinkSync("/etc/passwd", path.join(dir, "escape.txt"));
    const fs = new LocalFileSystem(() => [dir]);

    expect(fs.isAllowed(path.join(dir, "escape.txt"))).toBe(false);
    expect(await fs.readFile(path.join(dir, "escape.txt"))).toMatchObject({
      kind: "error",
    });
  });

  it("allows a symlink that stays inside the root", () => {
    const dir = scratch();
    symlinkSync(path.join(dir, "hello.ts"), path.join(dir, "alias.ts"));
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(path.join(dir, "alias.ts"))).toBe(true);
  });

  it("accepts a root reached through a symlinked parent", () => {
    // macOS canonicalizes the workspace to /private/tmp/... while the user's
    // own path says /tmp/... . Resolving only one side rejected real files.
    const dir = scratch();
    const viaSymlink = dir.startsWith("/private/")
      ? dir.replace("/private", "")
      : dir;
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(path.join(viaSymlink, "hello.ts"))).toBe(true);
  });

  it("still allows a path that does not exist yet", () => {
    // Unresolvable paths fall back to lexical comparison; the read then fails
    // on its own terms rather than being reported as a confinement error.
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(fs.isAllowed(path.join(dir, "not-created-yet.ts"))).toBe(true);
  });
});

describe("isBinary", () => {
  it("uses a NUL byte in the first block", () => {
    expect(isBinary(Buffer.from("plain text"))).toBe(false);
    expect(isBinary(Buffer.from([65, 0, 66]))).toBe(true);
  });
});

/**
 * Typed file states for renderer-safe file capabilities.
 *
 * The old three-outcome shape — text / binary / error — let the renderer say
 * "binary file" and nothing else. These cover the classifications the viewer
 * now branches on, and acceptance cases 3, 4 and 5 of that note.
 */
describe("readFile typed states", () => {
  it("maps external formats into broad capability families", async () => {
    const dir = scratch();
    // Deliberately valid UTF-8: extension classification must win, or a .docx
    // that happens to start with text bytes renders as garbage.
    writeFileSync(path.join(dir, "report.docx"), "not really a docx");
    writeFileSync(path.join(dir, "bundle.zip"), "not really a zip");
    const fs = new LocalFileSystem(() => [dir]);

    expect(await fs.readFile(path.join(dir, "report.docx"))).toMatchObject({
      kind: "external",
      presentation: { mode: "external", family: "document" },
    });
    expect(await fs.readFile(path.join(dir, "bundle.zip"))).toMatchObject({
      kind: "external",
      presentation: { mode: "external", family: "archive" },
    });
  });

  it("renders an image inline instead of a binary dead end", async () => {
    const dir = scratch();
    // A one-pixel PNG: real enough to carry NUL bytes, so this would have hit
    // the binary path before.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(path.join(dir, "shot.png"), png);
    const fs = new LocalFileSystem(() => [dir]);

    const out = await fs.readFile(path.join(dir, "shot.png"));
    expect(out.kind).toBe("image");
    if (out.kind !== "image") throw new Error("unreachable");
    expect(out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.presentation.size).toBe(png.length);
  });

  it("uses a byte signature when an image extension is missing", async () => {
    const dir = scratch();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(path.join(dir, "renamed.bin"), png);
    const fs = new LocalFileSystem(() => [dir]);

    expect(await fs.readFile(path.join(dir, "renamed.bin"))).toMatchObject({
      kind: "image",
      presentation: { mode: "image", mediaType: "image/png" },
    });
  });

  it("does not render bytes as an image based on extension alone", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "not-an-image.png"), "plain text");
    const fs = new LocalFileSystem(() => [dir]);

    expect(await fs.readFile(path.join(dir, "not-an-image.png"))).toMatchObject({
      kind: "external",
      presentation: { mode: "external", family: "unknown" },
    });
  });

  it("names both numbers in the too-large state", async () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    // 9 MB clears the 8 MB read ceiling.
    writeFileSync(
      path.join(dir, "huge.bin"),
      Buffer.alloc(9 * 1024 * 1024, 65),
    );

    const out = await fs.readFile(path.join(dir, "huge.bin"));
    expect(out.kind).toBe("tooLarge");
    if (out.kind !== "tooLarge") throw new Error("unreachable");
    // The point of the state is that the user can compare the two.
    expect(out.size).toBe(9 * 1024 * 1024);
    expect(out.limit).toBe(8 * 1024 * 1024);
  });

  it("keeps the truncation marker out of the text", async () => {
    // A sentinel inside `text` is picked up by Copy, by find, and by anything
    // that later annotates a line — it is presentation living inside data.
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    writeFileSync(path.join(dir, "long.txt"), "a".repeat(600 * 1024));

    const out = await fs.readFile(path.join(dir, "long.txt"));
    expect(out.kind).toBe("text");
    if (out.kind !== "text") throw new Error("unreachable");
    expect(out.truncatedAt).toBe(512 * 1024);
    expect(out.text.length).toBe(512 * 1024);
    expect(out.text).not.toContain("truncated");
    // The whole size, not the size of what we return: the viewer needs both.
    expect(out.presentation.size).toBe(600 * 1024);
  });

  it("distinguishes a deleted file from a permission failure", async () => {
    // The tree refreshes on `fs/changed` rather than a local watcher, so a
    // file vanishing between read and open is the likely error — and it is the
    // recoverable one, which is why the viewer branches on this.
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    expect(await fs.readFile(path.join(dir, "gone.ts"))).toMatchObject({
      kind: "error",
      cause: "notFound",
    });
    expect(await fs.readFile("/etc/hosts")).toMatchObject({
      kind: "error",
      cause: "outsideWorkspace",
    });
    expect(await fs.readFile(path.join(dir, "src"))).toMatchObject({
      kind: "error",
      cause: "isDirectory",
    });
  });

  it("detects language from extension, filename, and shebang", async () => {
    const dir = scratch();
    const fs = new LocalFileSystem(() => [dir]);
    writeFileSync(path.join(dir, "Makefile"), "all:\n\techo hi\n");
    // No extension: only the shebang identifies this.
    writeFileSync(path.join(dir, "deploy"), "#!/usr/bin/env python3\nx = 1\n");

    expect(await fs.readFile(path.join(dir, "hello.ts"))).toMatchObject({
      presentation: { language: "typescript" },
    });
    expect(await fs.readFile(path.join(dir, "Makefile"))).toMatchObject({
      presentation: { language: "make" },
    });
    expect(await fs.readFile(path.join(dir, "deploy"))).toMatchObject({
      presentation: { language: "python" },
    });
  });
});

/**
 * Classification is application policy and must remain platform neutral.
 */
describe("file presentation classification", () => {
  it("imports nothing from node:", () => {
    const source = readFileSync(
      "src/application/domains/files/FilePresentation.ts",
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s+.*from\s+["']node:/m);
    expect(source).not.toMatch(/^\s*(const|let|var)\s+.*require\(["']node:/m);
  });

  it("reads transcript images from outside the workspace, images only", async () => {
    const dir = scratch();
    const attachments = mkdtempSync(path.join(tmpdir(), "codexdesk-attach-"));
    // No real PNG needed: readImage never decodes, it base64s the bytes.
    writeFileSync(path.join(attachments, "shot.png"), Buffer.from([1, 2, 3]));
    writeFileSync(path.join(attachments, "notes.txt"), "secret");
    const fs = new LocalFileSystem(
      () => [dir],
      () => [attachments],
    );

    expect(await fs.readImage(path.join(attachments, "shot.png"))).toBe(
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    );

    // The wider root buys image reads only — not a second text-read path.
    expect(await fs.readImage(path.join(attachments, "notes.txt"))).toBeNull();
    // And the ordinary read path still refuses the same file.
    expect(await fs.readFile(path.join(attachments, "shot.png"))).toMatchObject(
      { kind: "error", cause: "outsideWorkspace" },
    );
  });

  it("refuses images outside both the workspace and the image roots", async () => {
    const dir = scratch();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "codexdesk-other-"));
    writeFileSync(path.join(elsewhere, "shot.png"), Buffer.from([1]));
    const fs = new LocalFileSystem(
      () => [dir],
      () => [],
    );
    expect(await fs.readImage(path.join(elsewhere, "shot.png"))).toBeNull();
    expect(await fs.readImage("/etc/hosts")).toBeNull();
  });

  it("reads workspace images without any image root configured", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "logo.png"), Buffer.from([9]));
    const fs = new LocalFileSystem(() => [dir]);
    expect(await fs.readImage(path.join(dir, "logo.png"))).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("extracts extensions the way path.extname does", () => {
    // The cases that differ if you reach for `split(".").pop()` instead.
    expect(extensionOf("/a/b/c.TS")).toBe("ts");
    expect(extensionOf("/a/b/.gitignore")).toBe(""); // leading dot is not one
    expect(extensionOf("/a/b/Makefile")).toBe("");
    expect(extensionOf("/a/b.c/Makefile")).toBe(""); // dot in a directory name
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("")).toBe("");
  });
});
