import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { DeliveryBar } from "../src/renderer/main_window/DeliveryBar";
import type { CurrentDeliveryView } from "../src/renderer/compatibility/deliveryPresentation";

/**
 * The commit form's file selection (§7.2).
 *
 * One invariant governs this component: **a commit never includes work the
 * user staged for their own reasons.** It has now been broken twice, in two
 * different layers, which is why these tests drive the UI rather than the
 * git helpers underneath it.
 *
 * 1. `splitStagedByOwner` *filtered* pre-staged paths out of the candidate
 *    list. A failed pre-commit hook left the agent's own files staged, they
 *    were reclassified as the user's, and the pane reported nothing to
 *    deliver — unrecoverable from the UI.
 * 2. Replacing that classifier moved the decision into this form, and the
 *    form defaulted every checkbox to ticked. The invariant then had nothing
 *    enforcing it at all.
 *
 * The shape that satisfies both: pre-staged files are **listed and tagged but
 * unticked**. Nothing is hidden, so a wrong guess costs one click rather than
 * a dead end.
 */

afterEach(cleanup);

function view(over: Partial<CurrentDeliveryView> = {}): CurrentDeliveryView {
  return {
    step: "commit",
    repoRoot: "/repo",
    branch: "codexdesk/task",
    defaultBranch: "main",
    remote: "origin",
    upstream: null,
    files: [],
    changes: [],
    additions: 3,
    deletions: 1,
    committedSha: null,
    pushed: false,
    prUrl: null,
    notice: null,
    ...over,
  } as CurrentDeliveryView;
}

/** `src/agent.ts` is ours; `notes.md` the user staged before the task began. */
const MIXED = view({
  files: ["src/agent.ts", "notes.md"],
  changes: [
    { path: "src/agent.ts", untracked: false, staged: false, unstaged: true },
    { path: "notes.md", untracked: false, staged: true, unstaged: false },
  ],
});

function renderBar(delivery: CurrentDeliveryView) {
  const onCommit = vi.fn();
  render(
    <DeliveryBar
      delivery={delivery}
      comments={[]}
      onPrepare={vi.fn()}
      onCommit={onCommit}
      onPush={vi.fn()}
      onCreatePr={vi.fn()}
      onProposeMessage={async () => "a message"}
      onSubmitComments={vi.fn()}
    />,
  );
  return { onCommit };
}

/** The panel starts collapsed. */
async function open() {
  await act(async () => screen.getByText("Ship").click());
}

/** The step indicator also says "Commit", so scope to the action button. */
function commitButton(): HTMLButtonElement {
  return document.querySelector(
    ".delivery-section .row.end button",
  ) as HTMLButtonElement;
}

function boxFor(path: string): HTMLInputElement {
  const label = [...document.querySelectorAll(".file-choice")].find(
    (el) => el.querySelector(".file-path")?.textContent === path,
  )!;
  return label.querySelector("input")!;
}

describe("commit file selection (§7.2)", () => {
  it("leaves a pre-staged file out of the default commit", async () => {
    // The P1: defaulting every box to ticked put the user's staged work in
    // our commit, while the form claimed to be showing them the choice.
    renderBar(MIXED);
    await open();

    expect(boxFor("src/agent.ts").checked).toBe(true);
    expect(boxFor("notes.md").checked).toBe(false);
  });

  it("still lists the pre-staged file, tagged, rather than hiding it", async () => {
    // The failure mode of the *previous* fix. Hiding it is what made a failed
    // hook unrecoverable.
    renderBar(MIXED);
    await open();

    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.getByText("staged")).toBeTruthy();
  });

  it("commits only the ticked paths", async () => {
    const { onCommit } = renderBar(MIXED);
    await open();
    await act(async () => commitButton().click());

    expect(onCommit).toHaveBeenCalledWith("a message", ["src/agent.ts"]);
  });

  it("includes a pre-staged file when the user asks for it", async () => {
    const { onCommit } = renderBar(MIXED);
    await open();
    await act(async () => boxFor("notes.md").click());
    await act(async () => commitButton().click());

    expect(onCommit).toHaveBeenCalledWith("a message", [
      "src/agent.ts",
      "notes.md",
    ]);
  });

  it("counts only what will actually be committed", async () => {
    // "Commit 2 of 2 files" while committing one is the same class of lie as
    // the original bug, which said three and committed four.
    renderBar(MIXED);
    await open();
    expect(screen.getByText(/Commit 1 of 2 files/)).toBeTruthy();
  });

  it("ticks a file that is staged but modified since", async () => {
    // `MM`: staged by someone, then changed again. The later edit is the
    // agent's work, and excluding it would drop what we just did.
    renderBar(
      view({
        files: ["src/agent.ts"],
        changes: [
          {
            path: "src/agent.ts",
            untracked: false,
            staged: true,
            unstaged: true,
          },
        ],
      }),
    );
    await open();
    expect(boxFor("src/agent.ts").checked).toBe(true);
  });

  it("ticks an untracked file the agent created", async () => {
    renderBar(
      view({
        files: ["src/new.ts"],
        changes: [
          {
            path: "src/new.ts",
            untracked: true,
            staged: false,
            unstaged: false,
          },
        ],
      }),
    );
    await open();
    expect(boxFor("src/new.ts").checked).toBe(true);
  });

  it("explains why a box is unticked", async () => {
    renderBar(MIXED);
    await open();
    expect(screen.getByText(/already staged before this task/)).toBeTruthy();
  });

  it("says nothing about staging when nothing was pre-staged", async () => {
    renderBar(
      view({
        files: ["src/agent.ts"],
        changes: [
          {
            path: "src/agent.ts",
            untracked: false,
            staged: false,
            unstaged: true,
          },
        ],
      }),
    );
    await open();
    expect(screen.queryByText(/already staged before this task/)).toBeNull();
  });

  it("refuses to commit when the user unticks everything", async () => {
    renderBar(MIXED);
    await open();
    await act(async () => boxFor("src/agent.ts").click());

    expect(commitButton().disabled).toBe(true);
  });
});
