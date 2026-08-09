import { describe, expect, it } from "vitest";
import {
  buildTranscriptRows,
  hasReasoningBody,
} from "../src/renderer/main_window/transcriptRows";

/**
 * Dropping hollowed-out reasoning from resumed threads.
 *
 * app-server persists a reasoning summary's **bold heading but not its
 * prose**. A turn that streamed a dozen thoughts therefore reloads as a dozen
 * bare titles with nothing under them — more vertical space than the tool
 * trace they sit in, and less information. The predicate keeps only summaries
 * that retain meaningful body text.
 */
describe("hasReasoningBody", () => {
  it("rejects a heading with nothing under it", () => {
    // The exact shape a resumed thread leaves behind.
    expect(hasReasoningBody("**Planning parallel TypeScript checks**")).toBe(
      false,
    );
    expect(hasReasoningBody("**A**\n\n**B**\n")).toBe(false);
    expect(hasReasoningBody("")).toBe(false);
    expect(hasReasoningBody("   \n\n ")).toBe(false);
  });

  it("keeps a heading that has prose under it", () => {
    const live = [
      "**Analyzing navigation bar request**",
      "",
      "The user suggested a vertical navigation bar between the sidebar and",
      "chat. I noticed the hover tooltip from the image.",
    ].join("\n");
    expect(hasReasoningBody(live)).toBe(true);
  });

  it("keeps prose with no heading at all", () => {
    // `content` (raw reasoning) has no headings; it must not be discarded.
    expect(hasReasoningBody("I should check the resume path first.")).toBe(
      true,
    );
  });
});

describe("reasoning in the transcript", () => {
  const reasoning = (id: string, summary: string[]) => ({
    kind: "item" as const,
    id,
    turnId: "turn-1",
    item: { type: "reasoning" as const, id, summary, content: [] },
  });

  const tool = (id: string) => ({
    kind: "item" as const,
    id,
    turnId: "turn-1",
    item: {
      type: "mcpToolCall" as const,
      id,
      server: "node_repl",
      tool: "js",
      status: "completed",
      arguments: { title: "Read files" },
    },
  });

  it("drops heading-only reasoning entirely", () => {
    const rows = buildTranscriptRows([
      reasoning("r-1", ["**Planning parallel TypeScript checks**"]),
      reasoning("r-2", ["**Investigating workspace project consistency**"]),
      tool("m-1"),
    ] as never);

    // The tool row is the trajectory and stays; the titles are gone.
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.entries.map((e) => e.id)).toEqual([
      "m-1",
    ]);
  });

  it("shows no Worked group when a turn has only hollow reasoning", () => {
    // Filtering at render time instead would still create the group, leaving
    // a disclosure that expands to nothing.
    const rows = buildTranscriptRows([
      reasoning("r-1", ["**Planning parallel TypeScript checks**"]),
    ] as never);
    expect(rows).toEqual([]);
  });

  it("keeps reasoning that still has its prose", () => {
    const rows = buildTranscriptRows([
      reasoning("r-1", ["**Tracing the bug**\n\nI'll read the resume path."]),
    ] as never);
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.entries).toHaveLength(1);
  });

  it("keeps a live item whose prose is still streaming", () => {
    // The regression this nearly shipped with: a reasoning item's stored
    // `summary` is empty until it completes, so filtering on the stored value
    // alone drops every thought mid-stream and pops it back at the end.
    const rows = buildTranscriptRows(
      [reasoning("r-1", [])] as never,
      { "r-1": { reasoningSummary: { 0: "**Tracing**\n\nReading…" } } },
    );
    const work = rows.find((r) => r.kind === "work");
    expect(work?.kind === "work" && work.entries).toHaveLength(1);
  });
});
