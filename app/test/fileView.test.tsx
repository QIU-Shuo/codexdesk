import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { FileTree } from "../src/renderer/main_window/FileTree";
import {
  FileViewer,
  formatBytes,
} from "../src/renderer/main_window/FileViewer";
import type { FileEntryView, FileReadView } from "../src/contracts/views/files";

/**
 * File tree and viewer acceptance cases.
 *
 * A separate file from `renderer.test.tsx` because this is one self-contained
 * surface and that file is large and under concurrent edit.
 *
 * shiki is stubbed throughout. Highlighting is asynchronous and grammar-driven,
 * and the invariants worth testing here are the ones it must not break: line
 * anchors, gutter numbers, and the plain-text fallback. Whether a keyword gets
 * the right colour is not something jsdom can tell us.
 */
vi.mock("../src/renderer/main_window/highlight", () => ({
  ensureLanguage: () => Promise.resolve(false),
  highlightLine: () => null,
}));

type CodexDesk = {
  readDir: (dir: string) => Promise<FileEntryView[]>;
  readFile: (file: string) => Promise<FileReadView>;
  openPath: (target: string) => Promise<string | null>;
  copyFileContents: (target: string) => Promise<string | null>;
  revealPath: (target: string) => Promise<string | null>;
};

function entry(name: string, isDirectory = false): FileEntryView {
  return {
    name,
    path: `/repo/${name}`,
    kind: isDirectory ? "directory" : "file",
    presentation: null,
  };
}

function installCodexDesk(over: Partial<CodexDesk> = {}) {
  const codexDesk: CodexDesk = {
    readDir: () => Promise.resolve([]),
    readFile: () =>
      Promise.resolve({
        kind: "text",
        presentation: { mode: "text", language: "text", size: 0 },
        text: "",
      }),
    openPath: () => Promise.resolve(null),
    copyFileContents: () => Promise.resolve(null),
    revealPath: () => Promise.resolve(null),
    ...over,
  };
  (globalThis as { window?: { codexDesk?: CodexDesk } }).window!.codexDesk = codexDesk;
  return codexDesk;
}

beforeEach(() => {
  installCodexDesk();
  // Wrap is persisted per user and deliberately global, so it leaks between
  // tests unless cleared — which is what the persistence test below proves.
  localStorage.clear();
  // `navigator.clipboard` does not exist in jsdom.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const text = (over: Partial<Extract<FileReadView, { kind: "text" }>> = {}) =>
  ({
    kind: "text" as const,
    presentation: { mode: "text" as const, language: "text", size: 14 },
    text: "one\ntwo\nthree\n",
    ...over,
  }) satisfies FileReadView;

describe("FileViewer — a real code surface (§3.1)", () => {
  it("numbers every line and anchors it for deep links and find", async () => {
    // The anchors are the load-bearing part: `file:line` links and
    // scroll-to-match both resolve against `data-line`, and it is 1-based
    // because every other line number in the app is.
    installCodexDesk({ readFile: () => Promise.resolve(text()) });
    const { container } = render(
      <FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />,
    );

    await screen.findByText("one");
    const lines = container.querySelectorAll(".fv-line");
    expect(lines.length).toBe(4); // trailing newline yields an empty last line
    expect([...lines].map((l) => l.getAttribute("data-line"))).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(
      container.querySelector('[data-line="2"] .fv-text')?.textContent,
    ).toBe("two");
  });

  it("toggles wrap from the menu and persists it across files", async () => {
    // Per user, not per file (§3.1 item 3) — re-mounting with a different path
    // must not reset it.
    installCodexDesk({ readFile: () => Promise.resolve(text()) });
    const { container, unmount } = render(
      <FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />,
    );
    await screen.findByText("one");
    expect(container.querySelector(".fv-code.wrap")).toBeNull();

    fireEvent.click(screen.getByLabelText("File viewer options"));
    // The control names what it will do.
    fireEvent.click(screen.getByText("Enable word wrap"));
    expect(container.querySelector(".fv-code.wrap")).not.toBeNull();

    unmount();
    const second = render(
      <FileViewer path="/repo/b.ts" changeToken={0} onClose={() => {}} />,
    );
    await screen.findByText("one");
    expect(second.container.querySelector(".fv-code.wrap")).not.toBeNull();
    // And the menu now offers the other direction.
    fireEvent.click(screen.getByLabelText("File viewer options"));
    expect(screen.getByText("Disable word wrap")).toBeTruthy();
  });

  it("finds matches, counts them, and steps through", async () => {
    installCodexDesk({
      readFile: () =>
        Promise.resolve(text({ text: "alpha\nbeta\nalpha\ngamma" })),
    });
    const { container } = render(
      <FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />,
    );
    await screen.findByText("beta");

    fireEvent.click(screen.getByText("Find"));
    fireEvent.change(screen.getByPlaceholderText("Find in file…"), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(container.querySelectorAll(".fv-line.hit").length).toBe(2);
    // The active hit is distinct from the other hits, so "next" is visible.
    expect(
      container.querySelector(".fv-line.active")?.getAttribute("data-line"),
    ).toBe("1");

    fireEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("2 of 2")).toBeTruthy();
    expect(
      container.querySelector(".fv-line.active")?.getAttribute("data-line"),
    ).toBe("3");

    // Wrapping round is what makes "next" usable without checking the count.
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("says so when the query matches nothing", async () => {
    installCodexDesk({ readFile: () => Promise.resolve(text()) });
    render(<FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />);
    await screen.findByText("one");

    fireEvent.click(screen.getByText("Find"));
    fireEvent.change(screen.getByPlaceholderText("Find in file…"), {
      target: { value: "nothing here" },
    });
    expect(screen.getByText("No results")).toBeTruthy();
  });
});

describe("FileViewer — typed states (§3.2)", () => {
  it("names both numbers in the too-large state", async () => {
    // "840 KB exceeds the 512 KB preview limit" tells the user whether raising
    // the limit would help; "too large to display here" does not.
    installCodexDesk({
      readFile: () =>
        Promise.resolve({
          kind: "tooLarge",
          size: 9 * 1024 * 1024,
          limit: 8 * 1024 * 1024,
        }),
    });
    render(
      <FileViewer path="/repo/huge.bin" changeToken={0} onClose={() => {}} />,
    );

    await screen.findByText("File is too large to preview");
    expect(
      screen.getByText("9.0 MB exceeds the 8.0 MB preview limit"),
    ).toBeTruthy();
  });

  it("names the broad family of an external file", async () => {
    installCodexDesk({
      readFile: () =>
        Promise.resolve({
          kind: "external",
          presentation: {
            mode: "external",
            family: "document",
            mediaType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 40 * 1024,
          },
        }),
    });
    render(
      <FileViewer path="/repo/r.docx" changeToken={0} onClose={() => {}} />,
    );

    await screen.findByText(/Document previews aren’t supported yet/);
    expect(
      screen.getByText("Open this file in another app to view it"),
    ).toBeTruthy();
  });

  it("renders an image inline", async () => {
    installCodexDesk({
      readFile: () =>
        Promise.resolve({
          kind: "image",
          presentation: {
            mode: "image",
            mediaType: "image/png",
            size: 2048,
          },
          dataUrl: "data:image/png;base64,AAAA",
        }),
    });
    const { container } = render(
      <FileViewer path="/repo/shot.png" changeToken={0} onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".fv-image img")).not.toBeNull(),
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(screen.getByText("2 KB")).toBeTruthy();
  });

  it("offers recovery for a deleted file but not for permission denied", async () => {
    // The tree is refreshed by `fs/changed` rather than a local watcher, so a
    // file vanishing between read and open is both the likely error and the
    // recoverable one. Offering "try again" on EACCES would be a lie.
    installCodexDesk({
      readFile: () =>
        Promise.resolve({
          kind: "error",
          cause: "notFound",
          detail: "ENOENT: no such file",
        }),
    });
    const { unmount } = render(
      <FileViewer path="/repo/gone.ts" changeToken={0} onClose={() => {}} />,
    );
    await screen.findByText("Unable to load file");
    expect(screen.getByText("Back to the file tree")).toBeTruthy();
    // Not a raw ENOENT (acceptance case 5).
    expect(screen.queryByText(/ENOENT/)).toBeNull();
    unmount();

    installCodexDesk({
      readFile: () =>
        Promise.resolve({
          kind: "error",
          cause: "permission",
          detail: "EACCES",
        }),
    });
    render(
      <FileViewer path="/repo/secret" changeToken={0} onClose={() => {}} />,
    );
    await screen.findByText("Unable to load file");
    expect(screen.getByText("Permission denied.")).toBeTruthy();
    expect(screen.queryByText("Back to the file tree")).toBeNull();
  });

  it("keeps the truncation notice out of the text", async () => {
    installCodexDesk({
      readFile: () =>
        Promise.resolve(
          text({
            presentation: {
              mode: "text",
              language: "text",
              size: 600 * 1024,
            },
            truncatedAt: 512 * 1024,
          }),
        ),
    });
    const { container } = render(
      <FileViewer path="/repo/long.txt" changeToken={0} onClose={() => {}} />,
    );

    await screen.findByText("one");
    expect(screen.getByText(/Showing the first 512 KB of 600 KB/)).toBeTruthy();
    // The marker is chrome, not content: a sentinel inside the lines would be
    // copied and would be found by find-in-file.
    expect(container.querySelector(".fv-code")?.textContent).not.toContain(
      "truncated",
    );
  });
});

describe("FileViewer — chrome (§2.1, §2.2)", () => {
  it("shows compact line, language, encoding, and line-ending metadata", async () => {
    installCodexDesk({
      readFile: () =>
        Promise.resolve(
          text({
            presentation: { mode: "text", language: "tsx", size: 8 },
            text: "one\r\ntwo",
          }),
        ),
    });
    render(
      <FileViewer path="/repo/a.tsx" changeToken={0} onClose={() => {}} />,
    );

    await screen.findByText("2 lines");
    expect(screen.getByLabelText("File information").textContent).toBe(
      "TSXUTF-8CRLF",
    );
  });

  it("shows a breadcrumb relative to the workspace root", async () => {
    installCodexDesk({ readFile: () => Promise.resolve(text()) });
    render(
      <FileViewer
        path="/repo/src/deep/a.ts"
        root="/repo"
        changeToken={0}
        onClose={() => {}}
        onOpenPath={() => {}}
      />,
    );

    const crumbs = await screen.findByLabelText("File path");
    // Root name leads; the absolute prefix is not repeated.
    expect(crumbs.textContent).toContain("repo");
    expect(crumbs.textContent).toContain("src");
    expect(crumbs.textContent).toContain("a.ts");
  });

  it("lists a directory when a breadcrumb segment is clicked", async () => {
    // The breadcrumb is a navigator, not a label: `loadingDirectory` /
    // `emptyDirectory` / `directoryError` only make sense if it lists.
    const onOpenPath = vi.fn();
    installCodexDesk({
      readFile: () => Promise.resolve(text()),
      readDir: () =>
        Promise.resolve([
          {
            name: "b.ts",
            path: "/repo/src/b.ts",
            kind: "file",
            presentation: null,
          },
        ]),
    });
    render(
      <FileViewer
        path="/repo/src/a.ts"
        root="/repo"
        changeToken={0}
        onClose={() => {}}
        onOpenPath={onOpenPath}
      />,
    );

    await screen.findByText("one");
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(await screen.findByText("b.ts"));
    expect(onOpenPath).toHaveBeenCalledWith("/repo/src/b.ts");
  });

  it("reports an empty directory rather than an empty popover", async () => {
    installCodexDesk({
      readFile: () => Promise.resolve(text()),
      readDir: () => Promise.resolve([]),
    });
    render(
      <FileViewer
        path="/repo/src/a.ts"
        root="/repo"
        changeToken={0}
        onClose={() => {}}
        onOpenPath={() => {}}
      />,
    );
    await screen.findByText("one");
    fireEvent.click(screen.getByText("src"));
    expect(await screen.findByText("This folder is empty")).toBeTruthy();
  });

  it("offers only actions that work for the current file", async () => {
    // A menu of permanently disabled future controls is not useful.
    installCodexDesk({ readFile: () => Promise.resolve(text()) });
    render(<FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />);
    await screen.findByText("one");

    fireEvent.click(screen.getByLabelText("File viewer options"));
    expect(screen.getByText("Copy path")).toBeTruthy();
    expect(screen.getByText("Copy file contents")).toBeTruthy();
    expect(screen.getByText("Enable word wrap")).toBeTruthy();
    expect(screen.queryByText(/rich view/i)).toBeNull();
    expect(screen.queryByText(/git blame/i)).toBeNull();
  });

  it("hides Copy file contents for a file with no text", async () => {
    installCodexDesk({
      readFile: () =>
        Promise.resolve({
          kind: "external",
          presentation: {
            mode: "external",
            family: "archive",
            mediaType: "application/zip",
            size: 10,
          },
        }),
    });
    render(
      <FileViewer path="/repo/a.zip" changeToken={0} onClose={() => {}} />,
    );
    await screen.findByText(/Archive previews aren’t supported yet/);

    fireEvent.click(screen.getByLabelText("File viewer options"));
    expect(screen.getByText("Copy path")).toBeTruthy();
    expect(screen.queryByText("Copy file contents")).toBeNull();
  });

  it("copies contents through the main process, not from the renderer", async () => {
    // It is a read, and it must go through the same allow-list as `readFile`
    // rather than becoming a second, unguarded read path.
    const copyFileContents = vi.fn(() => Promise.resolve(null));
    installCodexDesk({ readFile: () => Promise.resolve(text()), copyFileContents });
    render(<FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />);
    await screen.findByText("one");

    fireEvent.click(screen.getByLabelText("File viewer options"));
    fireEvent.click(screen.getByText("Copy file contents"));
    expect(copyFileContents).toHaveBeenCalledWith("/repo/a.ts");
  });

  it("surfaces a refusal from the main process instead of claiming success", async () => {
    installCodexDesk({
      readFile: () => Promise.resolve(text()),
      copyFileContents: () =>
        Promise.resolve("That file is outside the current workspace."),
    });
    render(<FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />);
    await screen.findByText("one");

    fireEvent.click(screen.getByLabelText("File viewer options"));
    fireEvent.click(screen.getByText("Copy file contents"));
    expect(
      await screen.findByText("That file is outside the current workspace."),
    ).toBeTruthy();
  });

  it("clears stale content while the next file loads", async () => {
    // Leaving the previous file's text on screen reads as "this file has that
    // content", which is worse than a moment of nothing.
    let resolve: ((c: FileReadView) => void) | null = null;
    installCodexDesk({
      readFile: () =>
        new Promise<FileReadView>((r) => {
          resolve = r;
        }),
    });
    const { rerender } = render(
      <FileViewer path="/repo/a.ts" changeToken={0} onClose={() => {}} />,
    );
    await act(async () => {
      resolve!(text({ text: "first file" }));
    });
    expect(screen.getByText("first file")).toBeTruthy();

    rerender(
      <FileViewer path="/repo/b.ts" changeToken={0} onClose={() => {}} />,
    );
    expect(screen.queryByText("first file")).toBeNull();
    expect(screen.getByText("Loading file…")).toBeTruthy();
  });
});

describe("FileTree (§3.3)", () => {
  const tree = () =>
    installCodexDesk({
      readDir: (dir) =>
        Promise.resolve(
          dir === "/repo"
            ? [entry("src", true), entry("a.ts"), entry("b.ts")]
            : [
                {
                  name: "deep.ts",
                  path: "/repo/src/deep.ts",
                  kind: "file",
                  presentation: null,
                },
              ],
        ),
    });

  it("marks the open file, which the tree previously gave no signal about", async () => {
    tree();
    const { container } = render(
      <FileTree
        root="/repo"
        changeToken={0}
        activePath="/repo/b.ts"
        onOpenFile={() => {}}
      />,
    );

    await screen.findByText("b.ts");
    const active = container.querySelectorAll(".tree-row.active");
    expect(active.length).toBe(1);
    expect(active[0]?.getAttribute("data-path")).toBe("/repo/b.ts");
  });

  it("renders filename-aware file icons and folder icons", async () => {
    installCodexDesk({
      readDir: () =>
        Promise.resolve([
          entry("src", true),
          entry("package.json"),
          entry("data.json"),
        ]),
    });
    const { container } = render(
      <FileTree root="/repo" changeToken={0} onOpenFile={() => {}} />,
    );

    await screen.findByText("package.json");
    const folderIcon = container.querySelector(
      '[data-path="/repo/src"] .tree-icon svg',
    );
    const packageIcon = container.querySelector(
      '[data-path="/repo/package.json"] .tree-icon svg',
    );
    const jsonIcon = container.querySelector(
      '[data-path="/repo/data.json"] .tree-icon svg',
    );

    expect(folderIcon).not.toBeNull();
    expect(packageIcon).not.toBeNull();
    expect(jsonIcon).not.toBeNull();
    expect(packageIcon?.innerHTML).not.toBe(jsonIcon?.innerHTML);
  });

  it("navigates with arrows and opens with Enter", async () => {
    // The rows were all `tabIndex={0}`, making a large tree a long tab-stop
    // chain. Roving tabindex: one stop for the tree, arrows inside it.
    const onOpenFile = vi.fn();
    tree();
    const { container } = render(
      <FileTree root="/repo" changeToken={0} onOpenFile={onOpenFile} />,
    );
    await screen.findByText("a.ts");

    const list = container.querySelector(".filetree")!;
    // Only one row is tabbable.
    expect(container.querySelectorAll('.tree-row[tabindex="0"]').length).toBe(
      1,
    );

    fireEvent.keyDown(list, { key: "ArrowDown" }); // → src
    fireEvent.keyDown(list, { key: "ArrowDown" }); // → a.ts
    fireEvent.keyDown(list, { key: "Enter" });
    // Keyboard opens preview, like a single click.
    expect(onOpenFile).toHaveBeenCalledWith("/repo/a.ts", true);
  });

  it("distinguishes a single click from a double click", () => {
    // VS Code's rule, and the reason `preview` exists: click to peek, double
    // click to keep. `workbench.test.ts` covers what the flag then does.
    const onOpenFile = vi.fn();
    installCodexDesk({ readDir: () => Promise.resolve([entry("a.ts")]) });
    render(<FileTree root="/repo" changeToken={0} onOpenFile={onOpenFile} />);

    return screen.findByText("a.ts").then((row) => {
      fireEvent.click(row);
      expect(onOpenFile).toHaveBeenLastCalledWith("/repo/a.ts", true);
      fireEvent.doubleClick(row);
      expect(onOpenFile).toHaveBeenLastCalledWith("/repo/a.ts", false);
    });
  });

  it("expands and collapses a folder with the arrow keys", async () => {
    tree();
    const { container } = render(
      <FileTree root="/repo" changeToken={0} onOpenFile={() => {}} />,
    );
    await screen.findByText("src");

    const list = container.querySelector(".filetree")!;
    fireEvent.keyDown(list, { key: "ArrowDown" }); // focus src
    fireEvent.keyDown(list, { key: "ArrowRight" }); // expand
    expect(await screen.findByText("deep.ts")).toBeTruthy();

    fireEvent.keyDown(list, { key: "ArrowLeft" }); // collapse
    await waitFor(() => expect(screen.queryByText("deep.ts")).toBeNull());
  });

  it("copies contents from the context menu through the main process", async () => {
    // Acceptance case 6: this is a new read path and must not skip the guard.
    const copyFileContents = vi.fn(() => Promise.resolve(null));
    const revealPath = vi.fn(() => Promise.resolve(null));
    installCodexDesk({
      readDir: () => Promise.resolve([entry("a.ts")]),
      copyFileContents,
      revealPath,
    });
    render(<FileTree root="/repo" changeToken={0} onOpenFile={() => {}} />);

    fireEvent.contextMenu(await screen.findByText("a.ts"));
    fireEvent.click(screen.getByText("Copy file contents"));
    expect(copyFileContents).toHaveBeenCalledWith("/repo/a.ts");

    fireEvent.contextMenu(screen.getByText("a.ts"));
    fireEvent.click(screen.getByText("Reveal in Finder"));
    expect(revealPath).toHaveBeenCalledWith("/repo/a.ts");
  });

  it("adds a file reference to chat from the context menu", async () => {
    const onAddToChat = vi.fn();
    installCodexDesk({ readDir: () => Promise.resolve([entry("a.ts")]) });
    render(
      <FileTree
        root="/repo"
        changeToken={0}
        onOpenFile={() => {}}
        onAddToChat={onAddToChat}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("a.ts"));
    fireEvent.click(screen.getByText("Add to chat"));
    expect(onAddToChat).toHaveBeenCalledWith("/repo/a.ts");
  });

  it("says when the filter matches nothing", async () => {
    installCodexDesk({ readDir: () => Promise.resolve([entry("a.ts")]) });
    render(<FileTree root="/repo" changeToken={0} onOpenFile={() => {}} />);
    await screen.findByText("a.ts");

    fireEvent.change(screen.getByPlaceholderText("Filter files…"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matching files")).toBeTruthy();
    // And the lazy-load caveat survives: the filter can only see opened dirs.
    expect(screen.getByText(/Filter reaches opened folders/)).toBeTruthy();
  });
});

describe("formatBytes", () => {
  it("names sizes the way the states quote them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(840 * 1024)).toBe("840 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});
