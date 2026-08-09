import { useCallback, useEffect, useRef, useState } from "react";
import { readProductStorage } from "./productStorage";

/**
 * Workbench chrome: panel frames, tab strips, and splitters.
 *
 * Layout only — no knowledge of what a tab contains. `App` owns the state
 * (see `workbench.ts`) and supplies the content, which keeps this file from
 * growing a second copy of the open-file rules.
 */

/**
 * A draggable edge.
 *
 * Pointer capture rather than window listeners: without it, dragging fast
 * enough to leave the 4px hit area drops the drag, which reads as the
 * splitter being broken. Capture keeps events coming to this element until
 * release.
 *
 * The handle is also a slider for the keyboard, because a resize that only
 * works with a pointer is not a resize for everyone.
 */
export function Splitter({
  orientation,
  onResize,
  onResizeBy,
  label,
  className,
}: {
  orientation: "vertical" | "horizontal";
  /** Absolute pointer position, in client coordinates. */
  onResize: (position: number) => void;
  /** Keyboard nudge, in pixels. */
  onResizeBy: (delta: number) => void;
  label: string;
  className?: string;
}) {
  const dragging = useRef(false);

  const onPointerDown = useCallback((ev: React.PointerEvent) => {
    dragging.current = true;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    // Text selection during a drag makes the whole window flash blue.
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback(
    (ev: React.PointerEvent) => {
      if (!dragging.current) return;
      onResize(orientation === "vertical" ? ev.clientX : ev.clientY);
    },
    [onResize, orientation],
  );

  const stop = useCallback((ev: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    ev.currentTarget.releasePointerCapture?.(ev.pointerId);
    document.body.style.userSelect = "";
  }, []);

  return (
    <div
      className={`splitter ${orientation}${className ? ` ${className}` : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(ev) => {
        const step = ev.shiftKey ? 48 : 12;
        if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          onResizeBy(-step);
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
          ev.preventDefault();
          onResizeBy(step);
        }
      }}
    />
  );
}

export type TabDescriptor = {
  id: string;
  label: string;
  /** Rendered in italics, VS Code's signal that the tab will be replaced. */
  preview: boolean;
  title?: string;
  /** False for persistent tools whose lifecycle is owned by panel actions. */
  closable?: boolean;
};

/**
 * A panel's tab strip.
 *
 * Middle-click closes, as everywhere else that has tabs. Double-click on a
 * preview tab promotes it, which is the same gesture that created it from the
 * tree — so "I want to keep this" is one motion wherever you are.
 */
export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onPromote,
  actions,
}: {
  tabs: TabDescriptor[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPromote?: (id: string) => void;
  /** Panel-level controls, right-aligned: tree toggle, hide panel. */
  actions?: React.ReactNode;
}) {
  return (
    <div className="tabstrip" role="tablist">
      <div className="tabstrip-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            tabIndex={tab.id === activeId ? 0 : -1}
            title={tab.title ?? tab.label}
            className={`tab${tab.id === activeId ? " active" : ""}${
              tab.preview ? " preview" : ""
            }`}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => onPromote?.(tab.id)}
            onAuxClick={(ev) => {
              if (ev.button === 1 && tab.closable !== false) {
                ev.preventDefault();
                onClose(tab.id);
              }
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onActivate(tab.id);
              }
            }}
          >
            <span className="tab-label">{tab.label}</span>
            {tab.closable !== false && (
              <button
                className="tab-close"
                aria-label={`Close ${tab.label}`}
                onClick={(ev) => {
                  // Without this the click also activates the tab being closed.
                  ev.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {actions && <div className="tabstrip-actions">{actions}</div>}
    </div>
  );
}

/**
 * Persist layout across restarts.
 *
 * `localStorage` rather than the main-process store: it is renderer view
 * state with no other consumer, and routing it through IPC would mean a
 * schema change and a round-trip for three numbers and two booleans.
 */
export function usePersistedLayout<T>(key: string, value: T, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // A layout that fails to persist is not worth breaking the app over.
    }
  }, [key, value, enabled]);
}

export function loadPersistedLayout<T>(key: string, fallback: T): T {
  try {
    const raw = readProductStorage(key);
    if (!raw) return fallback;
    // Merged over the fallback so a stored layout from an older shape does
    // not arrive missing keys the current one requires.
    return { ...fallback, ...(JSON.parse(raw) as object) } as T;
  } catch {
    return fallback;
  }
}

/**
 * The topbar (2026-07-27 restructure).
 *
 * It had grown to eleven controls that mixed four unrelated jobs at equal
 * visual weight — workspace, thread actions, panel toggles, and persistent
 * settings — so nothing read as primary and the thread you were in was not
 * named anywhere. Two of them, `Usage` and `Sign out`, already existed in the
 * sidebar footer.
 *
 * The thread name and panel toggles remain visible. Everything else moves
 * into an overflow menu. The rule for deciding is
 * whether the control is about *this view* — those stay — or about the
 * session and the workspace, which are occasional and belong behind `⋯`.
 */
export function IconButton({
  label,
  on,
  onClick,
  badge,
  className,
  children,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  badge?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`topbar-icon${on ? " on" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
    >
      {children}
      {Boolean(badge) && <span className="topbar-badge">{badge}</span>}
    </button>
  );
}

/**
 * Panel glyphs, drawn rather than imported.
 *
 * A rectangle with one edge filled: the filled edge is the panel the button
 * controls, so the icon says
 * *which* panel without a label. An icon font for four shapes would be a
 * dependency for no gain.
 */
export function PanelIcon({ side }: { side: "left" | "right" | "bottom" }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {side === "left" && (
        <rect x="1.5" y="2.5" width="4.5" height="11" fill="currentColor" />
      )}
      {side === "right" && (
        <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" />
      )}
      {side === "bottom" && (
        <rect x="1.5" y="9.5" width="13" height="4" fill="currentColor" />
      )}
    </svg>
  );
}

/** The file tree toggle: a small tree rather than a panel outline. */
export function TreeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.2" fill="none">
        <path d="M3 3v9.5h3M3 7.5h3" />
      </g>
      <g fill="currentColor">
        <rect x="6.5" y="1.5" width="7" height="2.4" rx="0.6" />
        <rect x="6.5" y="6.3" width="7" height="2.4" rx="0.6" />
        <rect x="6.5" y="11.1" width="7" height="2.4" rx="0.6" />
      </g>
    </svg>
  );
}

/** Occasional thread and workspace actions from the topbar's ellipsis. */
export function OverflowMenu({
  badge,
  children,
}: {
  badge?: number;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="topbar-overflow" ref={ref}>
      <IconButton
        label="More actions"
        on={open}
        onClick={() => setOpen((shown) => !shown)}
        badge={badge}
      >
        <span className="topbar-ellipsis">⋯</span>
      </IconButton>
      {open && (
        <div className="topbar-menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * The thread name in the topbar, renamable in place.
 *
 * Deliberately not `window.prompt` — that throws `prompt() is not supported`
 * in Electron, found by reading the renderer console. Inline editing is also
 * what the sidebar's rename already does, so this is one interaction rather
 * than two for the same job.
 */
export function ThreadTitle({
  name,
  title,
  worktree,
  onRename,
}: {
  name: string;
  title?: string;
  worktree?: boolean;
  onRename?: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = value.trim();
    // An empty name is a no-op rather than a way to erase the label: the bar
    // would then show nothing at all.
    if (next && next !== name) onRename?.(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="topbar-title-input"
        value={value}
        aria-label="Chat name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            // Escape abandons the edit; the composer must not also see it.
            e.stopPropagation();
            setValue(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="topbar-title"
      title={title}
      onDoubleClick={() => {
        if (!onRename) return;
        setValue(name);
        setEditing(true);
      }}
    >
      {worktree && (
        <span className="wt-mark" title="Running in a worktree">
          ⑂
        </span>
      )}
      <span className="topbar-title-text">{name}</span>
    </button>
  );
}
