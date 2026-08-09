import { describe, expect, it } from "vitest";
import { presentCapabilities } from "../src/renderer/compatibility/capabilityPresentation";
import { presentThreadList } from "../src/renderer/compatibility/conversationPresentation";
import { presentDelivery } from "../src/renderer/compatibility/deliveryPresentation";
import {
  presentFileEntries,
  presentFileRead,
} from "../src/renderer/compatibility/filePresentation";
import { presentOutbox } from "../src/renderer/compatibility/outboxPresentation";
import { presentReviewNotes } from "../src/renderer/compatibility/reviewPresentation";
import type { ThreadListEntry } from "../src/shared/ipc";

describe("renderer compatibility adapters", () => {
  it("copies capability collections without sharing item arrays", () => {
    const source = {
      plugins: { status: "ready" as const, items: [] },
      mcpServers: {
        status: "error" as const,
        items: [],
        message: "unavailable",
      },
    };

    const result = presentCapabilities(source);

    expect(result).toEqual(source);
    expect(result.plugins.items).not.toBe(source.plugins.items);
    expect(result.mcpServers.items).not.toBe(source.mcpServers.items);
  });

  it("projects application activity into the current sidebar status", () => {
    const source: ThreadListEntry = {
      threadId: "thread-1",
      name: "Review",
      preview: "Waiting",
      cwd: "/repo",
      projectId: null,
      run: {
        kind: "waiting",
        turnId: "turn-1",
        requestId: "request-1",
        reason: "approval",
      },
      pinned: false,
      archived: false,
      unread: true,
      updatedAtMs: 10,
      worktreePath: null,
      checkout: { kind: "notRequested" },
      loaded: true,
    };

    expect(presentThreadList([source])[0]).toMatchObject({
      threadId: "thread-1",
      status: "waitingOnApproval",
      unread: true,
    });
  });

  it("projects delivery stages and recovery into current labels", () => {
    const result = presentDelivery({
      next: "pullRequest",
      branch: "feature",
      defaultBranch: "main",
      remote: "origin",
      upstream: "origin/feature",
      files: [],
      changes: [],
      additions: 0,
      deletions: 0,
      committedSha: "abc",
      pushed: true,
      prUrl: null,
      issue: {
        stage: "pullRequest",
        cause: "authentication",
        recovery: "userAction",
        detail: "Sign in",
      },
      busy: false,
    });

    expect(result).toMatchObject({
      step: "pr",
      notice: {
        title: "GitHub sign-in needed",
        detail: "Sign in",
        recoverable: true,
      },
    });
  });

  it("projects file contracts without exposing filesystem infrastructure", () => {
    expect(
      presentFileEntries([
        {
          path: "/repo/src",
          name: "src",
          kind: "directory",
          presentation: null,
        },
      ]),
    ).toEqual([{ path: "/repo/src", name: "src", isDirectory: true }]);
    expect(
      presentFileRead({
        kind: "external",
        presentation: {
          mode: "external",
          family: "archive",
          mediaType: "application/zip",
          size: 128,
        },
      }),
    ).toEqual({ kind: "external", family: "archive", bytes: 128 });
  });

  it("projects outbox dispatch state and preserves assets", () => {
    const result = presentOutbox({
      entries: [
        {
          id: "entry-1",
          text: "Continue",
          createdAt: 20,
          assets: [
            {
              id: "asset-1",
              kind: "file",
              name: "notes.txt",
              path: "/repo/notes.txt",
            },
          ],
          schedule: "afterTurn",
          lastFailure: null,
        },
      ],
      dispatch: {
        kind: "deferred",
        reason: "turnNotSteerable",
        detail: "review",
      },
      capacity: 8,
    });

    expect(result).toMatchObject({
      messages: [{ id: "entry-1", text: "Continue" }],
      steer: { kind: "notSteerable", turnKind: "review" },
      capacity: 8,
    });
    expect(result.messages[0]?.attachments).toEqual([
      {
        id: "asset-1",
        kind: "file",
        name: "notes.txt",
        path: "/repo/notes.txt",
      },
    ]);
  });

  it("projects review anchors into current comment cards", () => {
    const result = presentReviewNotes([
      {
        id: "note-1",
        originConversationId: "thread-1",
        anchor: {
          path: "src/old.ts",
          side: "after",
          span: { start: 2, end: 3 },
          contextDigest: "digest",
          context: {
            before: ["before"],
            selected: ["one", "two"],
            after: ["after"],
          },
          baseRevision: "base",
        },
        body: "Please revise",
        assets: [],
        resolution: "moved",
        currentLocation: {
          path: "src/new.ts",
          side: "after",
          span: { start: 8, end: 9 },
          sectionId: "section-1",
        },
        createdAt: 30,
      },
    ]);

    expect(result).toEqual([
      {
        commentId: "note-1",
        filePath: "src/new.ts",
        side: "right",
        startLine: 8,
        endLine: 9,
        hunkId: "section-1",
        commentText: "Please revise",
        quotedLines: ["one", "two"],
        stale: false,
        createdAtMs: 30,
      },
    ]);
  });
});
