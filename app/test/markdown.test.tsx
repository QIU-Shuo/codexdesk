import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  FileRefProvider,
  Markdown,
  parseFileTarget,
  parseMarkdown,
  splitInline,
  splitRow,
} from "../src/renderer/main_window/Markdown";

/**
 * File citations in agent messages.
 *
 * Agents cite their evidence as `[agents.py](/abs/path/agents.py:345)`.
 * Before this, a non-`http` link fell through to literal markdown text, so
 * the most useful thing in a reply — the pointer to the exact line — was the
 * least readable thing on screen.
 */
afterEach(cleanup);

describe("parseFileTarget", () => {
  it("splits a path from its line, in both forms agents emit", () => {
    expect(parseFileTarget("/a/b/agents.py:345")).toEqual({
      path: "/a/b/agents.py",
      line: 345,
    });
    expect(parseFileTarget("/a/b/agents.py#L345")).toEqual({
      path: "/a/b/agents.py",
      line: 345,
    });
  });

  it("accepts a path with no line", () => {
    expect(parseFileTarget("/a/b/agents.py")).toEqual({
      path: "/a/b/agents.py",
    });
    expect(parseFileTarget("doc/plan.md")).toEqual({ path: "doc/plan.md" });
    expect(parseFileTarget("./src/a.ts")).toEqual({ path: "./src/a.ts" });
  });

  it("keeps a Windows drive letter out of the line number", () => {
    // `C:` would parse as a line if the digits were not anchored to the end.
    expect(parseFileTarget("C:/src/a.ts")).toEqual({ path: "C:/src/a.ts" });
    expect(parseFileTarget("C:/src/a.ts:12")).toEqual({
      path: "C:/src/a.ts",
      line: 12,
    });
  });

  it("refuses anything that is not a path", () => {
    // A bare word is more likely prose; guessing turns text into dead links.
    expect(parseFileTarget("README")).toBeNull();
    expect(parseFileTarget("")).toBeNull();
    // Other schemes are handled elsewhere or not at all — never as files.
    expect(parseFileTarget("https://example.com/a/b")).toBeNull();
    expect(parseFileTarget("file:///etc/passwd")).toBeNull();
  });
});

describe("file citation rendering", () => {
  const cite = "See [agents.py](/repo/codexdesk/agents.py:345) for the installer.";

  it("emits a file span rather than literal markdown", () => {
    const spans = splitInline(cite);
    expect(spans.some((s) => s.kind === "file")).toBe(true);
    // The bug this replaces: the whole `[label](target)` token as raw text.
    expect(spans.some((s) => s.kind === "text" && /\]\(/.test(s.text))).toBe(
      false,
    );
  });

  it("opens the file at its line when clicked", async () => {
    const onOpenFile = vi.fn();
    render(
      <FileRefProvider onOpenFile={onOpenFile}>
        <Markdown text={cite} />
      </FileRefProvider>,
    );

    const link = screen.getByRole("button", { name: /agents\.py/ });
    expect(link.getAttribute("title")).toBe("/repo/codexdesk/agents.py:345");
    await act(async () => link.click());
    expect(onOpenFile).toHaveBeenCalledWith("/repo/codexdesk/agents.py", 345);
  });

  it("renders no navigable URL for a file reference", () => {
    // A `file://` href is a real escape hatch in Electron; the click is a
    // React handler and there must be no anchor to follow.
    render(
      <FileRefProvider onOpenFile={vi.fn()}>
        <Markdown text={cite} />
      </FileRefProvider>,
    );
    expect(document.querySelector("a")).toBeNull();
  });

  it("degrades to plain text with no workbench to open into", () => {
    // Markdown renders in a dozen places; only the transcript has a panel.
    render(<Markdown text={cite} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/agents\.py/)).toBeTruthy();
  });

  it("still treats http links as external links", () => {
    render(
      <FileRefProvider onOpenFile={vi.fn()}>
        <Markdown text="See [docs](https://example.com/x) please." />
      </FileRefProvider>,
    );
    const anchor = document.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/x");
  });
});

/**
 * Regressions found by clicking real citations in the running app, not by
 * reading the code. Both produced a link that looked right and opened
 * nothing.
 */
describe("link target forms agents actually emit", () => {
  it("strips angle brackets around the target", () => {
    // `[label](</abs/path.md:201>)` — markdown's escape for paths with
    // spaces. The brackets used to survive into the path, so the line never
    // parsed and the viewer said the file did not exist.
    expect(parseFileTarget("</repo/doc/plan.md:201>")).toEqual({
      path: "/repo/doc/plan.md",
      line: 201,
    });
    const spans = splitInline("See [line 201](</repo/doc/plan.md:201>).");
    const file = spans.find((s) => s.kind === "file");
    expect(file).toMatchObject({ path: "/repo/doc/plan.md", line: 201 });
  });

  it("ignores a markdown link title", () => {
    expect(parseFileTarget('/repo/a.ts:12 "the installer"')).toEqual({
      path: "/repo/a.ts",
      line: 12,
    });
  });
});

/**
 * Block constructs the hand-rolled parser did not cover.
 *
 * Frequencies below are measured over 2033 real assistant messages from the
 * local session store, not guessed — they are why these five were fixed and
 * strikethrough / autolinks / task lists (0 occurrences) were not.
 */
describe("tables", () => {
  const table = `| Dimension | Current design | Legacy design |
|---|---|---|
| Readability | Clearly better | Minified artifact |
| Feature completeness | Far behind | Much richer |`;

  it("parses a GFM table instead of printing raw pipes", () => {
    // 56 of 2033 messages, 520 raw lines. The single worst rendering gap.
    const blocks = parseMarkdown(table);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "table",
      head: ["Dimension", "Current design", "Legacy design"],
    });
  });

  it("renders real table elements", () => {
    render(<Markdown text={table} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Minified artifact")).toBeTruthy();
    // The failure this replaces.
    expect(screen.queryByText(/\|---\|/)).toBeNull();
  });

  it("reads column alignment from the delimiter row", () => {
    const blocks = parseMarkdown("| L | C | R |\n|:--|:-:|--:|\n| a | b | c |");
    expect(blocks[0]).toMatchObject({ align: ["left", "center", "right"] });
  });

  it("keeps an escaped pipe as cell content", () => {
    // Shell pipelines and union types in cells are common in this codebase.
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("does not mistake ordinary prose for a table", () => {
    // A pipe with no delimiter row underneath is just text.
    const blocks = parseMarkdown("Use a | b to pipe.\nAnother line.");
    expect(blocks[0]?.kind).toBe("p");
  });

  it("pads a ragged row rather than shifting columns left", () => {
    const blocks = parseMarkdown("| a | b | c |\n|---|---|---|\n| 1 | 2 |");
    expect(blocks[0]).toMatchObject({ rows: [["1", "2", ""]] });
  });

  it("renders inline markup inside cells", () => {
    render(
      <Markdown text={"| x |\n|---|\n| **bold** and `code` |"} />,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });
});

describe("nested lists", () => {
  it("preserves indentation instead of flattening", () => {
    // 187 indented bullets were silently promoted to top level. A flattened
    // checklist says something different from what the agent wrote.
    const blocks = parseMarkdown(
      "- top\n  - child one\n    - grandchild\n  - child two\n- second",
    );
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as Extract<typeof blocks[number], { kind: "ul" }>;
    expect(list.items.map((i) => i.text)).toEqual(["top", "second"]);
    expect(list.items[0]?.children?.items.map((i) => i.text)).toEqual([
      "child one",
      "child two",
    ]);
    expect(
      list.items[0]?.children?.items[0]?.children?.items.map((i) => i.text),
    ).toEqual(["grandchild"]);
  });

  it("nests the DOM to match", () => {
    render(<Markdown text={"- top\n  - child"} />);
    const outer = document.querySelector("ul");
    expect(outer?.querySelector("li > ul > li")?.textContent).toBe("child");
  });

  it("starts a new list when the marker kind changes", () => {
    const blocks = parseMarkdown("- bullet\n1. ordered");
    expect(blocks.map((b) => b.kind)).toEqual(["ul", "ol"]);
  });
});

describe("other block gaps", () => {
  it("recurses into nested blockquotes", () => {
    // The inner `>` used to survive as literal text.
    const blocks = parseMarkdown("> outer\n> > inner");
    expect(blocks[0]).toMatchObject({ kind: "quote" });
    const quote = blocks[0] as Extract<typeof blocks[number], { kind: "quote" }>;
    expect(quote.blocks.map((b) => b.kind)).toEqual(["p", "quote"]);
    render(<Markdown text={"> outer\n> > inner"} />);
    expect(document.querySelector("blockquote > blockquote")).toBeTruthy();
  });

  it("treats a four-space block as code, not a paragraph", () => {
    const blocks = parseMarkdown("Text:\n\n    const x = 1;\n\nAfter.");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "code", "p"]);
    expect(blocks[1]).toMatchObject({ text: "const x = 1;" });
  });

  it("does not turn an indented bullet into a code block", () => {
    // The two rules collide at four spaces; the list must win.
    const blocks = parseMarkdown("- a\n    - deep");
    expect(blocks[0]?.kind).toBe("ul");
  });

  it("supports ~~~ fences", () => {
    expect(parseMarkdown("~~~js\nconst a = 1;\n~~~")[0]).toMatchObject({
      kind: "code",
      lang: "js",
    });
  });
});

describe("inline gaps", () => {
  it("renders an image rather than a stray '!' and a file link", () => {
    const spans = splitInline("![alt](https://x/a.png)");
    expect(spans).toEqual([
      { kind: "image", alt: "alt", src: "https://x/a.png" },
    ]);
    render(<Markdown text="![alt](https://x/a.png)" />);
    expect(screen.getByAltText("alt").getAttribute("src")).toBe(
      "https://x/a.png",
    );
  });

  it("shows alt text for an image it will not load", () => {
    // A local path needs a main-process read; a `file://` src is the escape
    // hatch the `file` span exists to avoid.
    render(<Markdown text="![a diagram](/tmp/local.png)" />);
    expect(screen.getByText("a diagram")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps bold intact across an inner asterisk", () => {
    // `**a * b**` used to mangle into text/em/text: the `*` rule matched first.
    expect(splitInline("**a * b**")).toEqual([{ kind: "strong", text: "a * b" }]);
  });

  it("allows balanced parens in a link target", () => {
    // `[fn](/a/b(1).ts:12)` truncated at the first ')', losing path and line.
    const spans = splitInline("[fn](/a/b(1).ts:12)");
    expect(spans[0]).toMatchObject({
      kind: "file",
      path: "/a/b(1).ts",
      line: 12,
    });
  });
});
