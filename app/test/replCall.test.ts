import { describe, expect, it } from "vitest";
import {
  isReplCall,
  replSource,
  replTitle,
} from "../src/renderer/main_window/replCall";

/**
 * Labelling `node_repl` tool calls.
 *
 * Fixtures are verbatim from the local session store, not invented shapes.
 * That distinction matters here: an earlier version of this module parsed the
 * JS looking for `tools.exec_command(…)` call sites, and passed a suite full
 * of invented programs while decoding *nothing* in the real ones — they
 * contain no such calls. Probing the actual data showed the agent labels its
 * own programs with `title`, one field away.
 */
describe("node_repl labels", () => {
  it("only claims node_repl calls", () => {
    expect(isReplCall("node_repl")).toBe(true);
    expect(isReplCall("codex_apps")).toBe(false);
  });

  it("uses the title the agent wrote", () => {
    // Verbatim arguments from thread 019fa690, the one in the bug report.
    const args = {
      code: "var browserDocFull = await browser.documentation(); nodeRepl.write(browserDocFull.length);",
      title: "Check browser guide",
      timeout_ms: 10000,
    };
    expect(replTitle(args)).toBe("Check browser guide");
    expect(replSource(args)).toBe(args.code);
  });

  it("returns null when there is no title, so the caller can fall back", () => {
    // `js_add_node_module_dir` takes only a path — 15 of 220 calls locally.
    // A blank row would be worse than an honest `node_repl · js`.
    expect(replTitle({ path: "/some/dir" })).toBeNull();
    expect(replTitle({ title: "   " })).toBeNull();
    expect(replTitle({ title: 42 })).toBeNull();
    expect(replTitle(null)).toBeNull();
  });

  it("bounds a model-authored title", () => {
    const long = "x".repeat(400);
    expect(replTitle({ title: long })!.length).toBe(120);
  });

  it("finds the program under the field names actually used", () => {
    // `code` is what app-server sends; the others are defensive.
    expect(replSource({ code: "a" })).toBe("a");
    expect(replSource({ input: "b" })).toBe("b");
    expect(replSource("bare")).toBe("bare");
    expect(replSource({ nothing: 1 })).toBeNull();
  });
});
