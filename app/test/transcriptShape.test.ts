import { describe, expect, it } from "vitest";
import {
  buildTranscriptRows,
  buildWorkSections,
  endsSpeakerRun,
  speakerOf,
  startsSpeakerRun,
  type TranscriptRow,
} from "../src/renderer/main_window/transcriptRows";
import { diffStat, displayPath } from "../src/renderer/main_window/ItemView";

/**
 * The shape of a turn, as the Aperture transcript draws it.
 *
 * The fixtures below are the fields these functions read, not whole protocol
 * items, and are cast at each call site — the same shortcut the other
 * transcript tests take. Filling in every unread field would triple the file
 * and say nothing about what is under test.
 *
 * Three pure pieces sit under the redesign: who a row belongs to, where a
 * speaker's name is allowed to appear, and how a turn's work divides into
 * the preamble-headed sections the rows hang off. All three are decided
 * without a DOM, which is why they are tested here rather than through a
 * render.
 */

const userMessage = (id: string) => ({
  kind: "item",
  id,
  turnId: "turn-1",
  item: { type: "userMessage", id, content: [] },
});

const commentary = (id: string, text: string) => ({
  kind: "item",
  id,
  turnId: "turn-1",
  item: { type: "agentMessage", id, text, phase: "commentary" },
});

const thought = (id: string, summary: string) => ({
  kind: "item",
  id,
  turnId: "turn-1",
  item: { type: "reasoning", id, summary: [summary], content: [] },
});

const command = (id: string) => ({
  kind: "item",
  id,
  turnId: "turn-1",
  item: { type: "commandExecution", id, command: "ls", status: "completed" },
});

describe("who a row belongs to", () => {
  it("splits the transcript into exactly two speakers", () => {
    // The redesign's central claim: you and Codex, and no third voice. Work
    // is part of Codex's turn rather than a speaker of its own.
    expect(speakerOf(userMessage("u1") as never)).toBe("user");
    expect(speakerOf(command("c1") as never)).toBe("codex");
    expect(
      speakerOf({ kind: "work", id: "w", turnId: "t", entries: [] } as never),
    ).toBe("codex");
  });

  it("attributes an approval request to Codex, since it is Codex asking", () => {
    // Addressed *to* the user, but not said by them — putting it on the
    // user's side would make the transcript claim they asked themselves.
    expect(speakerOf({ kind: "request", request: {} } as never)).toBe("codex");
  });

  it("gives a reconnect notice no speaker at all", () => {
    // The app is not a participant. A row it emits keeps the alignment
    // column but leaves the name empty.
    expect(speakerOf({ kind: "retry", message: "…" } as never)).toBe(null);
  });
});

describe("where the speaker's name is drawn", () => {
  const rows = [
    userMessage("u1"),
    command("c1"),
    command("c2"),
    userMessage("u2"),
  ] as never as TranscriptRow[];

  it("names a speaker once, at the top of their run", () => {
    expect(rows.map((_, i) => startsSpeakerRun(rows, i))).toEqual([
      true, // You
      true, // Codex
      false, // …still Codex; repeating the name is noise
      true, // You again
    ]);
  });

  it("closes a speaker run only after its final row", () => {
    expect(rows.map((_, i) => endsSpeakerRun(rows, i))).toEqual([
      true, // user → Codex: full conversation gap
      false, // work → final answer: compact in-turn gap
      true, // Codex → user: full conversation gap
      true,
    ]);
  });

  it("never names a row that has no speaker", () => {
    const withRetry = [
      command("c1"),
      { kind: "retry", message: "…" },
    ] as never as TranscriptRow[];
    expect(startsSpeakerRun(withRetry, 1)).toBe(false);
  });
});

describe("splitting a turn into preamble-headed sections", () => {
  it("hangs a run of steps off the sentence that introduced it", () => {
    const sections = buildWorkSections([
      commentary("p1", "Finding where tool calls render."),
      command("c1"),
      command("c2"),
      commentary("p2", "Now giving them the same treatment."),
      command("c3"),
    ] as never);

    expect(
      sections.map((s) => [s.preamble?.id, s.steps.map((e) => e.id)]),
    ).toEqual([
      ["p1", ["c1", "c2"]],
      ["p2", ["c3"]],
    ]);
  });

  it("keeps thinking inside the current section and starts a new one only for commentary", () => {
    const sections = buildWorkSections([
      commentary("p1", "I'll inspect the renderer first."),
      thought("r1", "**Comparing the message phases.**"),
      command("c1"),
      commentary("p2", "I have the relevant code; now I'll verify the fix."),
      thought("r2", "**Checking the regression coverage.**"),
      command("c2"),
    ] as never);

    expect(
      sections.map((s) => [s.preamble?.id, s.steps.map((e) => e.id)]),
    ).toEqual([
      ["p1", ["r1", "c1"]],
      ["p2", ["r2", "c2"]],
    ]);
  });

  it("keeps consecutive commentary as separate, content-preserving sections", () => {
    const sections = buildWorkSections([
      commentary("p1", "First narration."),
      commentary("p2", "Second narration."),
      command("c1"),
    ] as never);

    expect(sections.map((s) => s.preamble?.id)).toEqual(["p1", "p2"]);
    expect(sections[1]?.steps.map((e) => e.id)).toEqual(["c1"]);
  });

  it("gives work that nobody narrated a section with no heading", () => {
    // A turn that went straight to a tool call. The section exists to hold
    // the steps so they still get the indent every other step row has.
    const sections = buildWorkSections([command("c1"), command("c2")] as never);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.preamble).toBe(null);
    expect(sections[0]?.steps.map((e) => e.id)).toEqual(["c1", "c2"]);
  });

  it("returns nothing for a turn that did nothing", () => {
    expect(buildWorkSections([])).toEqual([]);
  });
});

describe("what counts as a turn's work", () => {
  const fileChange = (id: string) => ({
    kind: "item",
    id,
    turnId: "turn-1",
    item: { type: "fileChange", id, status: "completed", changes: [] },
  });

  it("keeps a patch inside the disclosure, as a step of the section that made it", () => {
    // A patch used to sit in the main transcript as a "result". An agent
    // editing one file twenty times then produced twenty full-width rows
    // *outside* the collapsed card — the turn's trajectory tidied itself away
    // and its most repetitive part stayed on screen.
    const sections = buildWorkSections([
      commentary("p1", "Rewriting the reset."),
      fileChange("f1"),
      fileChange("f2"),
    ] as never);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.steps.map((e) => e.id)).toEqual(["f1", "f2"]);
  });

  it("leaves the final answer out of the work entirely", () => {
    // The answer is the summary the collapsed row sits under; grouping it in
    // would hide the one thing that must never be behind a toggle.
    const rows = buildTranscriptRows([
      commentary("p1", "Working on it."),
      fileChange("f1"),
      {
        kind: "item",
        id: "final",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "final",
          text: "Done.",
          phase: "final_answer",
        },
      },
    ] as never);

    expect(rows.map((r) => r.kind)).toEqual(["work", "item"]);
    expect(rows[1]).toMatchObject({ id: "final" });
  });

  it("preserves the exact turn duration on a reloaded work receipt", () => {
    const rows = buildTranscriptRows([
      { ...command("c1"), turnDurationMs: 72_000 },
    ] as never);

    expect(rows[0]).toMatchObject({
      kind: "work",
      turnId: "turn-1",
      durationMs: 72_000,
    });
  });

  it("attaches a pending approval to the turn it pauses", () => {
    const request = {
      requestId: "approval-1",
      receivedAtMs: 2_000,
      threadId: "thread-1",
      kind: "commandApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 2_000,
        environmentId: null,
        command: "npm test",
      },
    };
    const rows = buildTranscriptRows([
      commentary("p1", "I’m checking the suite."),
      { kind: "request", id: "request-1", request },
    ] as never);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      turnId: "turn-1",
      pendingRequests: [request],
    });
  });

  it("creates a waiting turn when a request arrives before any work item", () => {
    const request = {
      requestId: "input-1",
      receivedAtMs: 2_000,
      threadId: "thread-1",
      kind: "userInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [],
        autoResolutionMs: null,
      },
    };
    const rows = buildTranscriptRows([
      { kind: "request", id: "request-1", request },
    ] as never);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      turnId: "turn-1",
      entries: [],
      pendingRequests: [request],
    });
  });
});

describe("shortening a path for display", () => {
  const root = "/Users/q/wsp/CodexDesk";

  it("drops the workspace prefix, since every row repeats it", () => {
    // The directory is what gives up width first, so an absolute path spends
    // the row's flexible space on the forty characters two rows have in
    // common and ellipsizes the part that differs.
    expect(displayPath(`${root}/app/src/index.css`, root)).toBe(
      "app/src/index.css",
    );
  });

  it("tolerates a root that already ends in a slash", () => {
    expect(displayPath(`${root}/app/a.ts`, `${root}/`)).toBe("app/a.ts");
  });

  it("leaves a path outside the workspace absolute", () => {
    // A file the agent touched elsewhere is worth showing as elsewhere.
    expect(displayPath("/etc/hosts", root)).toBe("/etc/hosts");
  });

  it("leaves the path alone when there is no workspace", () => {
    expect(displayPath("/etc/hosts", undefined)).toBe("/etc/hosts");
  });
});

describe("reading a diffstat off a patch", () => {
  const diff = [
    "--- a/app/src/index.css",
    "+++ b/app/src/index.css",
    "@@ -1,4 +1,5 @@",
    " .op-row {",
    "-  border-radius: 6px;",
    "+  border-radius: 7px;",
    "+  align-items: baseline;",
    " }",
  ].join("\n");

  it("counts changed lines without counting the file headers", () => {
    // `+++` and `---` start with the same characters as content lines; a
    // naive count reports one extra add and one extra removal on every file.
    expect(diffStat(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("reports nothing for a change that carries no diff", () => {
    // A rename has a kind and a path but no hunks, and must not render a
    // "+0 −0" that implies it touched lines.
    expect(diffStat("")).toEqual({ added: 0, removed: 0 });
  });
});
