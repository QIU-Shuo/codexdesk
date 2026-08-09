import {
  DefaultFolderOpenedIcon,
  FileIcon,
  FolderIcon,
} from "@react-symbols/icons/utils";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  presentFileEntries,
  type CurrentFileEntry,
} from "../compatibility/filePresentation";

export { FileViewer } from "./FileViewer";

/**
 * Workspace file tree and viewer.
 *
 * Reads go through the main process, which confines them to the workspace
 * and worktree roots — the renderer names a path but never gains free
 * filesystem access.
 *
 * The tree refreshes on `fs/changed`, which comes from app-server rather
 * than a local watcher, so an edit the *agent* makes and an edit you make in
 * the terminal both show up the same way (§12.4).
 *
 * The viewer moved to `FileViewer.tsx` when it grew a gutter, highlighting,
 * find, and typed states; this file is the tree and its chrome.
 */
export function FileTree({
  root,
  changeToken,
  activePath,
  onOpenFile,
  onAddToChat,
}: {
  root: string;
  changeToken: number;
  /** The file currently open in the viewer, highlighted in the tree. */
  activePath?: string | null;
  /**
   * `preview` follows VS Code: a single click opens into the reusable preview
   * slot, a double click opens a persistent tab. The tree reports the
   * gesture; `workbench.ts` decides what it means for the tab list.
   */
  onOpenFile: (path: string, preview: boolean) => void;
  /** Insert a file mention in the composer from the tree context menu. */
  onAddToChat?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [children, setChildren] = useState<Record<string, CurrentFileEntry[]>>(
    {},
  );
  const [filter, setFilter] = useState("");
  /** Roving focus for keyboard navigation — the path of the focused row. */
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    entry: CurrentFileEntry;
    x: number;
    y: number;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (dir: string) => {
    const entries = await window.codexDesk.readDir(dir);
    setChildren((prev) => ({
      ...prev,
      [dir]: presentFileEntries(entries),
    }));
  }, []);

  useEffect(() => {
    setExpanded(new Set([root]));
    setChildren({});
    setFocused(null);
    void load(root);
  }, [root, load]);

  // Re-read only the directories currently open; refreshing the whole tree
  // on every change would be wasteful and would collapse scroll position.
  useEffect(() => {
    if (changeToken === 0) return;
    for (const dir of expanded) void load(dir);
    // `expanded` is intentionally not a dependency: this should run when a
    // change arrives, not when the user expands something.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeToken, load]);

  const toggle = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          void load(dir);
        }
        return next;
      });
    },
    [load],
  );

  /**
   * Flatten the tree to the rows actually on screen.
   *
   * This replaced a recursive render because arrow-key navigation needs to
   * answer "what is the next visible row" — which is a question about the
   * flattened order, and was not answerable from nested JSX without walking
   * the DOM. Filtering and rendering now share one traversal, so the two can
   * no longer disagree about which rows exist.
   */
  const rows = useMemo(() => {
    const out: { entry: CurrentFileEntry; depth: number; open: boolean }[] = [];

    const walk = (dir: string, depth: number): boolean => {
      const entries = children[dir];
      if (!entries) return false;
      let anyShown = false;

      for (const e of entries) {
        if (!filter) {
          out.push({ entry: e, depth, open: expanded.has(e.path) });
          anyShown = true;
          if (e.isDirectory && expanded.has(e.path)) walk(e.path, depth + 1);
          continue;
        }

        // Filtering. A file shows if its own name matches. A directory shows
        // if its name matches *or* anything already loaded beneath it does —
        // the tree is lazy, so an unopened folder is filtered by name only.
        // Dirs are force-opened so matches are visible without clicking.
        if (!e.isDirectory) {
          if (matches(e, filter)) {
            out.push({ entry: e, depth, open: false });
            anyShown = true;
          }
          continue;
        }

        // Reserve the directory's slot before walking it: children must land
        // after their parent, but whether the parent is shown at all depends
        // on what the walk finds.
        const slot = out.length;
        out.push({ entry: e, depth, open: true });
        const hasInner = walk(e.path, depth + 1);
        if (!matches(e, filter) && !hasInner) {
          out.splice(slot, 1);
        } else {
          anyShown = true;
        }
      }

      return anyShown;
    };

    walk(root, 0);
    return out;
  }, [children, expanded, filter, root]);

  const activate = useCallback(
    (entry: CurrentFileEntry, preview = true) => {
      if (entry.isDirectory) toggle(entry.path);
      else onOpenFile(entry.path, preview);
    },
    [toggle, onOpenFile],
  );

  /**
   * Arrow-key navigation over the flattened rows.
   *
   * The rows were already `tabIndex={0}`, which made a large tree a long
   * tab-stop chain — reaching the file list past a thousand-entry folder was
   * a thousand presses. Roving tabindex fixes that: one stop for the tree,
   * arrows inside it.
   */
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    const index = rows.findIndex((r) => r.entry.path === focused);
    const move = (next: number) => {
      ev.preventDefault();
      const clamped = Math.max(0, Math.min(rows.length - 1, next));
      const target = rows[clamped];
      if (!target) return;
      setFocused(target.entry.path);
      listRef.current
        ?.querySelector<HTMLElement>(
          `[data-path="${cssEscape(target.entry.path)}"]`,
        )
        ?.focus();
    };

    switch (ev.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index === -1 ? 0 : index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "ArrowRight": {
        const row = rows[index];
        if (!row?.entry.isDirectory) return;
        ev.preventDefault();
        if (!row.open) toggle(row.entry.path);
        else move(index + 1);
        return;
      }
      case "ArrowLeft": {
        const row = rows[index];
        if (!row) return;
        ev.preventDefault();
        if (row.entry.isDirectory && row.open) {
          toggle(row.entry.path);
          return;
        }
        // Not an open directory: go to the parent row, which is the nearest
        // preceding row at a shallower depth.
        for (let i = index - 1; i >= 0; i--) {
          if (rows[i]!.depth < row.depth) return move(i);
        }
        return;
      }
      case "Enter":
      case " ": {
        const row = rows[index];
        if (!row) return;
        ev.preventDefault();
        activate(row.entry);
        return;
      }
    }
  };

  return (
    <div className="filetree-shell">
      <div className="filetree-head">
        <span>Tree</span>
        <span className="muted" title={root}>
          {root.split("/").filter(Boolean).slice(-2).join("/")}
        </span>
      </div>
      <div className="filetree-filter">
        <span className="filetree-filter-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          className="filter"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              setFilter("");
              e.stopPropagation();
            }
          }}
        />
        {filter && <span className="filetree-result-count">{rows.length}</span>}
        {filter && (
          <button
            className="linkish"
            title="Clear file filter"
            onClick={() => setFilter("")}
          >
            ✕
          </button>
        )}
      </div>
      <div
        className="filetree"
        ref={listRef}
        role="tree"
        aria-label="Workspace files"
        onKeyDown={onKeyDown}
      >
        {rows.map(({ entry, depth, open }) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            filter={filter}
            depth={depth}
            open={open}
            active={entry.path === activePath}
            // Roving tabindex: exactly one row is a tab stop. Falling back to
            // the first row means the tree is reachable before any row has
            // been focused.
            tabbable={
              focused ? entry.path === focused : entry === rows[0]?.entry
            }
            onActivate={() => {
              setFocused(entry.path);
              activate(entry);
            }}
            // Double click promotes to a persistent tab. The single-click
            // handler still runs first and opens the preview; promoting the
            // same path is what the second click then does.
            onOpenPersistent={() => {
              setFocused(entry.path);
              activate(entry, false);
            }}
            onFocus={() => setFocused(entry.path)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu({ entry, x: ev.clientX, y: ev.clientY });
            }}
          />
        ))}
      </div>
      {filter && rows.length === 0 && (
        <div className="filetree-note muted">No matching files</div>
      )}
      <div className="filetree-note filetree-footnote muted">
        Filter reaches opened folders. <code>@</code> searches everything.
      </div>
      {menu && (
        <TreeContextMenu
          entry={menu.entry}
          x={menu.x}
          y={menu.y}
          onAddToChat={onAddToChat}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Escape a path for use in an attribute selector.
 *
 * Paths contain characters `querySelector` treats as syntax. `CSS.escape` is
 * the right tool but is absent in jsdom, so the fallback keeps tests running
 * on the same code path the app uses.
 */
function cssEscape(value: string): string {
  const fn = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS
    ?.escape;
  return fn ? fn(value) : value.replace(/["\\]/g, "\\$&");
}

/** One row. Flattening moved children out, so this renders exactly one line. */
function TreeRow({
  entry,
  filter,
  depth,
  open,
  active,
  tabbable,
  onActivate,
  onOpenPersistent,
  onFocus,
  onContextMenu,
}: {
  entry: CurrentFileEntry;
  filter: string;
  depth: number;
  open: boolean;
  active: boolean;
  tabbable: boolean;
  onActivate: () => void;
  onOpenPersistent?: () => void;
  onFocus: () => void;
  onContextMenu: (ev: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`tree-row${active ? " active" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      data-path={entry.path}
      tabIndex={tabbable ? 0 : -1}
      role="treeitem"
      aria-expanded={entry.isDirectory ? open : undefined}
      aria-selected={active}
      onClick={onActivate}
      onDoubleClick={onOpenPersistent}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
    >
      <span className="tree-caret">
        {entry.isDirectory ? (open ? "▾" : "▸") : ""}
      </span>
      <span className="tree-icon" aria-hidden="true">
        {entry.isDirectory ? (
          open ? (
            <DefaultFolderOpenedIcon />
          ) : (
            <FolderIcon folderName={entry.name.toLowerCase()} />
          )
        ) : (
          <FileIcon fileName={entry.name} autoAssign />
        )}
      </span>
      <span className={entry.isDirectory ? "tree-dir" : "tree-file"}>
        <HighlightMatch text={entry.name} query={filter} />
      </span>
    </div>
  );
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

/**
 * The tree's context menu (§3.3).
 *
 * `Copy file contents` goes through the main process rather than reading here:
 * the renderer has no filesystem access, and adding one for a convenience menu
 * would be a second, unguarded read path past the allow-list that `readFile`
 * enforces.
 */
function TreeContextMenu({
  entry,
  x,
  y,
  onAddToChat,
  onDismiss,
}: {
  entry: CurrentFileEntry;
  x: number;
  y: number;
  onAddToChat?: (path: string) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onDismiss();
    };
    // Capture: the menu's own buttons run their click handler first, then the
    // document sees the mousedown and dismisses.
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  return (
    <div
      ref={ref}
      className="tree-menu"
      role="menu"
      style={{ left: x, top: y }}
    >
      {!entry.isDirectory && onAddToChat && (
        <>
          <button role="menuitem" onClick={run(() => onAddToChat(entry.path))}>
            Add to chat
          </button>
          <div className="tree-menu-separator" />
        </>
      )}
      <button
        role="menuitem"
        onClick={run(() => void navigator.clipboard.writeText(entry.path))}
      >
        Copy path
      </button>
      {!entry.isDirectory && (
        <button
          role="menuitem"
          onClick={run(() => void window.codexDesk.copyFileContents(entry.path))}
        >
          Copy file contents
        </button>
      )}
      <div className="tree-menu-separator" />
      <button
        role="menuitem"
        onClick={run(() => void window.codexDesk.revealPath(entry.path))}
      >
        Reveal in Finder
      </button>
      {!entry.isDirectory && (
        <button
          role="menuitem"
          onClick={run(() => void window.codexDesk.openPath(entry.path))}
        >
          Open with default app
        </button>
      )}
    </div>
  );
}

/**
 * Whether an entry should survive the filter.
 *
 * A plain case-insensitive substring. The composer's `@` picker already does
 * fuzzy search against the server, and two different matching behaviours for
 * "find a file" would be worse than one obvious one.
 */
function matches(entry: CurrentFileEntry, filter: string): boolean {
  return entry.name.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Keep a render failure inside the pane (§3.3).
 *
 * Previously a throw anywhere in the tree took the whole files pane down with
 * it, and the tree renders data from disk — a path shape we did not anticipate
 * should degrade to a message, not to a blank surface.
 */
export class FileTreeBoundary extends Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="filetree-shell">
          <div className="filetree-head">
            <span>Tree</span>
          </div>
          <div className="filetree-note muted">
            File tree couldn&rsquo;t render.{" "}
            <button
              className="linkish"
              onClick={() => this.setState({ failed: false })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
