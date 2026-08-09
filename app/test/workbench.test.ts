import { describe, expect, it, beforeEach } from "vitest";
import {
  INITIAL_WORKBENCH,
  MIN_CHAT_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MAX_TREE_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_SIDE_WIDTH,
  MIN_TREE_WIDTH,
  __resetTabIds,
  clampToWidth,
  tabLabels,
  workbenchReducer,
  type WorkbenchAction,
  type WorkbenchState,
} from "../src/renderer/main_window/workbench";

/**
 * Workbench layout rules (V2.2 shape).
 *
 * The preview-tab behaviour is the part worth testing without a DOM: "open"
 * means three different things depending on what is already open, and that is
 * exactly the kind of logic that rots silently behind a UI.
 */

beforeEach(() => __resetTabIds());

const run = (
  actions: WorkbenchAction[],
  from: WorkbenchState = INITIAL_WORKBENCH,
): WorkbenchState => actions.reduce(workbenchReducer, from);

const paths = (s: WorkbenchState) =>
  s.side.tabs.map((t) => (t.kind === "file" ? t.path : "term"));

describe("preview tabs (VS Code's single- vs double-click)", () => {
  it("reuses one slot while single-clicking through a tree", () => {
    // The whole point: browsing a tree must not leave thirty tabs behind.
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true },
      { type: "openFile", path: "/repo/b.ts", preview: true },
      { type: "openFile", path: "/repo/c.ts", preview: true },
    ]);
    expect(paths(state)).toEqual(["/repo/c.ts"]);
    expect(state.side.tabs[0]!.kind === "file" && state.side.tabs[0]!.preview).toBe(
      true,
    );
  });

  it("keeps a double-clicked file and lets the preview slot move on", () => {
    const state = run([
      { type: "openFile", path: "/repo/keep.ts", preview: false },
      { type: "openFile", path: "/repo/browse1.ts", preview: true },
      { type: "openFile", path: "/repo/browse2.ts", preview: true },
    ]);
    expect(paths(state)).toEqual(["/repo/keep.ts", "/repo/browse2.ts"]);
  });

  it("promotes the preview tab in place rather than opening a duplicate", () => {
    // Single click then double click on the same file is the common gesture;
    // it must not end with the file open twice.
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true },
      { type: "openFile", path: "/repo/a.ts", preview: false },
    ]);
    expect(paths(state)).toEqual(["/repo/a.ts"]);
    expect(state.side.tabs[0]!.kind === "file" && state.side.tabs[0]!.preview).toBe(
      false,
    );
  });

  it("replaces the preview tab when a different file is opened persistently", () => {
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true },
      { type: "openFile", path: "/repo/b.ts", preview: false },
    ]);
    expect(paths(state)).toEqual(["/repo/b.ts"]);
  });

  it("activates an already-open file instead of reopening it", () => {
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: false },
      { type: "openFile", path: "/repo/b.ts", preview: false },
      { type: "openFile", path: "/repo/a.ts", preview: true },
    ]);
    expect(paths(state)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(state.side.activeId).toBe(state.side.tabs[0]!.id);
    // A single click on an open persistent tab must not demote it to preview.
    expect(state.side.tabs[0]!.kind === "file" && state.side.tabs[0]!.preview).toBe(
      false,
    );
  });

  it("shows the panel when a file is opened into a hidden one", () => {
    // Otherwise clicking a file in the tree does nothing visible.
    expect(INITIAL_WORKBENCH.side.visible).toBe(false);
    const state = run([{ type: "openFile", path: "/repo/a.ts", preview: true }]);
    expect(state.side.visible).toBe(true);
  });
});

describe("closing tabs", () => {
  it("falls back to another tab when the active one closes", () => {
    const opened = run([
      { type: "openFile", path: "/repo/a.ts", preview: false },
      { type: "openFile", path: "/repo/b.ts", preview: false },
    ]);
    const activeId = opened.side.activeId!;
    const state = workbenchReducer(opened, {
      type: "closeTab",
      panel: "side",
      id: activeId,
    });
    expect(state.side.activeId).not.toBe(activeId);
    expect(state.side.activeId).toBe(state.side.tabs[0]!.id);
  });

  it("hides a panel emptied of tabs", () => {
    // An empty panel holding width open is the competing-panes problem again.
    const opened = run([{ type: "openFile", path: "/repo/a.ts", preview: true }]);
    const state = workbenchReducer(opened, {
      type: "closeTab",
      panel: "side",
      id: opened.side.tabs[0]!.id,
    });
    expect(state.side.tabs).toEqual([]);
    expect(state.side.visible).toBe(false);
    expect(state.side.activeId).toBeNull();
  });
});

describe("terminals are per-thread; files are not", () => {
  it("focuses the existing terminal rather than spawning a second shell", () => {
    const state = run([
      { type: "openTerminal", threadId: "T1" },
      { type: "openTerminal", threadId: "T1" },
    ]);
    expect(state.bottom.tabs.length).toBe(1);
  });

  it("drops terminal tabs on a thread switch but keeps file tabs", () => {
    const opened = run([
      { type: "openFile", path: "/repo/a.ts", preview: false },
      { type: "openTerminal", threadId: "T1" },
    ]);
    const state = workbenchReducer(opened, {
      type: "threadChanged",
      threadId: "T2",
    });
    expect(state.bottom.tabs).toEqual([]);
    expect(state.bottom.visible).toBe(false);
    // Switching threads inside a project should not throw away your reading.
    expect(paths(state)).toEqual(["/repo/a.ts"]);
  });

  it("keeps the terminal when the thread is unchanged", () => {
    const opened = run([{ type: "openTerminal", threadId: "T1" }]);
    const state = workbenchReducer(opened, {
      type: "threadChanged",
      threadId: "T1",
    });
    expect(state.bottom.tabs.length).toBe(1);
    expect(state.bottom.visible).toBe(true);
  });
});

describe("resize clamps", () => {
  it("refuses to shrink a panel below its floor", () => {
    const state = run([
      { type: "resize", sidebarWidth: 10, sideWidth: 10, treeWidth: 10 },
    ]);
    expect(state.sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    expect(state.sideWidth).toBe(MIN_SIDE_WIDTH);
    expect(state.treeWidth).toBe(MIN_TREE_WIDTH);
  });

  it("caps both fixed navigation rails at the mock's maximums", () => {
    const state = run([
      { type: "resize", sidebarWidth: 900, treeWidth: 900 },
    ]);
    expect(state.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(state.treeWidth).toBe(MAX_TREE_WIDTH);
  });

  it("protects the chat's width when the window narrows", () => {
    // The failure this exists to prevent: two panes leaving ~48px of chat.
    const wide: WorkbenchState = {
      ...INITIAL_WORKBENCH,
      side: { ...INITIAL_WORKBENCH.side, visible: true },
      treeVisible: true,
      sideWidth: 700,
      treeWidth: 300,
    };
    const state = clampToWidth(wide, 1100);
    const chat = 1100 - state.sideWidth - state.treeWidth;
    expect(chat).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
  });

  it("takes width from the side panel before the tree", () => {
    // The tree is already the narrowest column; squeezing it first is wrong.
    const wide: WorkbenchState = {
      ...INITIAL_WORKBENCH,
      side: { ...INITIAL_WORKBENCH.side, visible: true },
      treeVisible: true,
      sideWidth: 600,
      treeWidth: 240,
    };
    const state = clampToWidth(wide, 1100);
    expect(state.sideWidth).toBeLessThan(600);
    expect(state.treeWidth).toBe(240);
  });

  it("leaves a layout that already fits alone", () => {
    const fits: WorkbenchState = {
      ...INITIAL_WORKBENCH,
      side: { ...INITIAL_WORKBENCH.side, visible: true },
      treeVisible: true,
    };
    expect(clampToWidth(fits, 2000)).toBe(fits);
  });

  it("ignores hidden panels when measuring", () => {
    const hidden: WorkbenchState = { ...INITIAL_WORKBENCH, sideWidth: 900 };
    expect(clampToWidth(hidden, 800)).toBe(hidden);
  });
});

describe("tab labels", () => {
  it("shows basenames, and disambiguates only what collides", () => {
    const state = run([
      { type: "openFile", path: "/repo/src/index.ts", preview: false },
      { type: "openFile", path: "/repo/test/index.ts", preview: false },
      { type: "openFile", path: "/repo/README.md", preview: false },
    ]);
    const labels = tabLabels(state.side.tabs);
    const values = [...labels.values()];
    expect(values).toContain("src/index.ts");
    expect(values).toContain("test/index.ts");
    // The unique one stays short: qualifying every tab would be noise.
    expect(values).toContain("README.md");
  });
});

describe("panel and tree toggles", () => {
  it("toggles the tree independently of the side panel", () => {
    // The point of promoting the tree to a column: "show me the files" and
    // "show me this file" became separate actions.
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true },
      { type: "toggleTree" },
    ]);
    expect(state.treeVisible).toBe(true);
    expect(state.side.visible).toBe(true);

    const hidden = workbenchReducer(state, { type: "toggleTree" });
    expect(hidden.treeVisible).toBe(false);
    expect(hidden.side.visible).toBe(true);
  });
});

describe("sidebar visibility", () => {
  it("toggles independently of the other panels", () => {
    // The sidebar joined this model so the topbar could toggle all three
    // panels through one mechanism rather than two.
    expect(INITIAL_WORKBENCH.sidebarVisible).toBe(true);
    const hidden = workbenchReducer(INITIAL_WORKBENCH, {
      type: "toggleSidebar",
    });
    expect(hidden.sidebarVisible).toBe(false);
    expect(hidden.treeVisible).toBe(false);
    expect(hidden.side.visible).toBe(false);

    const shown = workbenchReducer(hidden, { type: "toggleSidebar" });
    expect(shown.sidebarVisible).toBe(true);
  });

  it("survives opening a file, so the layout is not reset by browsing", () => {
    const state = run([
      { type: "toggleSidebar" },
      { type: "openFile", path: "/repo/a.ts", preview: true },
    ]);
    expect(state.sidebarVisible).toBe(false);
    expect(state.side.visible).toBe(true);
  });
});

/**
 * `path:line` citations from agent messages (the `revealLine` one-shot).
 *
 * The line is an *instruction*, not tab state: it has to survive long enough
 * for the viewer to scroll, then be forgotten, or re-selecting the tab a
 * minute later would yank the reader back to a line they scrolled away from.
 */
describe("file citations with a line", () => {
  it("carries the line onto a newly opened tab", () => {
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true, line: 345 },
    ]);
    const tab = state.side.tabs[0];
    expect(tab).toMatchObject({ kind: "file", path: "/repo/a.ts" });
    expect(tab?.kind === "file" && tab.revealLine).toBe(345);
  });

  it("re-targets a file that is already open", () => {
    // Two citations of the same file must both go somewhere. Without this,
    // the second click activates the tab and silently ignores the line.
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true, line: 10 },
      { type: "openFile", path: "/repo/a.ts", preview: true, line: 900 },
    ]);
    expect(state.side.tabs).toHaveLength(1);
    const tab = state.side.tabs[0];
    expect(tab?.kind === "file" && tab.revealLine).toBe(900);
  });

  it("clears the target once the viewer has honoured it", () => {
    const opened = run([
      { type: "openFile", path: "/repo/a.ts", preview: true, line: 345 },
    ]);
    const id = opened.side.tabs[0]!.id;
    const state = workbenchReducer(opened, {
      type: "revealed",
      panel: "side",
      id,
    });
    const tab = state.side.tabs[0];
    expect(tab?.kind === "file" && tab.revealLine).toBeUndefined();
  });

  it("does not leave a stale line when the preview slot is reused", () => {
    // Citing a.ts:345 then browsing to b.ts must not scroll b.ts to 345.
    const state = run([
      { type: "openFile", path: "/repo/a.ts", preview: true, line: 345 },
      { type: "openFile", path: "/repo/b.ts", preview: true },
    ]);
    expect(state.side.tabs).toHaveLength(1);
    const tab = state.side.tabs[0];
    expect(tab?.kind === "file" && tab.path).toBe("/repo/b.ts");
    expect(tab?.kind === "file" && tab.revealLine).toBeUndefined();
  });
});
