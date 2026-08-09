import { describe, expect, it } from "vitest";
import { ReviewNoteService } from "../src/application/domains/review/ReviewNoteService";
import type { ReviewDocument } from "../src/application/domains/review/ReviewAnchor";

function section(
  path: string,
  lines: string[],
  options: { previousPath?: string; start?: number } = {},
): ReviewDocument {
  const start = options.start ?? 1;
  return {
    files: [
      {
        path,
        previousPath: options.previousPath ?? null,
        before: [],
        after: [
          {
            id: `${path}:0`,
            lines: lines.map((text, index) => ({
              number: start + index,
              text,
            })),
          },
        ],
      },
    ],
  };
}

function harness() {
  let sequence = 0;
  return new ReviewNoteService(
    () => `note-${++sequence}`,
    () => 10,
  );
}

describe("ReviewNoteService", () => {
  it("creates a normalized content anchor with surrounding context", () => {
    const service = harness();
    const note = service.create(
      section("src/app.ts", ["before", "selected a", "selected b", "after"]),
      "conversation-1",
      {
        path: "src/app.ts",
        side: "after",
        span: { start: 3, end: 2 },
        body: "Combine these.",
      },
      "abc123",
    );

    expect(note).toMatchObject({
      id: "note-1",
      originConversationId: "conversation-1",
      anchor: {
        path: "src/app.ts",
        span: { start: 2, end: 3 },
        context: {
          before: ["before"],
          selected: ["selected a", "selected b"],
          after: ["after"],
        },
        baseRevision: "abc123",
      },
      resolution: "located",
      currentLocation: { sectionId: "src/app.ts:0" },
    });
    expect(note?.anchor.contextDigest).toMatch(/^fnv1a32:/);
  });

  it("rejects a range that is not present", () => {
    expect(
      harness().create(
        section("src/app.ts", ["one"]),
        "conversation-1",
        {
          path: "src/app.ts",
          side: "after",
          span: { start: 8, end: 8 },
          body: "Missing",
        },
        null,
      ),
    ).toBeNull();
  });

  it("follows content after an insertion without changing its original anchor", () => {
    const service = harness();
    const note = service.create(
      section("src/app.ts", ["one", "target", "three"], { start: 10 }),
      "conversation-1",
      {
        path: "src/app.ts",
        side: "after",
        span: { start: 11, end: 11 },
        body: "Rename this.",
      },
      null,
    )!;

    const [moved] = service.relocate(
      [note],
      section("src/app.ts", ["inserted", "one", "target", "three"], {
        start: 10,
      }),
    );
    expect(moved).toMatchObject({
      resolution: "moved",
      anchor: { span: { start: 11, end: 11 } },
      currentLocation: { span: { start: 12, end: 12 } },
    });
  });

  it("follows a unique anchor across a file rename", () => {
    const service = harness();
    const note = service.create(
      section("src/old.ts", ["unique"]),
      "conversation-1",
      {
        path: "src/old.ts",
        side: "after",
        span: { start: 1, end: 1 },
        body: "Keep this.",
      },
      null,
    )!;
    const [moved] = service.relocate(
      [note],
      section("src/new.ts", ["unique"], { previousPath: "src/old.ts" }),
    );
    expect(moved).toMatchObject({
      resolution: "moved",
      currentLocation: { path: "src/new.ts" },
    });
  });

  it("represents duplicate matches as ambiguous", () => {
    const service = harness();
    const note = service.create(
      section("src/old.ts", ["same"]),
      "conversation-1",
      {
        path: "src/old.ts",
        side: "after",
        span: { start: 1, end: 1 },
        body: "Which one?",
      },
      null,
    )!;
    const [ambiguous] = service.relocate(
      [note],
      section("src/new.ts", ["same", "gap", "same"], {
        previousPath: "src/old.ts",
      }),
    );
    expect(ambiguous).toMatchObject({
      resolution: "ambiguous",
      currentLocation: null,
    });
  });

  it("uses nearby context to distinguish otherwise identical text", () => {
    const service = harness();
    const note = service.create(
      section("src/app.ts", ["alpha", "same", "omega"]),
      "conversation-1",
      {
        path: "src/app.ts",
        side: "after",
        span: { start: 2, end: 2 },
        body: "This occurrence.",
      },
      null,
    )!;
    const [moved] = service.relocate(
      [note],
      section("src/app.ts", ["same", "gap", "alpha", "same", "omega"]),
    );
    expect(moved).toMatchObject({
      resolution: "moved",
      currentLocation: { span: { start: 4, end: 4 } },
    });
  });

  it("keeps the note and marks its location missing when content disappears", () => {
    const service = harness();
    const note = service.create(
      section("src/app.ts", ["target"]),
      "conversation-1",
      {
        path: "src/app.ts",
        side: "after",
        span: { start: 1, end: 1 },
        body: "Do not lose this.",
      },
      null,
    )!;
    const [missing] = service.relocate([note], { files: [] });
    expect(missing).toMatchObject({
      body: "Do not lose this.",
      resolution: "missing",
      currentLocation: null,
    });
  });

  it("composes ordinary review input and labels unresolved notes", () => {
    const service = harness();
    const note = service.create(
      section("src/app.ts", ["target"]),
      "conversation-1",
      {
        path: "src/app.ts",
        side: "after",
        span: { start: 1, end: 1 },
        body: "Rename this.",
      },
      null,
    )!;
    const [missing] = service.relocate([note], { files: [] });
    const message = service.compose([missing], "Please address this:");
    expect(message).toContain("Please address this:");
    expect(message).toContain("src/app.ts");
    expect(message).toContain("target");
    expect(message).toContain("Rename this.");
    expect(message).toContain("no longer in the diff");
  });
});
