import { open, readdir, readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  classifyFilePresentation,
  detectLanguage,
  imageMediaTypeFor,
  isLikelyBinary,
} from "../../application/domains/files/FilePresentation";
import type { FileSystemPort } from "../../application/domains/files/ports";
import type { FileEntryView, FileReadView } from "../../contracts/views/files";

/**
 * Resolve symlinks, falling back to the nearest existing ancestor.
 *
 * A path that does not exist yet cannot be `realpath`'d, but its parent
 * usually can — and that is what matters, since the parent is what determines
 * whether the path lands inside a root. Falling back to the raw input instead
 * compares an unresolved `/tmp/...` against a resolved `/private/tmp/...` and
 * rejects every not-yet-created file.
 *
 * Synchronous on purpose: `allowed()` is called from every read and has to
 * stay a plain predicate. The cost is a stat per root per call, which is
 * nothing next to the read that follows.
 */
function realpathIfPossible(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    // `dirname("/") === "/"`, so stop rather than recurse forever.
    if (parent === p) return p;
    return path.join(realpathIfPossible(parent), path.basename(p));
  }
}

/**
 * Filesystem access behind a narrow interface (plan §12.4).
 *
 * For local workspaces `fs/readFile` and friends are equivalent to Node's own
 * `fs` and add a round-trip, so reads stay local. The interface exists so
 * swapping in `fs/*` later — when a thread targets a non-local environment —
 * is one implementation change rather than a refactor. Do not scatter `fs`
 * calls through the rest of the app.
 *
 * The *watch* side is different: §12.4 says to adopt `fs/watch` + `fs/changed`
 * early because it gives a change feed coherent with the agent's own view.
 * That lives in the client; this module is reads only.
 */
/** Never list these: they are noise, and huge. */
const SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".next",
  ".DS_Store",
]);

const MAX_TEXT_BYTES = 512 * 1024;

/**
 * Hard ceiling on what we will read into memory at all.
 *
 * Distinct from `MAX_TEXT_BYTES`: past the text limit we still read and show a
 * prefix, but past this we refuse to read, because the point of the size state
 * is to avoid loading the file. Images get the same ceiling — a data URL is
 * ~4/3 the bytes and goes through IPC.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** Map an `fs` errno onto the discriminant the viewer branches on. */
function errorReason(err: unknown): {
  cause: "notFound" | "permission" | "unknown";
  detail: string;
} {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const detail = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT") {
    return { cause: "notFound", detail };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { cause: "permission", detail };
  }
  return { cause: "unknown", detail };
}

export class LocalFileSystem implements FileSystemPort {
  /**
   * Every path is confined to the current roots. The renderer asks for paths
   * by name, so without this it could walk anywhere on disk through an IPC
   * call.
   *
   * Roots are resolved through a callback rather than snapshotted, because
   * worktrees appear *after* boot: a static list captured at startup silently
   * refused every read inside a worktree thread.
   */
  /**
   * @param getRoots the workspace roots, for reads of any kind.
   * @param getImageRoots extra directories that may be read *as images only*
   *   — where composers write pasted screenshots. See `readImage`.
   */
  constructor(
    private getRoots: () => string[],
    private getImageRoots: () => string[] = () => [],
  ) {}

  /**
   * Whether a path is inside a current root.
   *
   * Public because opening a file externally has to honour exactly the same
   * confinement as reading it — handing the renderer an unchecked
   * `shell.openPath` would let it launch anything on disk through an IPC call,
   * which is the boundary this class exists to hold.
   */
  isAllowed(target: string): boolean {
    return this.allowed(target);
  }

  /**
   * **Symlinks are resolved on both sides before comparing.**
   *
   * `path.resolve` only normalizes `..` and `.`; it does not follow links. So a
   * symlink *inside* the workspace pointing at `/etc/passwd` passed this check
   * and was then read — verified against the running app, which returned the
   * contents of the real file. Adding `openPath` on top of the same guard
   * would have escalated that from reading a file to launching one.
   *
   * The roots need resolving too: on macOS the workspace canonicalizes to
   * `/private/tmp/...` while the user's own path says `/tmp/...`, and a check
   * that resolved only one side rejected legitimate files.
   *
   * A path that does not exist yet resolves through its nearest existing
   * ancestor, so creating a new file inside the workspace is still allowed.
   */
  private allowed(target: string): boolean {
    const resolved = realpathIfPossible(path.resolve(target));
    return this.getRoots().some((root) => {
      const r = realpathIfPossible(path.resolve(root));
      return resolved === r || resolved.startsWith(r + path.sep);
    });
  }

  async readDirectory(dir: string): Promise<FileEntryView[]> {
    if (!this.allowed(dir)) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => !SKIP.has(e.name))
        .map((e) => ({
          name: e.name,
          path: path.join(dir, e.name),
          kind: e.isDirectory() ? ("directory" as const) : ("file" as const),
          presentation: null,
        }))
        .sort((a, b) => {
          // Directories first, then case-insensitive by name.
          if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        });
    } catch {
      return [];
    }
  }

  /**
   * Read a file into one of the viewer's typed outcomes.
   *
   * Order matters and is not arbitrary:
   *
   * 1. **Confinement**, before touching the disk at all.
   * 2. **`stat`**, so size and directory-ness are known before any read. The
   *    size states exist to avoid reading, so they have to precede the read.
   * 3. **A bounded byte sniff**, before trusting an extension. Known signatures
   *    establish renderable images and PDFs; NUL bytes catch extensionless or
   *    mislabeled binary content.
   * 4. **Extension hints**, interpreted as broad capabilities. They can route
   *    a document to an external app, but cannot make arbitrary bytes safe to
   *    render inline.
   */
  async readFile(file: string): Promise<FileReadView> {
    if (!this.allowed(file)) {
      return {
        kind: "error",
        cause: "outsideWorkspace",
        detail: "outside the workspace",
      };
    }
    try {
      const info = await stat(file);
      if (info.isDirectory()) {
        return {
          kind: "error",
          cause: "isDirectory",
          detail: "is a directory",
        };
      }

      const bytes = info.size;
      const prefix = await readPrefix(file);
      const presentation = classifyFilePresentation(file, bytes, prefix);

      if (presentation.mode === "external") {
        return { kind: "external", presentation };
      }

      if (presentation.mode === "image") {
        if (bytes > MAX_READ_BYTES) {
          return { kind: "tooLarge", size: bytes, limit: MAX_READ_BYTES };
        }
        const buf = await readFile(file);
        return {
          kind: "image",
          presentation,
          dataUrl: `data:${presentation.mediaType};base64,${buf.toString("base64")}`,
        };
      }

      if (bytes > MAX_READ_BYTES) {
        return { kind: "tooLarge", size: bytes, limit: MAX_READ_BYTES };
      }

      const buf = await readFile(file);
      const text = buf.subarray(0, MAX_TEXT_BYTES).toString("utf8");
      return {
        kind: "text",
        presentation: {
          ...presentation,
          language: detectLanguage(file, text),
        },
        text,
        ...(buf.length > MAX_TEXT_BYTES ? { truncatedAt: MAX_TEXT_BYTES } : {}),
      };
    } catch (err) {
      return { kind: "error", ...errorReason(err) };
    }
  }

  /**
   * Read an image referenced by a transcript item into a data URL.
   *
   * Separate from `readFile` because the paths differ in origin and in
   * confinement. A `localImage` input carries whatever path the *composer*
   * wrote it to, and both the app and app-server may write those outside the
   * workspace — into `userData/attachments` or the OS temp directory. So
   * a transcript image is normally *outside* every workspace root, and going
   * through `readFile` returned `outsideWorkspace` for every one of them,
   * which is why user messages showed `[localImage]` instead of a picture.
   *
   * Widening `allowed()` to cover those directories was the wrong fix: it
   * would let the renderer read *any* temp file as text through the file
   * viewer. Instead this path is narrow on both axes — it accepts the image
   * roots in addition to the workspace, and it only ever returns an image,
   * because a non-image extension is rejected before the read.
   */
  async readImage(file: string): Promise<string | null> {
    const mime = imageMediaTypeFor(file);
    if (!mime) return null;
    if (!this.allowed(file) && !this.inImageRoots(file)) return null;
    try {
      const info = await stat(file);
      if (info.isDirectory() || info.size > MAX_READ_BYTES) return null;
      const buf = await readFile(file);
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }

  private inImageRoots(target: string): boolean {
    const resolved = realpathIfPossible(path.resolve(target));
    return this.getImageRoots().some((root) => {
      const r = realpathIfPossible(path.resolve(root));
      return resolved.startsWith(r + path.sep);
    });
  }
}

/** A NUL byte in the first block is the usual heuristic, and good enough. */
export function isBinary(buf: Buffer): boolean {
  return isLikelyBinary(buf);
}

async function readPrefix(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
