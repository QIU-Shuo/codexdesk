import { describe, expect, it } from "vitest";
import type {
  AgentRunState,
  CheckoutState,
  ConversationView,
} from "../src/contracts/views/conversations";
import type { DeliveryProgressView } from "../src/contracts/views/delivery";
import type { FilePresentationView } from "../src/contracts/views/files";
import type { ReviewNoteView } from "../src/contracts/views/review";
import type { WorkspacePlacement } from "../src/contracts/views/workspaces";
import { presentCapabilities } from "../src/renderer/compatibility/capabilityPresentation";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runLabel(state: AgentRunState): string {
  switch (state.kind) {
    case "ready":
    case "running":
    case "waiting":
    case "failed":
    case "offline":
      return state.kind;
  }
}

function checkoutLabel(state: CheckoutState): string {
  switch (state.kind) {
    case "notRequested":
    case "preparing":
    case "available":
    case "failed":
      return state.kind;
  }
}

function placementLabel(state: WorkspacePlacement): string {
  switch (state.kind) {
    case "registered":
    case "unregistered":
    case "unassigned":
      return state.kind;
  }
}

function deliveryLabel(state: DeliveryProgressView): string {
  switch (state.next) {
    case "inspect":
    case "commit":
    case "push":
    case "pullRequest":
    case "done":
      return state.next;
  }
}

function fileLabel(state: FilePresentationView): string {
  switch (state.mode) {
    case "text":
    case "image":
    case "external":
      return state.mode;
  }
}

describe("renderer-safe contracts", () => {
  it("round-trips every contract family through JSON", () => {
    const conversation: ConversationView = {
      id: "conversation-1",
      title: "Refactor",
      executionRoot: "/repo",
      run: { kind: "running", turnId: "turn-1", startedAt: 10 },
      checkout: {
        kind: "available",
        root: "/repo-work",
        sourceRoot: "/repo",
        baseRevision: "abc123",
      },
      outbox: {
        entries: [
          {
            id: "entry-1",
            text: "Continue",
            createdAt: 11,
            assets: [],
            schedule: "now",
            lastFailure: null,
          },
        ],
        dispatch: {
          kind: "sending",
          entryId: "entry-1",
          expectedTurnId: "turn-1",
        },
        capacity: 8,
      },
    };
    const placement: WorkspacePlacement = {
      kind: "registered",
      workspaceId: "workspace-1",
      navigationRoot: "/repo",
    };
    const note: ReviewNoteView = {
      id: "note-1",
      originConversationId: "conversation-1",
      anchor: {
        path: "src/index.ts",
        side: "after",
        span: { start: 4, end: 7 },
        contextDigest: "sha256:example",
        context: {
          before: ["before"],
          selected: ["selected"],
          after: ["after"],
        },
        baseRevision: "abc123",
      },
      body: "Handle the empty case.",
      assets: [{ kind: "path", path: "src/index.ts" }],
      resolution: "located",
      currentLocation: {
        path: "src/index.ts",
        side: "after",
        span: { start: 4, end: 7 },
        sectionId: "src/index.ts:0",
      },
      createdAt: 12,
    };
    const delivery: DeliveryProgressView = {
      next: "push",
      branch: "codexdesk/refactor",
      defaultBranch: "main",
      remote: "origin",
      upstream: null,
      files: [],
      changes: [],
      additions: 3,
      deletions: 1,
      committedSha: "def456",
      pushed: false,
      prUrl: null,
      issue: {
        stage: "push",
        cause: "authentication",
        recovery: "userAction",
        detail: "Sign in and retry.",
      },
      busy: false,
    };
    const file: FilePresentationView = {
      mode: "external",
      family: "archive",
      mediaType: "application/zip",
      size: 42,
    };

    for (const value of [conversation, placement, note, delivery, file]) {
      expect(roundTrip(value)).toEqual(value);
    }
  });

  it("keeps discriminated unions exhaustive", () => {
    expect([
      runLabel({ kind: "offline" }),
      checkoutLabel({ kind: "notRequested" }),
      placementLabel({ kind: "unassigned" }),
      deliveryLabel({
        next: "inspect",
        branch: null,
        defaultBranch: null,
        remote: null,
        upstream: null,
        files: [],
        changes: [],
        additions: 0,
        deletions: 0,
        committedSha: null,
        pushed: false,
        prUrl: null,
        issue: null,
        busy: false,
      }),
      fileLabel({ mode: "text", language: null, size: 0 }),
    ]).toEqual(["offline", "notRequested", "unassigned", "inspect", "text"]);
  });

  it("projects a contract without sharing mutable collection arrays", () => {
    const contract = {
      plugins: { status: "ready" as const, items: [] },
      mcpServers: { status: "idle" as const, items: [] },
    };
    const presentation = presentCapabilities(contract);

    expect(presentation).toEqual(contract);
    expect(presentation).not.toBe(contract);
    expect(presentation.plugins.items).not.toBe(contract.plugins.items);
    expect(presentation.mcpServers.items).not.toBe(contract.mcpServers.items);
  });
});
