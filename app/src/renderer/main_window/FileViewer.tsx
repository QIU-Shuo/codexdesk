import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ExternalFileFamily } from "../../contracts/views/files";
import {
  presentFileRead,
  type CurrentFileContents,
  presentFileEntries,
  type CurrentFileEntry,
} from "../compatibility/filePresentation";
import { ensureLanguage, highlightLine, type Appearance } from "./highlight";
import { readProductStorage } from "./productStorage";

/**
 * A read-only file surface with line anchors, highlighting, wrap, and find.
 *
 * What it is not: a text editor. It is a *reading* surface, which is why the
 * gutter is built here rather than delegated to an editor. These reading
 * affordances do not need an editor's mutation model.
 *
 * **Line anchors are the load-bearing part.** Every `<div class="fv-line">`
 * carries `data-line`, and that is what makes `file:line` deep links, find's
 * scroll-to-match, and any later range→composer selection possible (§3.4).
 * Highlighting is per line for the same reason: a shiki `<pre>` for the whole
 * file would have to be parsed back apart to recover the anchors.
 *
 * Review notes belong to diff anchors, not the ordinary file-reading surface.
 */

/** Wrap is a user preference, not a per-file one — §3.1 item 3. */
const WRAP_KEY = "codexdesk.fileviewer.wrap";

function resolvedAppearance(): Appearance {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Keep Shiki's palette in sync with the concrete theme on `<html>`. */
function useResolvedAppearance(): Appearance {
  const [appearance, setAppearance] = useState<Appearance>(resolvedAppearance);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setAppearance(resolvedAppearance()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return appearance;
}

function loadWrapPreference(): boolean {
  try {
    return readProductStorage(WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

function saveWrapPreference(on: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    // A viewer that throws because storage is unavailable is worse than one
    // that forgets the preference.
  }
}

/** `840 KB`, `1.2 MB` — the size states name real numbers, so format them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Broad families tell the user whether opening a file elsewhere is worthwhile
 * without coupling the viewer to format-specific internal identifiers.
 */
const EXTERNAL_LABEL: Record<ExternalFileFamily, string> = {
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  archive: "Archive",
  audio: "Audio",
  video: "Video",
  pdf: "PDF",
  unknown: "File",
};

export function FileViewer({
  path: filePath,
  root,
  changeToken,
  onClose,
  onOpenPath,
  revealLine,
  onRevealed,
}: {
  path: string;
  /** Workspace root, so the breadcrumb can show a relative path. */
  root?: string;
  changeToken: number;
  /**
   * Optional now that the workbench panel owns the tab strip and its close
   * buttons. The viewer still needs it for the "back to the file tree"
   * recovery on a deleted file, and standalone use keeps working.
   */
  onClose?: () => void;
  /** Navigate the viewer to another path — breadcrumb directory listing. */
  onOpenPath?: (path: string) => void;
  /** 1-based line to scroll to and highlight once, from a `path:line` link. */
  revealLine?: number;
  /** Called after `revealLine` has been honoured, so it fires only once. */
  onRevealed?: () => void;
}) {
  const [contents, setContents] = useState<CurrentFileContents | null>(null);
  const [wrap, setWrap] = useState(loadWrapPreference);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const appearance = useResolvedAppearance();

  useEffect(() => {
    let cancelled = false;
    // Clear first: without this the previous file's text stays on screen
    // while the next one loads, which reads as "this file has that content".
    setContents(null);
    void window.codexDesk.readFile(filePath).then((file) => {
      if (!cancelled) setContents(presentFileRead(file));
    });
    return () => {
      cancelled = true;
    };
    // Re-read when the file changes on disk, so the viewer is never stale.
  }, [filePath, changeToken]);

  // The find bar is per-file: a query from the last file is noise in this one.
  useEffect(() => {
    setFindOpen(false);
  }, [filePath]);

  const toggleWrap = useCallback(() => {
    setWrap((prev) => {
      saveWrapPreference(!prev);
      return !prev;
    });
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<string | null>, ok: string) => {
      const problem = await action();
      setNotice(problem ?? ok);
    },
    [],
  );

  // Clear a notice after a few seconds; a stuck "Copied" is a lie by the time
  // the user looks back at it.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const isText = contents?.kind === "text";
  const textMeta =
    contents?.kind === "text"
      ? {
          lines: contents.text.split("\n").length,
          language: languageStatus(contents.language, filePath),
          lineEnding: contents.text.includes("\r\n") ? "CRLF" : "LF",
        }
      : null;

  useEffect(() => {
    if (!isText) return;
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "f") {
        ev.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isText]);

  return (
    <div className="fileviewer">
      <div className="fileviewer-head">
        <Breadcrumb path={filePath} root={root} onOpenPath={onOpenPath} />
        {textMeta && (
          <span className="fileviewer-meta">{textMeta.lines} lines</span>
        )}
        <span className="spacer" />
        {isText && (
          <button
            className="linkish"
            title="Find in file (⌘F)"
            onClick={() => setFindOpen((v) => !v)}
          >
            Find
          </button>
        )}
        {/*
          The way out. A too-large or unsupported file used to be a dead end —
          the viewer said "… truncated" and offered nothing. `openPath` uses
          the user's own file association, so this needs no editor setting.
        */}
        <button
          className="linkish"
          title="Open in the default application"
          onClick={() => void window.codexDesk.openPath(filePath)}
        >
          Open
        </button>
        <ViewerMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          wrap={wrap}
          canCopyContents={isText}
          onToggleWrap={toggleWrap}
          onCopyPath={() =>
            void runAction(async () => {
              await navigator.clipboard.writeText(filePath);
              return null;
            }, "Path copied")
          }
          onCopyContents={() =>
            void runAction(
              () => window.codexDesk.copyFileContents(filePath),
              "Contents copied",
            )
          }
        />
        {/*
          Only when nothing else owns closing. Inside a workbench panel the tab
          strip has a close button per tab, and a second one here would be two
          controls for one action.
        */}
        {onClose && (
          <button className="linkish" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {notice && <div className="fv-notice muted">{notice}</div>}

      <div className="fileviewer-body">
        {!contents && <div className="muted">Loading file…</div>}

        {contents?.kind === "text" && (
          <TextContents
            key={filePath}
            text={contents.text}
            language={contents.language}
            appearance={appearance}
            wrap={wrap}
            findOpen={findOpen}
            onCloseFind={() => setFindOpen(false)}
            revealLine={revealLine}
            onRevealed={onRevealed}
          />
        )}

        {contents?.kind === "text" && contents.truncated && (
          <div className="fv-state muted">
            Showing the first {formatBytes(contents.truncated.limit)} of{" "}
            {formatBytes(contents.bytes)}.{" "}
            <button
              className="linkish"
              onClick={() => void window.codexDesk.openPath(filePath)}
            >
              Open the whole file
            </button>
          </div>
        )}

        {contents?.kind === "image" && (
          <div className="fv-image">
            <img src={contents.dataUrl} alt={filePath.split("/").pop() ?? ""} />
            <div className="muted">{formatBytes(contents.bytes)}</div>
          </div>
        )}

        {contents?.kind === "tooLarge" && (
          <div className="fv-state">
            <strong>File is too large to preview</strong>
            <div className="muted">
              {formatBytes(contents.bytes)} exceeds the{" "}
              {formatBytes(contents.limit)} preview limit
            </div>
            <button
              className="linkish"
              onClick={() => void window.codexDesk.openPath(filePath)}
            >
              Open this file in another app to view it
            </button>
          </div>
        )}

        {contents?.kind === "external" && (
          <div className="fv-state">
            <strong>
              {EXTERNAL_LABEL[contents.family]} previews aren&rsquo;t supported
              yet
            </strong>
            <div className="muted">{formatBytes(contents.bytes)}</div>
            <button
              className="linkish"
              onClick={() => void window.codexDesk.openPath(filePath)}
            >
              Open this file in another app to view it
            </button>
          </div>
        )}

        {contents?.kind === "error" && (
          <div className="fv-state">
            <strong className="error">Unable to load file</strong>
            <div className="muted">
              {contents.reason === "notFound"
                ? "This file no longer exists. It may have been deleted or renamed since the tree was read."
                : contents.reason === "permission"
                  ? "Permission denied."
                  : contents.message}
            </div>
            {/*
              The tree is refreshed by `fs/changed` rather than a local
              watcher, so a file vanishing between read and open is the likely
              error — and it is the recoverable one. Permission denied is not,
              so it gets no retry.
            */}
            {contents.reason === "notFound" && onClose && (
              <button className="linkish" onClick={onClose}>
                Back to the file tree
              </button>
            )}
          </div>
        )}
      </div>
      {textMeta && (
        <div className="fv-status" aria-label="File information">
          <span>{textMeta.language}</span>
          <span>UTF-8</span>
          <span>{textMeta.lineEnding}</span>
        </div>
      )}
    </div>
  );
}

function languageStatus(language: string, filePath: string): string {
  const known: Record<string, string> = {
    javascript: "JS",
    jsx: "JSX",
    typescript: "TS",
    tsx: "TSX",
    json: "JSON",
    css: "CSS",
    html: "HTML",
    markdown: "MD",
    python: "PY",
    rust: "RS",
    shell: "SH",
    bash: "SH",
  };
  if (known[language.toLocaleLowerCase()])
    return known[language.toLocaleLowerCase()]!;
  const extension = filePath.split(".").pop();
  return (
    extension && extension !== filePath ? extension : language
  ).toUpperCase();
}

/**
 * The path breadcrumb.
 *
 * Clicking a directory segment lists that directory; clicking a file in the
 * popover navigates the viewer.
 */
function Breadcrumb({
  path: filePath,
  root,
  onOpenPath,
}: {
  path: string;
  root?: string;
  onOpenPath?: (path: string) => void;
}) {
  const [openAt, setOpenAt] = useState<string | null>(null);

  // Show the path relative to the workspace root when it is inside it —
  // an absolute `/Users/…/project/src/x.ts` buries the part that identifies
  // the file. The workspace root's own name leads.
  const segments = useMemo(() => {
    const rootName = root ? (root.split("/").filter(Boolean).pop() ?? "") : "";
    const relative =
      root && filePath.startsWith(root + "/")
        ? filePath.slice(root.length + 1)
        : filePath;
    const parts = relative.split("/").filter(Boolean);

    let prefix = root && filePath.startsWith(root + "/") ? root : "";
    const out: { name: string; path: string; isDir: boolean }[] = [];
    if (prefix) out.push({ name: rootName, path: prefix, isDir: true });
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : `/${parts[i]}`;
      out.push({
        name: parts[i]!,
        path: prefix,
        isDir: i < parts.length - 1,
      });
    }
    return out;
  }, [filePath, root]);

  return (
    <nav className="fv-breadcrumb" aria-label="File path">
      {segments.map((seg, i) => (
        <span key={seg.path} className="fv-crumb">
          {i > 0 && <span className="fv-crumb-sep">›</span>}
          {seg.isDir && onOpenPath ? (
            <button
              className="fv-crumb-btn"
              onClick={() => setOpenAt(openAt === seg.path ? null : seg.path)}
            >
              {seg.name}
            </button>
          ) : (
            <span className="fv-crumb-leaf">{seg.name}</span>
          )}
          {openAt === seg.path && onOpenPath && (
            <DirectoryPopover
              dir={seg.path}
              onPick={(p) => {
                setOpenAt(null);
                onOpenPath(p);
              }}
              onDismiss={() => setOpenAt(null)}
            />
          )}
        </span>
      ))}
    </nav>
  );
}

/** The async directory listing behind a breadcrumb segment. */
function DirectoryPopover({
  dir,
  onPick,
  onDismiss,
}: {
  dir: string;
  onPick: (path: string) => void;
  onDismiss: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; entries: CurrentFileEntry[] }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void window.codexDesk
      .readDir(dir)
      .then((entries) => {
        if (!cancelled) {
          setState({ kind: "ready", entries: presentFileEntries(entries) });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="fv-crumb-popover">
      {state.kind === "loading" && <div className="muted">Loading…</div>}
      {state.kind === "error" && (
        <div className="muted">Couldn&rsquo;t load folder contents</div>
      )}
      {state.kind === "ready" && state.entries.length === 0 && (
        <div className="muted">This folder is empty</div>
      )}
      {state.kind === "ready" &&
        state.entries.map((e) => (
          <button
            key={e.path}
            className="fv-crumb-item"
            onClick={() => !e.isDirectory && onPick(e.path)}
            disabled={e.isDirectory}
            title={e.isDirectory ? "Folder" : e.path}
          >
            <span className="fv-crumb-icon">{e.isDirectory ? "▸" : ""}</span>
            {e.name}
          </button>
        ))}
    </div>
  );
}

/**
 * The `⋯` menu.
 *
 * Show only actions that work for the current file. A short menu is clearer
 * than permanently disabled future controls.
 *
 * `Copy file contents` is hidden rather than disabled for a non-text file, on
 * the same principle.
 */
function ViewerMenu({
  open,
  onOpenChange,
  wrap,
  canCopyContents,
  onToggleWrap,
  onCopyPath,
  onCopyContents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wrap: boolean;
  canCopyContents: boolean;
  onToggleWrap: () => void;
  onCopyPath: () => void;
  onCopyContents: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) onOpenChange(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="fv-menu-wrap" ref={ref}>
      <button
        className="linkish"
        aria-label="File viewer options"
        aria-expanded={open}
        title="File viewer options"
        onClick={() => onOpenChange(!open)}
      >
        ⋯
      </button>
      {open && (
        <div className="fv-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              onCopyPath();
              onOpenChange(false);
            }}
          >
            Copy path
          </button>
          {canCopyContents && (
            <button
              role="menuitem"
              onClick={() => {
                onCopyContents();
                onOpenChange(false);
              }}
            >
              Copy file contents
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              onToggleWrap();
              onOpenChange(false);
            }}
          >
            {/* The control names what it will do. */}
            {wrap ? "Disable word wrap" : "Enable word wrap"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The gutter, the lines, and find-in-file.
 *
 * Lines are split once and memoized. Highlighting happens per line and only
 * after the grammar has loaded, which is why `ready` gates a re-render rather
 * than the component blocking on the load — a 2000-line file appears
 * immediately as plain text and gains color a frame later, instead of showing
 * nothing until shiki is up.
 */
function TextContents({
  text,
  language,
  appearance,
  wrap,
  findOpen,
  onCloseFind,
  revealLine,
  onRevealed,
}: {
  text: string;
  language: string;
  appearance: Appearance;
  wrap: boolean;
  findOpen: boolean;
  onCloseFind: () => void;
  revealLine?: number;
  onRevealed?: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const lines = useMemo(() => text.split("\n"), [text]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void ensureLanguage(language).then((ok) => {
      if (!cancelled && ok) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  // Every line index the query appears on. Line-granular, not match-granular:
  // the gutter and scroll target are lines, and a second hit on one line does
  // not give the reader anywhere new to go.
  const hits = useMemo(() => {
    if (!query) return [];
    const needle = query.toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) out.push(i);
    }
    return out;
  }, [lines, query]);

  useEffect(() => {
    setCurrent(0);
  }, [query]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  // Scroll the active hit into view. Layout effect so it lands before paint
  // and the line does not visibly jump.
  useLayoutEffect(() => {
    if (hits.length === 0) return;
    const line = hits[current % hits.length]!;
    const el = bodyRef.current?.querySelector(`[data-line="${line + 1}"]`);
    // Feature-detected rather than called blindly: `scrollIntoView` is absent
    // in jsdom, and a find bar that throws is worse than one that does not
    // scroll.
    el?.scrollIntoView?.({ block: "center" });
  }, [hits, current]);

  /**
   * Scroll to a `path:line` target, once.
   *
   * Layout effect for the same reason as find's: it lands before paint, so
   * the line does not visibly jump. `onRevealed` clears the request in the
   * workbench afterwards, which is what keeps re-selecting the tab later from
   * yanking the reader back to a line they scrolled away from.
   *
   * `text` is a dependency because the file loads asynchronously — on a cold
   * open this effect first runs against an empty body, and the line only
   * exists after the contents arrive.
   */
  useLayoutEffect(() => {
    if (!revealLine) return;
    const el = bodyRef.current?.querySelector(`[data-line="${revealLine}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    onRevealed?.();
  }, [revealLine, text, onRevealed]);

  const step = (delta: number) => {
    if (hits.length === 0) return;
    setCurrent((c) => (c + delta + hits.length) % hits.length);
  };

  const activeLine = hits.length
    ? hits[current % hits.length]
    : revealLine
      ? revealLine - 1
      : -1;
  const hitSet = useMemo(() => new Set(hits), [hits]);

  return (
    <>
      {findOpen && (
        <div className="fv-find">
          <input
            ref={findInputRef}
            className="filter"
            placeholder="Find in file…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setQuery("");
                onCloseFind();
              }
            }}
          />
          <span className="muted fv-find-count">
            {query
              ? hits.length
                ? `${(current % hits.length) + 1} of ${hits.length}`
                : "No results"
              : ""}
          </span>
          <button
            className="linkish"
            aria-label="Previous match"
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            className="linkish"
            aria-label="Next match"
            onClick={() => step(1)}
          >
            ↓
          </button>
          <button
            className="linkish"
            aria-label="Close find"
            onClick={onCloseFind}
          >
            ✕
          </button>
        </div>
      )}
      <div
        className={`fv-code${wrap ? " wrap" : ""}`}
        ref={bodyRef}
        role="region"
        aria-label="File contents"
      >
        {lines.map((line, i) => (
          <Line
            key={i}
            number={i + 1}
            text={line}
            language={ready ? language : "text"}
            appearance={appearance}
            isHit={hitSet.has(i)}
            isActiveHit={i === activeLine}
          />
        ))}
      </div>
    </>
  );
}

/**
 * One line: a gutter number and its content.
 *
 * `data-line` is the anchor the rest of §3.1 depends on — find scrolls to it,
 * and a `file:line` deep link will resolve against it. It is 1-based because
 * every other place a line number appears (diffs, stack traces, the agent's
 * own output) is 1-based, and an off-by-one between them would be silent.
 */
function Line({
  number,
  text,
  language,
  appearance,
  isHit,
  isActiveHit,
}: {
  number: number;
  text: string;
  language: string;
  appearance: Appearance;
  isHit: boolean;
  isActiveHit: boolean;
}) {
  const html =
    language === "text" ? null : highlightLine(text, language, appearance);

  return (
    <div
      className={`fv-line${isHit ? " hit" : ""}${isActiveHit ? " active" : ""}`}
      data-line={number}
    >
      <span className="fv-gutter" aria-hidden="true">
        {number}
      </span>
      {html ? (
        // shiki output, built from a TextMate grammar over text we read from
        // disk. Not user-authored HTML, and `structure: "inline"` emits only
        // styled spans.
        <span className="fv-text" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="fv-text">{text}</span>
      )}
    </div>
  );
}
