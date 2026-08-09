/**
 * Workbench layout state (V2.2, and the restructure asked for on 2026-07-27).
 *
 * This replaces the `showFiles` / `showTerminal` / `openFile` booleans that
 * grew one at a time. Those competed for the same horizontal space — a Files
 * pane and a Changes pane could squeeze the chat out — and gave the file
 * viewer nowhere to put a second file.
 *
 * The layout uses a conventional IDE panel model:
 *
 * - Two **panels**, side (right of the chat) and bottom. Each is independently
 *   shown or hidden and holds **tabs**.
 * - Tab kinds are deliberately limited to `file` and `terminal`. Review stays
 *   its own pane for now; see §"not covered" in the doc.
 * - The **file tree is not a panel tab**. It is a top-level column at the far
 *   right, a peer of the chat and the side panel rather than a child of the
 *   file viewer. A tree nested inside the viewer had to share the viewer's
 *   height, which is what truncated it.
 *
 * A reducer rather than a dozen `useState` calls because the preview-tab rules
 * below are genuinely stateful: "open" means different things depending on
 * what is already open, and that logic is worth testing without a DOM.
 */

export type PanelId = "side" | "bottom";

export type WorkbenchTab =
  | {
      id: string;
      kind: "file";
      path: string;
      /**
       * VS Code's preview tab, rendered in italics.
       *
       * A single click opens a file *here*, reusing the one preview slot, so
       * clicking through a tree does not leave thirty tabs behind. A double
       * click — or editing, if this were an editor — promotes it to a
       * persistent tab. At most one preview tab exists per panel.
       */
      preview: boolean;
      /**
       * Line to reveal on open, 1-based, when the file was opened from a
       * `path:line` reference. Cleared once the viewer has scrolled to it —
       * it is a one-shot instruction, not tab state, so re-selecting the tab
       * later does not yank the user back to a line they scrolled away from.
       */
      revealLine?: number;
    }
  | { id: string; kind: "terminal"; threadId: string };

export type PanelState = {
  visible: boolean;
  tabs: WorkbenchTab[];
  activeId: string | null;
};

export type WorkbenchState = {
  side: PanelState;
  bottom: PanelState;
  /** The file tree column. Its own toggle, since it is not a tab. */
  treeVisible: boolean;
  /**
   * The thread sidebar. It lives here rather than in `App` because it is the
   * left panel of the same three-column layout, and the topbar toggles it
   * beside the others — one model for "what is currently open".
   */
  sidebarVisible: boolean;
  /** Pixels. Persisted, so a layout survives a restart. */
  sidebarWidth: number;
  sideWidth: number;
  bottomHeight: number;
  treeWidth: number;
};

export const INITIAL_WORKBENCH: WorkbenchState = {
  side: { visible: false, tabs: [], activeId: null },
  bottom: { visible: false, tabs: [], activeId: null },
  treeVisible: false,
  sidebarVisible: true,
  sidebarWidth: 214,
  sideWidth: 520,
  bottomHeight: 260,
  treeWidth: 196,
};

/** Below these a panel is too small to be read rather than merely narrow. */
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 280;
export const MIN_SIDE_WIDTH = 440;
export const MIN_BOTTOM_HEIGHT = 120;
export const MIN_TREE_WIDTH = 168;
export const MAX_TREE_WIDTH = 320;
/**
 * The chat is the one surface that must never be squeezed out. Every resize
 * is clamped so it keeps at least this much, which is the invariant the
 * competing panes previously violated.
 */
export const MIN_CHAT_WIDTH = 420;

export type WorkbenchAction =
  | { type: "restore"; state: WorkbenchState }
  | { type: "togglePanel"; panel: PanelId }
  | { type: "toggleTree" }
  | { type: "toggleSidebar" }
  | { type: "setTreeVisible"; visible: boolean }
  /** Single click: preview. Double click: persistent. */
  | { type: "openFile"; path: string; preview: boolean; line?: number }
  /** Clear a tab's one-shot reveal target once the viewer has honoured it. */
  | { type: "revealed"; panel: PanelId; id: string }
  | { type: "openTerminal"; threadId: string }
  | { type: "activateTab"; panel: PanelId; id: string }
  | { type: "promoteTab"; panel: PanelId; id: string }
  | { type: "closeTab"; panel: PanelId; id: string }
  | {
      type: "resize";
      sidebarWidth?: number;
      sideWidth?: number;
      bottomHeight?: number;
      treeWidth?: number;
    }
  /** Thread switch: terminals belong to a thread, files do not. */
  | { type: "threadChanged"; threadId: string | null };

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Reset between tests so ids are predictable. Not used by the app. */
export function __resetTabIds(): void {
  counter = 0;
}

function withTabs(panel: PanelState, tabs: WorkbenchTab[]): PanelState {
  // Closing the active tab has to pick a new one, and an empty panel has no
  // active tab rather than a stale id.
  const activeId =
    panel.activeId && tabs.some((t) => t.id === panel.activeId)
      ? panel.activeId
      : (tabs[tabs.length - 1]?.id ?? null);
  return { ...panel, tabs, activeId };
}

/**
 * Open a file in the side panel.
 *
 * The three cases, in the order they are checked:
 *
 * 1. **Already open.** Activate it. A double click on an already-previewing
 *    tab also promotes it — that is how you make a tab stick without
 *    reopening it from the tree.
 * 2. **A preview tab exists.** Reuse it: same tab, new path. This is what
 *    keeps clicking through a tree from accumulating tabs.
 * 3. **Nothing to reuse.** Append.
 */
function openFile(
  state: WorkbenchState,
  path: string,
  preview: boolean,
  line?: number,
): WorkbenchState {
  const panel = state.side;
  const existing = panel.tabs.find((t) => t.kind === "file" && t.path === path);
  if (existing) {
    // A `path:line` click on an already-open file has to re-target the line,
    // otherwise the second reference to a file silently goes nowhere.
    const tabs = panel.tabs.map((t) =>
      t.id === existing.id && t.kind === "file"
        ? {
            ...t,
            ...(preview ? {} : { preview: false }),
            ...(line !== undefined ? { revealLine: line } : {}),
          }
        : t,
    );
    return {
      ...state,
      side: { ...panel, tabs, visible: true, activeId: existing.id },
      // Opening a file with the panel hidden should show the panel, or the
      // click does nothing visible.
      sideWidth: state.sideWidth,
    };
  }

  const previewTab = panel.tabs.find((t) => t.kind === "file" && t.preview);
  if (preview && previewTab) {
    const tabs = panel.tabs.map((t) =>
      t.id === previewTab.id && t.kind === "file"
        ? { ...t, path, revealLine: line }
        : t,
    );
    return {
      ...state,
      side: { ...panel, tabs, visible: true, activeId: previewTab.id },
    };
  }

  const tab: WorkbenchTab = {
    id: nextId("file"),
    kind: "file",
    path,
    preview,
    ...(line !== undefined ? { revealLine: line } : {}),
  };
  // A persistent open replaces the preview tab rather than sitting beside a
  // duplicate-feeling slot, matching VS Code.
  const base =
    !preview && previewTab
      ? panel.tabs.filter((t) => t.id !== previewTab.id)
      : panel.tabs;
  return {
    ...state,
    side: {
      ...panel,
      visible: true,
      tabs: [...base, tab],
      activeId: tab.id,
    },
  };
}

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case "restore":
      return action.state;

    case "togglePanel": {
      const panel = state[action.panel];
      return {
        ...state,
        [action.panel]: { ...panel, visible: !panel.visible },
      };
    }

    case "toggleTree":
      return { ...state, treeVisible: !state.treeVisible };

    case "toggleSidebar":
      return { ...state, sidebarVisible: !state.sidebarVisible };

    case "setTreeVisible":
      return { ...state, treeVisible: action.visible };

    case "openFile":
      return openFile(state, action.path, action.preview, action.line);

    case "revealed": {
      const panel = state[action.panel];
      return {
        ...state,
        [action.panel]: {
          ...panel,
          tabs: panel.tabs.map((t) =>
            t.id === action.id && t.kind === "file"
              ? { ...t, revealLine: undefined }
              : t,
          ),
        },
      };
    }

    case "openTerminal": {
      // One terminal per thread. Asking twice focuses the existing one rather
      // than spawning a second shell.
      const existing = state.bottom.tabs.find(
        (t) => t.kind === "terminal" && t.threadId === action.threadId,
      );
      if (existing) {
        return {
          ...state,
          bottom: { ...state.bottom, visible: true, activeId: existing.id },
        };
      }
      const tab: WorkbenchTab = {
        id: nextId("term"),
        kind: "terminal",
        threadId: action.threadId,
      };
      return {
        ...state,
        bottom: {
          ...state.bottom,
          visible: true,
          tabs: [...state.bottom.tabs, tab],
          activeId: tab.id,
        },
      };
    }

    case "activateTab":
      return {
        ...state,
        [action.panel]: { ...state[action.panel], activeId: action.id },
      };

    case "promoteTab": {
      const panel = state[action.panel];
      return {
        ...state,
        [action.panel]: {
          ...panel,
          tabs: panel.tabs.map((t) =>
            t.id === action.id && t.kind === "file"
              ? { ...t, preview: false }
              : t,
          ),
        },
      };
    }

    case "closeTab": {
      const panel = state[action.panel];
      const tabs = panel.tabs.filter((t) => t.id !== action.id);
      const next = withTabs(panel, tabs);
      // An empty panel hides itself: an empty pane holding width open is the
      // competing-panes problem in miniature.
      return {
        ...state,
        [action.panel]: { ...next, visible: tabs.length > 0 && panel.visible },
      };
    }

    case "resize":
      return {
        ...state,
        ...(action.sidebarWidth !== undefined
          ? {
              sidebarWidth: Math.min(
                MAX_SIDEBAR_WIDTH,
                Math.max(MIN_SIDEBAR_WIDTH, action.sidebarWidth),
              ),
            }
          : {}),
        ...(action.sideWidth !== undefined
          ? { sideWidth: Math.max(MIN_SIDE_WIDTH, action.sideWidth) }
          : {}),
        ...(action.bottomHeight !== undefined
          ? { bottomHeight: Math.max(MIN_BOTTOM_HEIGHT, action.bottomHeight) }
          : {}),
        ...(action.treeWidth !== undefined
          ? {
              treeWidth: Math.min(
                MAX_TREE_WIDTH,
                Math.max(MIN_TREE_WIDTH, action.treeWidth),
              ),
            }
          : {}),
      };

    case "threadChanged": {
      // Terminals are per-thread, so they do not survive a switch. Files are
      // workspace-level and do: switching threads inside a project should not
      // throw away what you were reading.
      const tabs = state.bottom.tabs.filter(
        (t) => t.kind === "terminal" && t.threadId === action.threadId,
      );
      const bottom = withTabs(state.bottom, tabs);
      return {
        ...state,
        bottom: { ...bottom, visible: bottom.visible && tabs.length > 0 },
      };
    }
  }
}

/** The tab's label and whether it is a preview, for the tab strip. */
export function tabLabel(tab: WorkbenchTab): string {
  if (tab.kind === "terminal") return "Terminal";
  return tab.path.split("/").pop() || tab.path;
}

/**
 * Disambiguate tabs that share a basename.
 *
 * Two files both called `index.ts` are otherwise indistinguishable in the
 * strip. Only the tabs that actually collide get a parent-directory suffix —
 * adding one to every tab would be noise.
 */
export function tabLabels(tabs: WorkbenchTab[]): Map<string, string> {
  const byLabel = new Map<string, WorkbenchTab[]>();
  for (const tab of tabs) {
    const label = tabLabel(tab);
    byLabel.set(label, [...(byLabel.get(label) ?? []), tab]);
  }

  const out = new Map<string, string>();
  for (const [label, group] of byLabel) {
    if (group.length === 1) {
      out.set(group[0]!.id, label);
      continue;
    }
    for (const tab of group) {
      const parent =
        tab.kind === "file" ? tab.path.split("/").slice(-2, -1)[0] : undefined;
      out.set(tab.id, parent ? `${parent}/${label}` : label);
    }
  }
  return out;
}

/**
 * Clamp panel sizes to the available width, preserving the chat's floor.
 *
 * Called on every resize and on window resize. Without it, dragging the side
 * panel wide and then narrowing the window leaves the chat at zero.
 */
export function clampToWidth(
  state: WorkbenchState,
  available: number,
): WorkbenchState {
  const tree = state.treeVisible ? state.treeWidth : 0;
  const side = state.side.visible ? state.sideWidth : 0;
  const overflow = tree + side + MIN_CHAT_WIDTH - available;
  if (overflow <= 0) return state;

  // Take it from the side panel first — it is the one the user just dragged,
  // and the tree is already the narrowest column.
  const fromSide = Math.min(overflow, Math.max(0, side - MIN_SIDE_WIDTH));
  const remaining = overflow - fromSide;
  const fromTree = Math.min(remaining, Math.max(0, tree - MIN_TREE_WIDTH));

  return {
    ...state,
    sideWidth: side ? side - fromSide : state.sideWidth,
    treeWidth: tree ? tree - fromTree : state.treeWidth,
  };
}
