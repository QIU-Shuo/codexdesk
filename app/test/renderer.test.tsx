import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/main_window/App";
import { ItemView, WorkDisclosure } from "../src/renderer/main_window/ItemView";
import {
  orderThreads,
  ThreadSidebar,
} from "../src/renderer/main_window/ThreadSidebar";
import { RequestCard } from "../src/renderer/main_window/RequestCard";
import { AutoReviewCard } from "../src/renderer/main_window/AutoReviewCard";
import { buildTranscriptRows } from "../src/renderer/main_window/transcriptRows";
import type {
  AppEvent,
  FuzzyFileSearchResult,
  NewThreadOptions,
  PendingRequest,
  RequestAnswer,
  Snapshot,
  ThreadListEntry,
  ThreadView,
} from "../src/shared/ipc";
import type { CurrentThreadListEntry } from "../src/renderer/compatibility/conversationPresentation";
import type { FileEntryView } from "../src/contracts/views/files";

/**
 * Renderer tests for the two P1 bugs that lived in components rather than in
 * the main process: a draft leaking across threads, and a disabled network
 * request being granted.
 */

function view(threadId: string, draft = ""): ThreadView {
  return {
    threadId,
    cwd: "/repo",
    worktreePath: null,
    name: null,
    entries: [],
    deltas: {},
    outbox: {
      entries: [],
      dispatch: { kind: "idle" },
      capacity: 8,
    },
    draft,
    attachments: [],
    plan: null,
    diff: "",
    budget: { tokenUsage: null, rateLimits: null },
    run: { kind: "ready" },
    checkout: { kind: "notRequested" },
    lastError: null,
    turnIds: [],
    approvalMode: "auto",
    loaded: true,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    preflight: { kind: "ready", version: "0.144.4", warning: null },
    auth: { kind: "signedIn", account: { type: "apiKey" } as never },
    cwd: "/repo",
    recents: [],
    threads: [],
    activeThreadId: null,
    view: null,
    config: {
      models: [],
      permissionProfiles: [],
      skills: { status: "idle", items: [] },
      skillErrors: [],
      currentModel: null,
      currentReasoningEffort: null,
      currentServiceTier: null,
      approvalsReviewer: "user",
      approvalMode: "auto",
      allowedApprovalModes: null,
      webSearchMode: null,
      allowedWebSearchModes: null,
    },
    capabilities: {
      plugins: { status: "idle", items: [] },
      mcpServers: { status: "idle", items: [] },
    },
    notifyMode: "unfocused",
    useWorktrees: false,
    projects: [],
    activeProjectId: null,
    terminalAvailable: false,
    pinnedThreadId: null,
    promptCapture: false,
    ...over,
  };
}

let emit: (ev: AppEvent) => void = () => {};
const savedDrafts: { threadId: string; draft: string }[] = [];
const calls = {
  created: [] as NewThreadOptions[],
  sent: [] as string[],
  interrupted: [] as string[],
  removed: [] as string[],
  steered: [] as string[],
  compacted: [] as string[],
  reviews: [] as { threadId: string; target: unknown }[],
  fileSearches: [] as { query: string; workspaceRoot?: string }[],
  edited: [] as { id: string; text: string }[],
  moved: [] as { id: string; to: number }[],
  approvals: [] as string[],
  approvalModes: [] as { threadId: string | null; mode: string }[],
  attachments: [] as {
    threadId: string;
    name: string;
    kind: "image" | "file";
  }[],
  renamed: [] as { id: string; name: string }[],
  redeemed: 0,
  skillToggles: [] as { path: string; enabled: boolean }[],
  pluginToggles: [] as { id: string; enabled: boolean }[],
  webSearchModes: [] as string[],
  opened: [] as string[],
  termClosed: [] as string[],
  notifyModes: [] as string[],
  loggedOut: 0,
};
/** Swapped per test; the bridge closes over it. */
let usageFixture: unknown = null;
let readDirFixture: FileEntryView[] = [];
let sendResult: { queued: boolean; error?: string } = { queued: false };
let newThreadResult: string | null = "new-thread";
let activateNewThreadOnCreate = false;
let fileSearchFixture: FuzzyFileSearchResult[] = [];
let attachmentResults: boolean[] = [];

function installBridge(snap: Snapshot) {
  savedDrafts.length = 0;
  const api = {
    onEvent(cb: (ev: AppEvent) => void) {
      emit = cb;
      return () => {};
    },
    getSnapshot: async () => snap,
    selectWorkspace: async () => null,
    setWorkspace: async () => null,
    readGitBranches: async (cwd: string) => ({
      root: cwd,
      currentBranch: "main",
      defaultBranch: "main",
      branches: ["main", "feature/new-chat"],
      dirtyCount: 2,
    }),
    newThread: async (options: NewThreadOptions) => {
      calls.created.push(options);
      if (activateNewThreadOnCreate && newThreadResult) {
        emit({ type: "activeThread", threadId: newThreadResult });
      }
      return newThreadResult;
    },
    addAttachment: async (
      threadId: string,
      file: { name: string; kind: "image" | "file" },
    ) => {
      calls.attachments.push({
        threadId,
        name: file.name,
        kind: file.kind,
      });
      return (attachmentResults.shift() ?? true)
        ? {
            id: `saved-${calls.attachments.length}`,
            name: file.name,
            kind: file.kind,
            path: `/tmp/${file.name}`,
          }
        : null;
    },
    removeAttachment: async () => {},
    termOpen: async () => true,
    termWrite: async () => {},
    termResize: async () => {},
    termClose: async (id: string) => {
      calls.termClosed.push(id);
    },
    openInNewWindow: async () => {},
    promptCaptureSubmit: async () => null,
    promptCaptureClose: async () => {},
    addProject: async () => [],
    setActiveProject: async () => {},
    removeProject: async () => {},
    readDir: async () => readDirFixture,
    readFile: async () => ({
      kind: "text" as const,
      presentation: {
        mode: "text" as const,
        language: "text",
        size: 0,
      },
      text: "",
    }),
    readImage: async () => null,
    openThread: async (id: string) => {
      calls.opened.push(id);
    },
    closeThread: async () => {},
    renameThread: async (id: string, name: string) => {
      calls.renamed.push({ id, name });
    },
    archiveThread: async () => {},
    deleteThread: async () => {},
    pinThread: async () => {},
    forkThread: async () => null,
    sendMessage: async (_id: string, text: string) => {
      calls.sent.push(text);
      return sendResult;
    },
    saveDraft: async (threadId: string, draft: string) => {
      savedDrafts.push({ threadId, draft });
    },
    removeQueued: async (_id: string, cid: string) => {
      calls.removed.push(cid);
    },
    editQueued: async (_id: string, cid: string, text: string) => {
      calls.edited.push({ id: cid, text });
    },
    moveQueued: async (_id: string, cid: string, to: number) => {
      calls.moved.push({ id: cid, to });
    },
    steerNow: async (id: string) => {
      calls.steered.push(id);
    },
    compactThread: async (id: string) => {
      calls.compacted.push(id);
      return true;
    },
    interrupt: async (id: string) => {
      calls.interrupted.push(id);
    },
    answerRequest: async () => {},
    setNotifyMode: async (mode: string) => {
      calls.notifyModes.push(mode);
    },
    logout: async () => {
      calls.loggedOut += 1;
    },
    readUsage: async () => usageFixture,
    consumeResetCredit: async () => {
      calls.redeemed += 1;
      return true;
    },
    setApprovalsReviewer: async (r: string) => {
      calls.approvals.push(r);
    },
    setApprovalMode: async (threadId: string | null, mode: string) => {
      calls.approvalModes.push({ threadId, mode });
    },
    setUseWorktrees: async () => {},
    startReview: async (threadId: string, target: unknown) => {
      calls.reviews.push({ threadId, target });
      return "review-thread";
    },
    searchFiles: async (query: string, workspaceRoot?: string) => {
      calls.fileSearches.push({ query, workspaceRoot });
      return fileSearchFixture;
    },
    setModel: async () => {},
    setReasoningEffort: async () => {},
    setServiceTier: async () => {},
    // --- capabilities (§4.5 / V2.4) ---
    setSkillEnabled: async (path: string, enabled: boolean) => {
      calls.skillToggles.push({ path, enabled });
    },
    refreshSkills: async () => {},
    setPluginEnabled: async (id: string, enabled: boolean) => {
      calls.pluginToggles.push({ id, enabled });
    },
    refreshCapabilities: async () => {},
    reloadMcpServers: async () => {},
    setWebSearchMode: async (mode: string) => {
      calls.webSearchModes.push(mode);
    },
  };
  (
    globalThis as unknown as { window: { codexDesk: unknown } }
  ).window.codexDesk = api;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  calls.sent.length = 0;
  calls.created.length = 0;
  calls.interrupted.length = 0;
  calls.removed.length = 0;
  calls.steered.length = 0;
  calls.compacted.length = 0;
  calls.reviews.length = 0;
  calls.fileSearches.length = 0;
  calls.edited.length = 0;
  calls.moved.length = 0;
  calls.approvals.length = 0;
  calls.approvalModes.length = 0;
  calls.attachments.length = 0;
  calls.renamed.length = 0;
  calls.opened.length = 0;
  calls.termClosed.length = 0;
  calls.notifyModes.length = 0;
  calls.loggedOut = 0;
  calls.redeemed = 0;
  usageFixture = null;
  readDirFixture = [];
  sendResult = { queued: false };
  newThreadResult = "new-thread";
  activateNewThreadOnCreate = false;
  fileSearchFixture = [];
  attachmentResults = [];
  localStorage.clear();
});

describe("composer send/stop button", () => {
  const action = () =>
    document.querySelector(".composer-action") as HTMLButtonElement;
  const typeInto = async (text: string) => {
    const ta = document.querySelector(
      ".composer textarea",
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("idle + empty → disabled Send", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {});
    expect(action().className).toContain("disabled");
    expect(action().disabled).toBe(true);
  });

  it("idle + typed → Send fires sendMessage", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {});
    await typeInto("hello there");
    expect(action().className).toContain("send");
    await act(async () => action().click());
    expect(calls.sent).toEqual(["hello there"]);
    expect(calls.interrupted).toEqual([]);
  });

  it("running + empty → Stop fires interrupt, not send", async () => {
    const running = {
      ...view("A", ""),
      run: { kind: "running" as const, turnId: "turn-1", startedAt: null },
    };
    installBridge(snapshot({ activeThreadId: "A", view: running }));
    render(<App />);
    await act(async () => {});
    expect(action().className).toContain("stop");
    await act(async () => action().click());
    expect(calls.interrupted).toEqual(["A"]);
    expect(calls.sent).toEqual([]);
  });

  it("running + typed → Send (queues), does not stop", async () => {
    const running = {
      ...view("A", ""),
      run: { kind: "running" as const, turnId: "turn-1", startedAt: null },
    };
    installBridge(snapshot({ activeThreadId: "A", view: running }));
    render(<App />);
    await act(async () => {});
    await typeInto("a follow-up");
    // Typing while running flips the button back to Send.
    expect(action().className).toContain("send");
    await act(async () => action().click());
    expect(calls.sent).toEqual(["a follow-up"]);
    expect(calls.interrupted).toEqual([]);
  });

  it("docks a pending approval above a disabled composer", async () => {
    const pending = {
      requestId: "approval-1",
      receivedAtMs: 0,
      threadId: "A",
      kind: "commandApproval",
      params: {
        threadId: "A",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 0,
        environmentId: null,
        command: "npm test",
      },
    } as PendingRequest;
    const blocked = {
      ...view("A", "do not send this yet"),
      entries: [
        { kind: "request" as const, id: "request-1", request: pending },
      ],
    };
    installBridge(snapshot({ activeThreadId: "A", view: blocked }));
    render(<App />);
    await act(async () => {});

    const dock = document.querySelector(".request-dock")!;
    const composer = document.querySelector(".composer")!;
    const textarea = composer.querySelector("textarea") as HTMLTextAreaElement;
    expect(dock.textContent).toContain("Run a shell command?");
    expect(dock.compareDocumentPosition(composer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(document.querySelector(".transcript .request")).toBeNull();
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe("Waiting on your decision…");
    expect(action().disabled).toBe(true);
  });

  it("opens a projectless draft chat without creating a server thread", async () => {
    const project = {
      id: "p1",
      name: "CodexDesk",
      roots: ["/repo"],
      activeRoot: "/repo",
    };
    const activeRow: ThreadListEntry = {
      threadId: "A",
      name: "Current chat",
      preview: "Current chat",
      cwd: "/repo/worktrees/A",
      projectId: "p1",
      run: { kind: "ready" },
      pinned: false,
      archived: false,
      unread: false,
      updatedAtMs: 1,
      worktreePath: "/repo/worktrees/A",
      checkout: {
        kind: "available",
        root: "/repo/worktrees/A",
        sourceRoot: "/repo",
        baseRevision: "base-sha",
      },
      loaded: true,
    };
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: { ...view("A"), cwd: "/repo/worktrees/A" },
        threads: [activeRow],
        projects: [project],
        activeProjectId: "p1",
      }),
    );
    render(<App />);
    await act(async () => {});

    act(() => screen.getByRole("button", { name: "New chat" }).click());
    expect(screen.getByText("Welcome to CodexDesk")).toBeTruthy();
    expect(document.querySelector(".new-chat-topbar-title")?.textContent).toBe(
      "New chat",
    );
    expect(screen.queryByText("This checkout")).toBeNull();
    expect(document.querySelector(".usage-overview")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Select project: No project/ }),
    ).toBeTruthy();
    expect(calls.created).toEqual([]);

    await typeInto("Build the next thing");
    await act(async () => action().click());
    expect(calls.created).toEqual([
      {
        cwd: "/repo/worktrees/A",
        projectId: null,
        useWorktree: false,
        baseBranch: undefined,
      },
    ]);
    expect(calls.sent).toEqual(["Build the next thing"]);
  });

  it("inherits the active chat's exact root in a multi-root project", async () => {
    const project = {
      id: "p1",
      name: "Monorepo",
      roots: ["/repo", "/repo/tools"],
      activeRoot: "/repo",
    };
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: { ...view("A"), cwd: "/repo/tools" },
        threads: [
          {
            threadId: "A",
            name: "Tools chat",
            preview: "Tools chat",
            cwd: "/repo/tools",
            projectId: "p1",
            run: { kind: "ready" },
            pinned: false,
            archived: false,
            unread: false,
            updatedAtMs: 1,
            worktreePath: null,
            checkout: { kind: "notRequested" },
            loaded: true,
          },
        ],
        projects: [project],
        activeProjectId: "p1",
      }),
    );
    render(<App />);
    await act(async () => {});

    act(() => screen.getByRole("button", { name: "New chat" }).click());
    await typeInto("Continue in this root");
    await act(async () => action().click());

    expect(calls.created[0]?.cwd).toBe("/repo/tools");
  });

  it("stages project-new-chat attachments until the thread is created", async () => {
    const project = {
      id: "p1",
      name: "CodexDesk",
      roots: ["/repo"],
      activeRoot: "/repo",
    };
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A"),
        projects: [project],
        activeProjectId: "p1",
      }),
    );
    render(<App />);
    await act(async () => {});

    act(() => screen.getByRole("button", { name: "New chat" }).click());
    await act(async () =>
      screen
        .getByRole("button", { name: "Add files, mentions, or commands" })
        .click(),
    );
    expect(
      screen.getByRole("option", { name: /Files or photos/ }),
    ).toBeTruthy();
    await act(async () =>
      screen
        .getByRole("button", { name: "Add files, mentions, or commands" })
        .click(),
    );

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    await act(async () =>
      fireEvent.change(document.querySelector(".composer-file-input")!, {
        target: { files: [file] },
      }),
    );
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeTruthy());
    expect(calls.attachments).toEqual([]);

    await typeInto("Use the attached notes");
    await act(async () => action().click());
    expect(calls.attachments).toEqual([
      { threadId: "new-thread", name: "notes.txt", kind: "file" },
    ]);
    expect(calls.sent).toEqual(["Use the attached notes"]);
  });

  it("keeps a rejected new-chat attachment and retries before sending", async () => {
    const project = {
      id: "p1",
      name: "CodexDesk",
      roots: ["/repo"],
      activeRoot: "/repo",
    };
    attachmentResults = [false, true];
    activateNewThreadOnCreate = true;
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A"),
        projects: [project],
        activeProjectId: "p1",
      }),
    );
    render(<App />);
    await act(async () => {});

    act(() => screen.getByRole("button", { name: "New chat" }).click());
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    await act(async () =>
      fireEvent.change(document.querySelector(".composer-file-input")!, {
        target: { files: [file] },
      }),
    );
    await typeInto("Use the attached notes");
    await act(async () => action().click());

    expect(calls.created).toHaveLength(1);
    expect(calls.sent).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not attach notes.txt",
    );
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(
      (document.querySelector(".composer textarea") as HTMLTextAreaElement)
        .value,
    ).toBe("Use the attached notes");

    await act(async () => action().click());

    expect(calls.created).toHaveLength(1);
    expect(calls.attachments).toEqual([
      { threadId: "new-thread", name: "notes.txt", kind: "file" },
      { threadId: "new-thread", name: "notes.txt", kind: "file" },
    ]);
    expect(calls.sent).toEqual(["Use the attached notes"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows repository facts and lets a recent chat be picked up", async () => {
    const project = {
      id: "p1",
      name: "CodexDesk",
      roots: ["/repo"],
      activeRoot: "/repo",
    };
    installBridge(
      snapshot({
        cwd: "/repo",
        projects: [project],
        activeProjectId: "p1",
        threads: [
          {
            threadId: "A",
            name: "Finish the settings panel",
            preview: "Finish the settings panel",
            cwd: "/repo",
            projectId: "p1",
            run: {
              kind: "waiting",
              reason: "approval",
              turnId: "turn-1",
              requestId: "request-1",
            },
            pinned: false,
            archived: false,
            unread: true,
            updatedAtMs: Date.now() - 5 * 60_000,
            worktreePath: null,
            checkout: { kind: "notRequested" },
            loaded: true,
          },
        ],
      }),
    );
    render(<App />);
    await act(async () => {});
    act(() =>
      screen.getByRole("button", { name: "New chat in CodexDesk" }).click(),
    );
    await act(async () => {});

    expect(document.querySelector(".new-chat-topbar-title")?.textContent).toBe(
      "New chat",
    );
    expect(screen.getByText("This checkout")).toBeTruthy();
    expect(screen.getByText("2 dirty files")).toBeTruthy();
    expect(screen.getByText("Pick up")).toBeTruthy();
    expect(document.querySelector(".new-chat-dashboard-primary")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Account usage" })).toBeTruthy();
    expect(document.querySelectorAll(".new-chat-starter")).toHaveLength(0);
    await act(async () =>
      (document.querySelector(".new-chat-pickup") as HTMLButtonElement).click(),
    );
    expect(calls.opened).toEqual(["A"]);
  });

  it("changes project and branch from compact composer selectors", async () => {
    const chatProjects = [
      { id: "p1", name: "CodexDesk", roots: ["/repo"], activeRoot: "/repo" },
      {
        id: "p2",
        name: "Examples",
        roots: ["/examples"],
        activeRoot: "/examples",
      },
    ];
    installBridge(
      snapshot({
        cwd: "/repo",
        projects: chatProjects,
        activeProjectId: "p1",
      }),
    );
    render(<App />);
    await act(async () => {});

    act(() => screen.getByRole("button", { name: "New chat" }).click());
    await act(async () => {});
    act(() =>
      screen
        .getByRole("button", { name: /Select project: No project/ })
        .click(),
    );
    act(() => screen.getByRole("button", { name: "Examples" }).click());
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: /Select project: Examples/ }),
    ).toBeTruthy();

    act(() =>
      screen.getByRole("button", { name: /Select branch: main/ }).click(),
    );
    act(() => screen.getByRole("button", { name: "feature/new-chat" }).click());
    expect(
      screen.getByRole("button", { name: /Select location: Worktree/ }),
    ).toBeTruthy();

    await typeInto("Start from the feature branch");
    await act(async () => action().click());
    expect(calls.created[0]).toEqual({
      cwd: "/examples",
      projectId: "p2",
      useWorktree: true,
      baseBranch: "feature/new-chat",
    });
  });
});

describe("user message attachments", () => {
  /**
   * Images in the chat view. A user message carries its attachments in
   * `content` alongside the text, and the previous rendering flattened the
   * whole array to a string — three pasted screenshots showed as three
   * literal `[localImage]` lines.
   */
  const message = (content: unknown[]) =>
    ({
      type: "userMessage" as const,
      id: "user-1",
      clientId: null,
      content,
    }) as never;

  const stubCodexDesk = (dataUrl: string | null) => {
    (
      window as unknown as {
        codexDesk: { readImage: unknown; openPath: unknown };
      }
    ).codexDesk = {
      readImage: vi.fn().mockResolvedValue(dataUrl),
      openPath: vi.fn(),
    };
  };

  it("renders a local image inline and keeps the text", async () => {
    stubCodexDesk("data:image/png;base64,AAAA");

    await act(async () => {
      render(
        <ItemView
          item={message([
            { type: "text", text: "look at this", text_elements: [] },
            { type: "localImage", path: "/tmp/codex-clipboard-1.png" },
          ])}
        />,
      );
    });

    expect(screen.getByText("look at this")).toBeTruthy();
    const img = await screen.findByAltText("codex-clipboard-1.png");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // The placeholder the old rendering produced must be gone.
    expect(screen.queryByText(/\[localImage\]/)).toBeNull();
  });

  it("degrades to a placeholder when the file is gone", async () => {
    stubCodexDesk(null);

    await act(async () => {
      render(
        <ItemView
          item={message([{ type: "localImage", path: "/tmp/gone.png" }])}
        />,
      );
    });

    // No broken <img>, and the UUID filename stays in the tooltip rather than
    // taking space in the strip.
    await waitFor(() =>
      expect(document.querySelector(".msg-thumb.missing")).toBeTruthy(),
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      document.querySelector(".msg-thumb.missing")?.getAttribute("title"),
    ).toContain("gone.png");
  });

  it("renders skills and mentions as chips, not placeholders", async () => {
    stubCodexDesk(null);

    await act(async () => {
      render(
        <ItemView
          item={message([
            { type: "skill", name: "review", path: "/s/review" },
            { type: "mention", name: "App.tsx", path: "/r/App.tsx" },
          ])}
        />,
      );
    });

    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByText("@App.tsx")).toBeTruthy();
  });

  it("renders server-supplied message text without parsing an envelope", async () => {
    stubCodexDesk("data:image/png;base64,AAAA");
    const text = "Context file: /tmp/input.png\nRequest: add navigation";

    await act(async () => {
      render(
        <ItemView
          item={message([
            { type: "text", text, text_elements: [] },
            { type: "localImage", path: "/tmp/input.png" },
          ])}
        />,
      );
    });

    expect(document.querySelector(".msgbody")?.textContent).toBe(text);
  });

  it("renders images inside the text bubble", async () => {
    stubCodexDesk("data:image/png;base64,AAAA");

    await act(async () => {
      render(
        <ItemView
          item={message([
            { type: "text", text: "look at this", text_elements: [] },
            { type: "localImage", path: "/tmp/a.png" },
          ])}
        />,
      );
    });

    // Attachments and text are one sent prompt, matching the composer block.
    const wrap = document.querySelector(".usermsg")!;
    const kids = [...wrap.children].map((el) => el.className);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toContain("userMessage");
    expect(wrap.querySelector(".item.userMessage .msg-thumb")).toBeTruthy();
  });

  /**
   * The bug that made this invisible in the real app was not in the renderer:
   * the images rendered, and were then blocked by the page CSP, because
   * `img-src` does not inherit from `default-src 'self'` and every image we
   * show is a data URL. No test could see it — jsdom does not enforce CSP and
   * neither does any unit test — so it is asserted against the file.
   */
  it("permits data: images in the page CSP", () => {
    const html = readFileSync("index.html", "utf8");
    const csp = /content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(csp).toMatch(/img-src[^;]*\bdata:/);
    // Still no remote fetches from the renderer.
    expect(csp).toMatch(/default-src 'self'/);
  });
});

describe("reasoning disclosure", () => {
  const reasoning = {
    type: "reasoning" as const,
    id: "reasoning-1",
    summary: [
      "**Comparing the two layouts**\n\nI checked the hierarchy and tightened it.",
    ],
    content: [],
  };

  it("renders completed reasoning as a titled operation with a duration", () => {
    render(
      <ItemView
        item={reasoning}
        active={false}
        startedAtMs={1_000}
        completedAtMs={66_000}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: /Comparing the two layouts.*1m 5s/,
    });
    expect(
      document.querySelector('[data-operation-icon="reasoning"]'),
    ).toBeTruthy();
    expect(
      toggle.querySelector(".op-tail > .op-chevron:last-child"),
    ).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/checked the hierarchy/)).toBeNull();

    act(() => toggle.click());
    expect(screen.getByText(/checked the hierarchy/)).toBeTruthy();
  });
});

describe("agent response actions", () => {
  const response = {
    type: "agentMessage" as const,
    id: "agent-1",
    text: "Implemented **the requested change**.\n\n```ts\nconst ok = true;\n```",
    phase: "final_answer" as const,
    memoryCitation: null,
  };

  it("copies source Markdown and branches from the owning turn", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const branch = vi.fn().mockResolvedValue("forked-thread");

    render(
      <ItemView
        item={response as never}
        turnId="turn-7"
        turnCompleted
        onBranch={branch}
      />,
    );

    await act(async () => screen.getByRole("button", { name: "Copy" }).click());
    expect(writeText).toHaveBeenCalledWith(response.text);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    await act(async () =>
      screen
        .getByRole("button", { name: "Continue in new chat from here" })
        .click(),
    );
    expect(branch).toHaveBeenCalledWith("turn-7");
  });

  it("does not offer checkpoint actions before the turn completes", () => {
    render(
      <ItemView
        item={response as never}
        turnId="turn-live"
        onBranch={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue in new chat from here" }),
    ).toBeNull();
  });

  it("keeps commentary in Work and actions on the final answer", () => {
    const commentary = {
      type: "agentMessage" as const,
      id: "preamble-1",
      text: "I’ll inspect the renderer and protocol phase first.",
      phase: "commentary" as const,
      memoryCitation: null,
    };
    const reasoning = {
      type: "reasoning" as const,
      id: "reasoning-1",
      summary: ["Compared the message phases."],
      content: [],
    };
    const final = {
      type: "agentMessage" as const,
      id: "final-1",
      text: "The phase handling is fixed.",
      phase: "final_answer" as const,
      memoryCitation: null,
    };
    const command = {
      type: "commandExecution" as const,
      id: "command-1",
      command: "rg phase app/src",
      cwd: "/repo",
      status: "completed",
      aggregatedOutput: "2 matches",
    };
    const entries = [
      {
        kind: "item" as const,
        id: commentary.id,
        item: commentary,
        turnId: "turn-1",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      },
      {
        kind: "item" as const,
        id: reasoning.id,
        item: reasoning,
        turnId: "turn-1",
        startedAtMs: 2_000,
        completedAtMs: 4_000,
      },
      {
        kind: "item" as const,
        id: command.id,
        item: command,
        turnId: "turn-1",
        startedAtMs: 4_000,
        completedAtMs: 4_500,
      },
      {
        kind: "item" as const,
        id: final.id,
        item: final,
        turnId: "turn-1",
        startedAtMs: 4_000,
        completedAtMs: 5_000,
      },
    ];
    const rows = buildTranscriptRows(entries as never);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "work", turnId: "turn-1" });
    expect(rows[1]).toMatchObject({ kind: "item", id: "final-1" });

    render(
      <>
        <WorkDisclosure
          entries={
            (rows[0] as Extract<(typeof rows)[number], { kind: "work" }>)
              .entries
          }
          deltas={{}}
          workComplete
        />
        <ItemView
          item={final as never}
          turnId="turn-1"
          turnCompleted
          onBranch={vi.fn()}
        />
      </>,
    );

    expect(screen.queryByText(/inspect the renderer/)).toBeNull();
    expect(screen.getByText("The phase handling is fixed.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
    expect(
      screen.getAllByRole("button", {
        name: "Continue in new chat from here",
      }),
    ).toHaveLength(1);

    // Opening the turn reveals only the commentary preamble. Reasoning is an
    // operation in that section, so its title stays hidden with the command.
    act(() => screen.getByRole("button", { name: /Worked.*4s/ }).click());
    expect(screen.getByText(/inspect the renderer/)).toBeTruthy();
    expect(screen.queryByText(/Compared the message phases/)).toBeNull();
    expect(screen.queryByText(/Ran a command/)).toBeNull();

    // Opening that section reveals both thinking and the command as sibling
    // operations beneath the same preamble.
    act(() =>
      screen.getByRole("button", { name: /inspect the renderer/ }).click(),
    );
    expect(screen.getByText(/Compared the message phases/)).toBeTruthy();
    expect(screen.getByText(/Ran a command/)).toBeTruthy();
  });

  /**
   * Item coverage (§9.1). Six `ThreadItem` variants were missing from
   * `RENDERED`, and because the `unrendered:` placeholder sits *inside* the
   * collapsed work disclosure, they did not even appear as placeholders —
   * they vanished. A trajectory that read a skill, viewed an image and
   * reconnected showed none of it.
   */
  describe("item coverage", () => {
    const entry = (item: unknown) => ({
      kind: "item" as const,
      id: (item as { id: string }).id,
      item,
      turnId: "turn-1",
    });

    it("renders every ThreadItem variant the protocol defines", () => {
      // Enumerated from the generated union rather than hand-listed, so a
      // `codex update` that adds a variant fails here instead of silently
      // dropping it in the app.
      const source = readFileSync(
        "src/protocol/generated/v2/ThreadItem.ts",
        "utf8",
      );
      const variants = [
        ...new Set(
          [...source.matchAll(/"type": "([a-zA-Z]+)"/g)].map((m) => m[1]!),
        ),
      ];
      expect(variants.length).toBeGreaterThan(15);

      const unrendered = variants.filter((type) => {
        cleanup();
        // Minimal shape per variant: enough fields for the row to render.
        render(
          <ItemView
            item={
              {
                type,
                id: `${type}-1`,
                content: [],
                text: "",
                summary: [],
                fragments: [],
                changes: [],
                commandActions: [],
                receiverThreadIds: [],
                path: "/tmp/x.png",
                review: "",
                durationMs: 1000,
                kind: "started",
                agentPath: "/tmp",
                command: "ls",
                cwd: "/tmp",
                status: "completed",
                query: "",
                arguments: {},
                tool: "wait",
                server: "s",
              } as never
            }
          />,
        );
        return document.body.textContent?.includes("unrendered:") ?? false;
      });

      expect(unrendered).toEqual([]);
    });

    it("keeps an unknown item visible instead of burying it in the disclosure", () => {
      // The placeholder only does its job somewhere the user can see it.
      const rows = buildTranscriptRows([
        entry({ type: "somethingNew", id: "x-1" }),
      ] as never);
      expect(rows[0]).toMatchObject({ kind: "item", id: "x-1" });
    });

    it("groups quiet execution-progress rows", () => {
      const rows = buildTranscriptRows([
        entry({ type: "imageView", id: "iv-1", path: "/tmp/a.png" }),
        entry({ type: "sleep", id: "s-1", durationMs: 1000 }),
      ] as never);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "work" });
    });

    it("leaves a plan in the transcript rather than collapsing it", () => {
      // Prose the user is meant to read, unlike the tool rows around it.
      const rows = buildTranscriptRows([
        entry({ type: "plan", id: "p-1", text: "Step one." }),
      ] as never);
      expect(rows[0]).toMatchObject({ kind: "item", id: "p-1" });
    });
  });

  describe("node_repl transcript rows", () => {
    const replItem = (args: Record<string, unknown>) => ({
      type: "mcpToolCall" as const,
      id: "mcp-1",
      server: "node_repl",
      tool: "js",
      status: "completed",
      arguments: args,
      appContext: null,
      pluginId: null,
      result: null,
      error: null,
      durationMs: 1200,
    });

    it("shows the agent's own label instead of node_repl · js", () => {
      // Verbatim arguments from the reported thread.
      render(
        <ItemView
          item={
            replItem({
              code: "var browserDocFull = await browser.documentation();",
              title: "Check browser guide",
              timeout_ms: 10000,
            }) as never
          }
        />,
      );

      expect(screen.getByText(/Check browser guide/)).toBeTruthy();
      expect(screen.queryByText(/node_repl · js/)).toBeNull();
    });

    it("keeps the program itself, not the {code, title} wrapper, in details", () => {
      render(
        <ItemView
          item={
            replItem({
              code: "nodeRepl.write(browserDocFull.slice(0, 14000));",
              title: "Read browser guide",
            }) as never
          }
        />,
      );
      // The row is its own disclosure now; its label is the work it names.
      act(() =>
        screen.getByRole("button", { name: /Read browser guide/ }).click(),
      );
      expect(screen.getByText(/nodeRepl\.write/)).toBeTruthy();
      // The title is already the row label; repeating it as JSON is noise.
      expect(screen.queryByText(/"title"/)).toBeNull();
    });

    it("falls back to the generic label when there is no title", () => {
      render(<ItemView item={replItem({ path: "/some/dir" }) as never} />);
      expect(screen.getByText(/node_repl · js/)).toBeTruthy();
    });
  });

  describe("command summaries", () => {
    const command = (commandActions: unknown[], cmd = "sed -n 1,20p a.ts") => ({
      type: "commandExecution" as const,
      id: "cmd-1",
      command: cmd,
      cwd: "/repo",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions,
      aggregatedOutput: "",
      exitCode: 0,
      durationMs: 10,
    });

    it("names the file a read touched", () => {
      render(
        <ItemView
          item={
            command([
              {
                type: "read",
                command: "sed",
                name: "implementation-plan.md",
                path: "/repo/doc/implementation-plan.md",
              },
            ]) as never
          }
        />,
      );
      expect(screen.getByText(/Read implementation-plan\.md/)).toBeTruthy();
      expect(
        document.querySelector('[data-operation-icon="read"]'),
      ).toBeTruthy();
    });

    it("names the skill, not SKILL.md, for a skill definition read", () => {
      // A skill read is a command summarized by intent.
      render(
        <ItemView
          item={
            command([
              {
                type: "read",
                command: "cat",
                name: "SKILL.md",
                path: "/s/control-in-app-browser/SKILL.md",
              },
            ]) as never
          }
        />,
      );
      expect(
        screen.getByText(/Read Control In App Browser skill/),
      ).toBeTruthy();
    });

    it("names the query a search ran", () => {
      render(
        <ItemView
          item={
            command([
              {
                type: "search",
                command: "rg",
                query: "userMessage",
                path: null,
              },
            ]) as never
          }
        />,
      );
      expect(screen.getByText(/Searched for userMessage/)).toBeTruthy();
      expect(
        document.querySelector('[data-operation-icon="search"]'),
      ).toBeTruthy();
    });

    it("degrades to a generic label for mixed actions", () => {
      render(
        <ItemView
          item={
            command([
              { type: "read", command: "cat", name: "a.ts", path: "/r/a.ts" },
              { type: "unknown", command: "git diff" },
            ]) as never
          }
        />,
      );
      expect(screen.getByText(/Read files, ran a command/)).toBeTruthy();
    });

    it("falls back to the old label when the parse says nothing", () => {
      render(<ItemView item={command([]) as never} />);
      expect(screen.getByText(/Ran a command/)).toBeTruthy();
    });
  });

  it("keeps preamble expanded while its turn is still working", () => {
    const commentary = {
      kind: "item" as const,
      id: "live-preamble",
      turnId: "turn-live",
      item: {
        type: "agentMessage" as const,
        id: "live-preamble",
        text: "I’m checking the live state now.",
        phase: "commentary" as const,
        memoryCitation: null,
      },
      startedAtMs: Date.now() - 1_000,
    };

    const { rerender } = render(
      <WorkDisclosure
        entries={[commentary as never]}
        deltas={{}}
        workComplete={false}
      />,
    );

    expect(screen.getByRole("button", { name: /Working/ })).toBeTruthy();
    expect(screen.getByText(/checking the live state/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();

    rerender(
      <WorkDisclosure
        entries={[commentary as never]}
        deltas={{}}
        workComplete
      />,
    );
    expect(
      screen
        .getByRole("button", { name: /Worked/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText(/checking the live state/)).toBeNull();
  });

  it("turns a pending approval into a waiting trajectory state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(12_000));
    const pending = {
      requestId: "approval-1",
      receivedAtMs: 8_000,
      threadId: "thread-1",
      kind: "commandApproval" as const,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 8_000,
        environmentId: null,
        command: "npm test",
      },
    };

    render(
      <WorkDisclosure
        entries={[]}
        deltas={{}}
        workComplete={false}
        pendingRequests={[pending]}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Waiting on you.*4s/ }),
    ).toBeTruthy();
    expect(screen.getByText("Waiting on approval")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(document.querySelector(".work.waiting")).toBeTruthy();
    expect(document.querySelector(".op-row.waiting")).toBeTruthy();
  });

  it("shows the server duration after a completed turn is reloaded", () => {
    render(
      <WorkDisclosure
        entries={[]}
        deltas={{}}
        workComplete
        durationMs={72_000}
      />,
    );

    expect(screen.getByRole("button", { name: /Worked.*1m 12s/ })).toBeTruthy();
  });

  it("ticks the turn, live section, and running operation timers together", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    const preamble = {
      kind: "item" as const,
      id: "timed-preamble",
      turnId: "turn-timed",
      item: {
        type: "agentMessage" as const,
        id: "timed-preamble",
        text: "I’m checking the timing hierarchy.",
        phase: "commentary" as const,
        memoryCitation: null,
      },
      startedAtMs: 10_000,
      completedAtMs: 11_000,
    };
    const command = {
      kind: "item" as const,
      id: "timed-command",
      turnId: "turn-timed",
      item: {
        type: "commandExecution" as const,
        id: "timed-command",
        command: "npm test",
        cwd: "/repo",
        processId: null,
        source: "agent" as const,
        status: "inProgress" as const,
        commandActions: [],
        aggregatedOutput: "",
        exitCode: null,
        durationMs: null,
      },
      startedAtMs: 12_000,
    };

    render(
      <WorkDisclosure
        entries={[preamble, command] as never}
        deltas={{}}
        workComplete={false}
      />,
    );

    const turnTimer = () =>
      document.querySelector(".work-head .work-dur")?.textContent;
    const sectionTimer = () =>
      document.querySelector(".work-preamble .work-dur")?.textContent;
    const operationTimer = () =>
      document.querySelector(".op-row .op-dur")?.textContent;
    expect(turnTimer()).toBe("10s");
    expect(sectionTimer()).toBe("10s");
    expect(operationTimer()).toBe("8s");
    expect(document.querySelector(".work-head > .work-spinner")).toBeTruthy();
    expect(document.querySelector(".op-row.running > .op-head")).toBeTruthy();
    expect(
      document.querySelector('[data-operation-icon="command"]'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        ".op-row.running .op-tail > .op-chevron:last-child",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(".work-head > .work-tail:last-child"),
    ).toBeTruthy();
    expect(document.querySelector(".work-section.live")).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_000));
    expect(turnTimer()).toBe("12s");
    expect(sectionTimer()).toBe("12s");
    expect(operationTimer()).toBe("10s");
  });

  it("preserves a manual expansion until the turn is terminal", () => {
    const commentary = {
      kind: "item" as const,
      id: "manual-preamble",
      turnId: "turn-manual",
      item: {
        type: "agentMessage" as const,
        id: "manual-preamble",
        text: "I’m checking the terminal transition now.",
        phase: "commentary" as const,
        memoryCitation: null,
      },
      startedAtMs: Date.now() - 1_000,
    };

    const { rerender } = render(
      <WorkDisclosure
        entries={[commentary as never]}
        deltas={{}}
        workComplete={false}
        turnComplete={false}
      />,
    );

    // Live work starts open. Closing and reopening it records an explicit
    // user choice rather than relying on that live-state default.
    act(() => screen.getByRole("button", { name: /Working/ }).click());
    act(() => screen.getByRole("button", { name: /Working/ }).click());

    rerender(
      <WorkDisclosure
        entries={[commentary as never]}
        deltas={{}}
        workComplete
        turnComplete={false}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: /Worked/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    rerender(
      <WorkDisclosure
        entries={[commentary as never]}
        deltas={{}}
        workComplete
        turnComplete
      />,
    );
    expect(
      screen
        .getByRole("button", { name: /Worked/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

describe("cross-project sidebar", () => {
  const projects = [
    {
      id: "p1",
      name: "CodexDesk",
      roots: ["/repo"],
      activeRoot: "/repo",
    },
    {
      id: "p2",
      name: "Examples",
      roots: ["/examples", "/examples/tools"],
      activeRoot: "/examples",
    },
    {
      id: "p3",
      name: "Tools",
      roots: ["/tools"],
      activeRoot: "/tools",
    },
  ];
  const row = (
    id: string,
    projectId: string | null,
    overrides: Partial<CurrentThreadListEntry> = {},
  ): CurrentThreadListEntry => ({
    threadId: id,
    name: `Chat ${id}`,
    preview: `Preview ${id}`,
    cwd:
      projectId === "p2"
        ? "/examples"
        : projectId === "p3"
          ? "/tools"
          : "/repo",
    projectId,
    status: "idle",
    startedAtMs: null,
    failureMessage: null,
    pinned: false,
    archived: false,
    unread: false,
    updatedAtMs: Number(id.replace(/\D/g, "")) || 1,
    worktreePath: null,
    loaded: false,
    ...overrides,
  });

  it("orders attention states before recency in Priority mode", () => {
    const rows = [
      row("1", "p1", { updatedAtMs: 30 }),
      row("2", "p1", { status: "waitingOnApproval", updatedAtMs: 10 }),
      row("3", "p1", { status: "waitingOnUserInput", updatedAtMs: 5 }),
    ];
    expect(
      orderThreads(rows, "priority", [], null).map((item) => item.threadId),
    ).toEqual(["3", "2", "1"]);
  });

  it("groups projects, progressively discloses rows, and searches archived chats", async () => {
    const created: unknown[] = [];
    const threads = [
      ...Array.from({ length: 20 }, (_, index) =>
        row(String(index + 1), "p1", {
          name:
            index === 0
              ? "A deliberately long chat title that must truncate safely"
              : undefined,
          status:
            index === 0
              ? "waitingOnUserInput"
              : index === 1
                ? "waitingOnApproval"
                : index === 2
                  ? "running"
                  : index === 3
                    ? "failed"
                    : "idle",
          unread: index === 4,
        }),
      ),
      ...Array.from({ length: 15 }, (_, index) =>
        row(String(index + 21), "p2"),
      ),
      ...Array.from({ length: 13 }, (_, index) =>
        row(String(index + 36), "p3"),
      ),
      row("49", null),
      row("50", null),
      row("51", "p2", { name: "Archived result", archived: true }),
    ];

    render(
      <ThreadSidebar
        threads={threads}
        activeThreadId={null}
        onOpen={() => {}}
        onNew={(options) => created.push(options)}
        onPin={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenInNewWindow={() => {}}
        projects={projects}
        onRemoveProject={() => {}}
      />,
    );

    const codexDeskProject = screen.getByRole("button", {
      name: /CodexDesk.*20/,
    });
    expect(codexDeskProject).toBeTruthy();
    expect(
      codexDeskProject.lastElementChild?.classList.contains("chevron"),
    ).toBe(true);
    expect(
      codexDeskProject
        .closest(".project-group")
        ?.querySelectorAll(".thread-row"),
    ).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Examples.*15/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tools.*13/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Recents.*2/ })).toBeTruthy();
    expect(
      document.querySelector(".project-group .project-toggle span")
        ?.textContent,
    ).toBe("Recents");
    expect(
      screen.queryByRole("navigation", { name: "Chat filters" }),
    ).toBeNull();
    expect(
      document.querySelectorAll(
        ".thread-row.needs-input, .thread-row.approval",
      ),
    ).toHaveLength(2);
    expect(document.querySelector(".project-header.renaming")).toBeNull();
    expect(document.querySelector(".thread-row.running")).toBeTruthy();
    expect(document.querySelector(".thread-row.failed")).toBeTruthy();
    expect(document.querySelector(".thread-row.unread")).toBeNull();

    const firstChat = screen.getByRole("button", {
      name: /A deliberately long chat title.*Needs input/,
    });
    act(() =>
      within(firstChat)
        .getByRole("button", {
          name: /Actions for A deliberately long chat title/,
        })
        .click(),
    );
    expect(firstChat.classList.contains("actions-open")).toBe(true);
    act(() => fireEvent.keyDown(document, { key: "Escape" }));
    expect(firstChat.classList.contains("actions-open")).toBe(false);

    const more = screen.getByRole("button", { name: "+ 16 more" });
    act(() => more.click());
    expect(document.querySelector(".thread-row.unread")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Show less" })).toHaveLength(
      1,
    );

    act(() =>
      screen.getByRole("button", { name: "Account and settings" }).click(),
    );
    act(() => screen.getByRole("menuitem", { name: "Archived chats" }).click());
    expect(screen.getByText("Archived result")).toBeTruthy();
    expect(screen.getAllByText("Examples").length).toBeGreaterThan(0);

    act(() => screen.getByRole("button", { name: "New chat" }).click());
    expect(created).toEqual([{ projectId: null }]);
    expect(screen.queryByText("Start new chat")).toBeNull();
  });

  it("caps unassigned chats in Recents without project-only actions", () => {
    const threads = Array.from({ length: 11 }, (_, index) =>
      row(String(index + 1), null),
    );
    render(
      <ThreadSidebar
        threads={threads}
        activeThreadId={null}
        onOpen={() => {}}
        onNew={() => {}}
        onPin={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenInNewWindow={() => {}}
        projects={projects}
        onRemoveProject={() => {}}
      />,
    );

    const recents = screen
      .getByRole("button", { name: /Recents.*11/ })
      .closest(".project-group") as HTMLElement;
    expect(recents.querySelectorAll(".thread-row")).toHaveLength(8);
    expect(
      within(recents).getByRole("button", { name: "+ 3 more" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /New chat in Recents/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Project actions for Recents/ }),
    ).toBeNull();

    act(() =>
      within(recents).getByRole("button", { name: "+ 3 more" }).click(),
    );
    expect(recents.querySelectorAll(".thread-row")).toHaveLength(11);
    expect(
      within(recents).getByRole("button", { name: "Show less" }),
    ).toBeTruthy();
  });

  it("keeps an active chat visible beyond the initial project slice", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      row(String(index + 1), "p1"),
    );
    render(
      <ThreadSidebar
        threads={threads}
        activeThreadId="8"
        onOpen={() => {}}
        onNew={() => {}}
        onPin={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenInNewWindow={() => {}}
        projects={projects}
        onRemoveProject={() => {}}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "Chat 8" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Show 0 more" })).toBeNull();
  });

  it("uses the focused project menu and validates inline rename", async () => {
    const created: unknown[] = [];
    const renamed = vi.fn();
    render(
      <ThreadSidebar
        threads={[
          row("1", "p1"),
          row("2", "p1", { status: "notLoaded" }),
          row("3", "p1", { status: "running" }),
        ]}
        activeThreadId="1"
        onOpen={() => {}}
        onNew={(options) => created.push(options)}
        onPin={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenInNewWindow={() => {}}
        projects={projects}
        onRemoveProject={() => {}}
        onRenameProject={renamed}
      />,
    );

    const projectToggle = screen.getByRole("button", { name: /CodexDesk.*3/ });
    const projectHeader = projectToggle.closest(".project-header")!;
    expect(
      screen.getByRole("button", { name: "New chat in CodexDesk" }),
    ).toBeTruthy();

    act(() =>
      screen.getByRole("button", { name: "New chat in CodexDesk" }).click(),
    );
    expect(created).toEqual([{ cwd: "/repo", projectId: "p1" }]);

    const openMenu = () =>
      act(() =>
        screen
          .getByRole("button", { name: "Project actions for CodexDesk" })
          .click(),
      );
    openMenu();
    expect(screen.getByRole("button", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename project" })).toBeTruthy();
    const projectMenu = document.querySelector(".rowmenu-items.fixed")!;
    expect(
      within(projectMenu as HTMLElement).queryByRole("button", {
        name: "Reveal in Finder",
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(projectHeader.classList.contains("actions-open")).toBe(true);

    act(() => screen.getByRole("button", { name: "Rename project" }).click());
    expect(projectHeader.classList.contains("renaming")).toBe(true);
    const rename = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(rename, {
      target: { value: "Examples" },
    });
    fireEvent.submit(rename.closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    expect(renamed).not.toHaveBeenCalled();

    fireEvent.change(rename, { target: { value: "Renamed CodexDesk" } });
    await act(async () => fireEvent.submit(rename.closest("form")!));
    expect(renamed).toHaveBeenCalledWith("p1", "Renamed CodexDesk");
  });

  it("opens a chat command palette with keyboard navigation", () => {
    const opened = vi.fn();
    const openFolder = vi.fn();
    const searchFiles = vi.fn();
    render(
      <ThreadSidebar
        threads={[row("1", "p1"), row("2", "p2"), row("3", null)]}
        activeThreadId="1"
        onOpen={opened}
        onNew={() => {}}
        onPin={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenInNewWindow={() => {}}
        projects={projects}
        onRemoveProject={() => {}}
        onOpenFolder={openFolder}
        onSearchFiles={searchFiles}
      />,
    );

    act(() => screen.getByRole("button", { name: "Search chats" }).click());
    let dialog = within(screen.getByRole("dialog", { name: "Search chats" }));
    expect(dialog.getAllByText("Chats").length).toBeGreaterThan(0);
    expect(dialog.getByText("Suggested")).toBeTruthy();
    expect(
      dialog.getByRole("option", { name: /Chat 2.*Examples.*⌘2/ }),
    ).toBeTruthy();
    expect(dialog.getByRole("option", { name: /New chat.*⌘N/ })).toBeTruthy();
    expect(
      dialog.getByRole("option", { name: /Open folder.*⌘O/ }),
    ).toBeTruthy();
    expect(
      dialog.getByRole("option", { name: /Search files.*⌘P/ }),
    ).toBeTruthy();

    const input = dialog.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Chat 2" } });
    expect(dialog.queryByText("Suggested")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened).toHaveBeenCalledWith("2");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();

    act(() => screen.getByRole("button", { name: "Search chats" }).click());
    dialog = within(screen.getByRole("dialog", { name: "Search chats" }));
    act(() => dialog.getByRole("option", { name: /Open folder/ }).click());
    expect(openFolder).toHaveBeenCalledOnce();

    act(() => screen.getByRole("button", { name: "Search chats" }).click());
    dialog = within(screen.getByRole("dialog", { name: "Search chats" }));
    act(() => dialog.getByRole("option", { name: /Search files/ }).click());
    expect(searchFiles).toHaveBeenCalledOnce();
  });
});

describe("draft isolation (P1)", () => {
  it("does not carry a draft from one thread into another", async () => {
    installBridge(
      snapshot({ activeThreadId: "A", view: view("A", ""), threads: [] }),
    );
    render(<App />);
    await act(async () => {});

    const textarea = () =>
      document.querySelector(".composer textarea") as HTMLTextAreaElement;

    // Type into thread A.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea(), "text meant for A");
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea().value).toBe("text meant for A");

    // Switch to thread B, which has its own (empty) draft.
    await act(async () => {
      emit({ type: "activeThread", threadId: "B" });
      emit({ type: "threadView", view: view("B", "") });
    });

    // The composer must be B's, not A's leftover text.
    expect(textarea().value).toBe("");
  });

  it("restores each thread's own saved draft on switch", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "A text") }));
    render(<App />);
    await act(async () => {});

    const textarea = () =>
      document.querySelector(".composer textarea") as HTMLTextAreaElement;
    expect(textarea().value).toBe("A text");

    await act(async () => {
      emit({ type: "activeThread", threadId: "B" });
      emit({ type: "threadView", view: view("B", "B text") });
    });
    expect(textarea().value).toBe("B text");

    await act(async () => {
      emit({ type: "activeThread", threadId: "A" });
      emit({ type: "threadView", view: view("A", "A text") });
    });
    expect(textarea().value).toBe("A text");
  });

  it("never persists a draft under a different thread's id", async () => {
    vi.useFakeTimers();
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    const textarea = () =>
      document.querySelector(".composer textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea(), "belongs to A");
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      emit({ type: "activeThread", threadId: "B" });
      emit({ type: "threadView", view: view("B", "") });
      vi.advanceTimersByTime(1000);
    });

    // The precise corruption: "belongs to A" written under thread B.
    expect(
      savedDrafts.some((d) => d.threadId === "B" && d.draft === "belongs to A"),
    ).toBe(false);
  });
});

describe("permission grants (P1)", () => {
  /**
   * `PendingRequest` is a union, so `infer P` binds to the whole union and
   * `P["permissions"]` cannot be indexed. Extract the permissions member
   * first, then index that.
   */
  type PermissionsRequest = Extract<PendingRequest, { kind: "permissions" }>;

  function permissionRequest(
    permissions: PermissionsRequest["params"]["permissions"],
  ): PendingRequest {
    return {
      requestId: 1,
      receivedAtMs: 0,
      threadId: "t1",
      kind: "permissions",
      params: {
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        environmentId: null,
        startedAtMs: 0,
        cwd: "/repo",
        reason: "needs access",
        permissions,
      },
    } as PendingRequest;
  }

  it("does not grant network when the request has it disabled", () => {
    const answers: RequestAnswer[] = [];
    render(
      <RequestCard
        request={permissionRequest({
          network: { enabled: false },
          fileSystem: { read: ["/repo/src"], write: null },
        } as never)}
        onAnswer={(_id, a) => answers.push(a)}
      />,
    );

    // `network` is an object, so `network ? …` was true even for
    // `{enabled:false}` and granted access the server had not asked for.
    expect(screen.queryByText("Network access")).toBeNull();

    screen.getByText("Allow for this turn").click();
    expect(answers[0]).toMatchObject({
      kind: "permissions",
      granted: { readPaths: ["/repo/src"] },
    });
    expect(
      (answers[0] as { granted: Record<string, unknown> }).granted,
    ).not.toHaveProperty("network");
  });

  it("grants network when it is genuinely requested", () => {
    const answers: RequestAnswer[] = [];
    render(
      <RequestCard
        request={permissionRequest({
          network: { enabled: true },
          fileSystem: null,
        } as never)}
        onAnswer={(_id, a) => answers.push(a)}
      />,
    );
    expect(screen.getByText("Network access")).toBeTruthy();
    screen.getByText("Allow for session").click();
    expect(answers[0]).toMatchObject({
      kind: "permissions",
      scope: "session",
      granted: { network: true },
    });
  });

  it("renders the structured filesystem entries shape", () => {
    render(
      <RequestCard
        request={permissionRequest({
          network: null,
          fileSystem: {
            read: null,
            write: null,
            entries: [
              { path: { type: "path", path: "/repo/a" }, access: "read" },
              {
                path: { type: "glob_pattern", pattern: "**/*.ts" },
                access: "write",
              },
              { path: { type: "path", path: "/etc" }, access: "deny" },
            ],
          },
        } as never)}
        onAnswer={() => {}}
      />,
    );
    // Previously ignored entirely, so the card showed an empty list.
    expect(screen.getByText(/Read \/repo\/a/)).toBeTruthy();
    expect(screen.getByText(/Write \*\*\/\*\.ts/)).toBeTruthy();
    expect(screen.getByText(/Explicitly denied: \/etc/)).toBeTruthy();
  });

  it("offers only a dismiss when nothing is actually requested", () => {
    const answers: RequestAnswer[] = [];
    render(
      <RequestCard
        request={permissionRequest({
          network: null,
          fileSystem: null,
        } as never)}
        onAnswer={(_id, a) => answers.push(a)}
      />,
    );
    expect(
      (screen.getByText("Allow for this turn") as HTMLButtonElement).disabled,
    ).toBe(true);
    screen.getByText("Dismiss").click();
    expect(answers[0]).toMatchObject({ granted: null });
  });
});

/**
 * §8.4 — the long-tail item variants.
 *
 * The failure these guard against is not "renders badly", it is "renders
 * nothing": before this, thirteen of the eighteen `ThreadItem` variants fell
 * through to a placeholder, so an agent that did all its work through MCP
 * tools produced a transcript that looked empty. Each test below asserts the
 * variant is *legible* — the who/what is on screen without expanding
 * anything — and that bulky payloads stay behind a toggle.
 */
describe("item variants (§8.4)", () => {
  afterEach(cleanup);

  const mcp = {
    type: "mcpToolCall" as const,
    id: "m1",
    server: "linear",
    tool: "create_issue",
    status: "completed",
    arguments: { title: "Fix the gutter" },
    result: { content: [{ type: "text", text: "issue ENG-42 created" }] },
    error: null,
    durationMs: 1400,
  };

  it("names the server and tool without needing to be expanded", () => {
    render(<ItemView item={mcp as never} />);
    expect(screen.getByText(/linear · create_issue/)).toBeTruthy();
    // The duration has its own right-aligned column, so it no longer carries
    // a separator into the label.
    expect(screen.getByText("1s")).toBeTruthy();
  });

  it("keeps a tool result behind a toggle so it cannot flood the transcript", () => {
    render(<ItemView item={mcp as never} />);
    expect(screen.queryByText(/issue ENG-42 created/)).toBeNull();
    act(() => screen.getByRole("button", { name: /create_issue/ }).click());
    expect(screen.getByText(/issue ENG-42 created/)).toBeTruthy();
  });

  it("surfaces a tool error inline — a failure must not need a click", () => {
    render(
      <ItemView
        item={
          {
            ...mcp,
            status: "failed",
            error: { message: "rate limited" },
          } as never
        }
      />,
    );
    expect(screen.getByText("rate limited")).toBeTruthy();
  });

  it("treats dynamicToolCall success:false as a failure the status misses", () => {
    render(
      <ItemView
        item={
          {
            type: "dynamicToolCall",
            id: "d1",
            tool: "lookup",
            namespace: null,
            status: "completed",
            arguments: {},
            contentItems: [],
            success: false,
            durationMs: null,
          } as never
        }
      />,
    );
    expect(screen.getByText(/reported a failure/)).toBeTruthy();
  });

  it("shows the queries a web search actually ran, not just the item's query", () => {
    render(
      <ItemView
        item={
          {
            type: "webSearch",
            id: "w1",
            query: "codex desktop",
            action: {
              type: "search",
              query: null,
              queries: ["diff gutters", "split view"],
            },
          } as never
        }
      />,
    );
    expect(screen.getByText(/diff gutters, split view/)).toBeTruthy();
  });

  it("says a page was opened rather than searched", () => {
    render(
      <ItemView
        item={
          {
            type: "webSearch",
            id: "w2",
            query: "ignored",
            action: { type: "openPage", url: "https://example.com/a" },
          } as never
        }
      />,
    );
    expect(screen.getByText(/Opened a page/)).toBeTruthy();
    expect(screen.getByText(/example.com\/a/)).toBeTruthy();
  });

  it("shows the revised prompt and generated image", async () => {
    const readImage = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const openPath = vi.fn();
    (
      window as unknown as {
        codexDesk: { readImage: unknown; openPath: unknown };
      }
    ).codexDesk = { readImage, openPath };

    await act(async () => {
      render(
        <ItemView
          item={
            {
              type: "imageGeneration",
              id: "i1",
              status: "completed",
              revisedPrompt: "A wide shot of a harbour at dusk",
              result: "",
              savedPath: "/repo/out/harbour.png",
            } as never
          }
        />,
      );
    });

    expect(screen.getAllByText(/harbour at dusk/)).toHaveLength(1);
    expect(screen.getByText(/harbour.png/)).toBeTruthy();
    const image = await screen.findByAltText("harbour.png");
    expect(image.className).toContain("generated-image");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("does not draw a disclosure control when a file change has no diff", () => {
    render(
      <ItemView
        item={
          {
            type: "fileChange",
            id: "f1",
            status: "completed",
            changes: [
              {
                path: "/repo/app/src/empty.ts",
                kind: { type: "update", move_path: null },
                diff: "",
              },
            ],
          } as never
        }
        workspaceRoot="/repo"
      />,
    );

    expect(screen.getByText("empty.ts")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector(".filechange .op-chevron")).toBeNull();
  });

  it("renders compaction as an event, since the event is the whole message", () => {
    render(
      <ItemView item={{ type: "contextCompaction", id: "c1" } as never} />,
    );
    expect(screen.getByText(/Compacted the conversation/)).toBeTruthy();
  });

  it("reads a sub-agent's lifecycle as words, not as an enum", () => {
    render(
      <ItemView
        item={
          {
            type: "subAgentActivity",
            id: "s1",
            kind: "interrupted",
            agentPath: "/repo/agents/reviewer",
          } as never
        }
      />,
    );
    expect(screen.getByText(/Sub-agent was interrupted/)).toBeTruthy();
  });

  it("still shows a placeholder for a variant nobody has written yet", () => {
    // The placeholder is the safety net for the next protocol addition; if it
    // ever renders nothing, new item types go invisible again.
    render(<ItemView item={{ type: "somethingNew", id: "x" } as never} />);
    expect(screen.getByText(/unrendered: somethingNew/)).toBeTruthy();
  });
});

/**
 * The queue pane (§8.1).
 *
 * A queue the user cannot see into is a buffer, and a buffer that stops
 * draining looks like a hung app. These pin the two things that make it a
 * surface instead: the entries are editable and reorderable, and a refused
 * steer says so.
 */
describe("queue pane (§8.1)", () => {
  afterEach(cleanup);

  const queued = [
    {
      id: "q1",
      text: "first thing",
      createdAt: 1,
      assets: [],
      schedule: "afterTurn" as const,
      lastFailure: null,
    },
    {
      id: "q2",
      text: "second thing",
      createdAt: 2,
      assets: [],
      schedule: "afterTurn" as const,
      lastFailure: null,
    },
  ];

  async function renderQueue(
    over: {
      entries?: ThreadView["outbox"]["entries"];
      dispatch?: ThreadView["outbox"]["dispatch"];
      capacity?: number;
      running?: boolean;
    } = {},
  ) {
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: {
          ...view("A"),
          outbox: {
            entries: over.entries ?? queued,
            dispatch: over.dispatch ?? { kind: "idle" },
            capacity: over.capacity ?? 8,
          },
          run:
            over.running === false
              ? { kind: "ready" }
              : {
                  kind: "running",
                  turnId: "turn-1",
                  startedAt: null,
                },
        },
      }),
    );
    render(<App />);
    await act(async () => {});
  }

  it("shows every queued message, not just a count", async () => {
    await renderQueue();
    expect(screen.getByText("first thing")).toBeTruthy();
    expect(screen.getByText("second thing")).toBeTruthy();
    expect(screen.getByText(/2 messages queued/)).toBeTruthy();
  });

  it("reorders through the move control", async () => {
    await renderQueue();
    const downs = screen.getAllByLabelText("Move down");
    await act(async () => downs[0]!.click());
    expect(calls.moved).toEqual([{ id: "q1", to: 1 }]);
  });

  it("cannot move the head up or the tail down", async () => {
    await renderQueue();
    expect(
      (screen.getAllByLabelText("Move up")[0] as HTMLButtonElement).disabled,
    ).toBe(true);
    const downs = screen.getAllByLabelText("Move down") as HTMLButtonElement[];
    expect(downs[downs.length - 1]!.disabled).toBe(true);
  });

  it("edits a queued message in place", async () => {
    await renderQueue();
    await act(async () => screen.getAllByLabelText("Edit")[0]!.click());

    const ta = screen.getByLabelText(
      "Edit queued message",
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, "first thing, revised");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => screen.getByText("Save").click());

    expect(calls.edited).toEqual([{ id: "q1", text: "first thing, revised" }]);
  });

  it("explains a refused steer instead of leaving the queue looking stuck", async () => {
    await renderQueue({
      dispatch: {
        kind: "deferred",
        reason: "turnNotSteerable",
        detail: "review",
      },
    });
    expect(screen.getByText(/review in progress/)).toBeTruthy();
    expect(screen.queryByText("Send now")).toBeNull();
  });

  it("offers Send now only while a turn is running", async () => {
    await renderQueue({ running: false });
    expect(screen.queryByText("Send now")).toBeNull();
  });

  it("steers the head into the running turn only after Send now", async () => {
    await renderQueue();
    expect(calls.steered).toEqual([]);

    await act(async () => screen.getByText("Send now").click());

    expect(calls.steered).toEqual(["A"]);
  });

  it("removes the selected message without disturbing its neighbours", async () => {
    await renderQueue();
    const removes = screen.getAllByLabelText("Remove");

    await act(async () => removes[1]!.click());

    expect(calls.removed).toEqual(["q2"]);
  });

  it("locks queue management while a message is being steered", async () => {
    await renderQueue({
      dispatch: {
        kind: "sending",
        entryId: "q1",
        expectedTurnId: "turn-1",
      },
    });

    const queue = document.querySelector(".queue") as HTMLElement;
    expect(queue.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(screen.queryByText("Send now")).toBeNull();
    expect(
      screen
        .getAllByLabelText(/Move up|Move down|Edit|Remove/)
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it("keeps a failed steer visible and offers a retry", async () => {
    await renderQueue({
      dispatch: {
        kind: "failed",
        entryId: "q1",
        message: "steering was refused",
        retryable: true,
      },
    });

    expect(screen.getByText("steering was refused")).toBeTruthy();
    expect(screen.getByText("Send now")).toBeTruthy();
  });

  it("marks the queue as full at the bound", async () => {
    await renderQueue({
      entries: Array.from({ length: 8 }, (_, i) => ({
        id: `q${i}`,
        text: `m${i}`,
        createdAt: i,
        assets: [],
        schedule: "afterTurn" as const,
        lastFailure: null,
      })),
    });
    expect(screen.getByText(/full/)).toBeTruthy();
    expect(screen.getByText("capacity 8")).toBeTruthy();
  });

  it("renders nothing at all when the queue is empty", async () => {
    await renderQueue({ entries: [] });
    expect(document.querySelector(".queue")).toBeNull();
  });
});

/**
 * The plan strip (§8.3).
 *
 * `turn/plan/updated` replaces the plan wholesale, so the strip shows current
 * state. The case worth pinning is the one that is silently wrong: a turn
 * that ends with steps outstanding looks exactly like a plan still in
 * progress unless the surface says otherwise.
 */
describe("plan strip (§8.3)", () => {
  afterEach(cleanup);

  const steps = [
    { step: "Read the parser", status: "completed" as const },
    { step: "Add the failing test", status: "inProgress" as const },
    { step: "Fix the off-by-one", status: "pending" as const },
  ];

  async function renderPlan(plan: ThreadView["plan"]) {
    installBridge(
      snapshot({ activeThreadId: "A", view: { ...view("A"), plan } }),
    );
    render(<App />);
    await act(async () => {});
  }

  it("shows progress as a count, not just a list", async () => {
    await renderPlan({
      explanation: null,
      steps,
      turnId: "t1",
      turnEnded: false,
    });
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("surfaces the step in flight in the collapsed header", async () => {
    await renderPlan({
      explanation: null,
      steps,
      turnId: "t1",
      turnEnded: false,
    });
    await act(async () => screen.getByText("Hide").click());
    // Collapsed: the steps are gone but the current one still reads.
    expect(screen.queryByText("Fix the off-by-one")).toBeNull();
    expect(screen.getByText("Add the failing test")).toBeTruthy();
  });

  it("says a plan is incomplete when the turn ended with work outstanding", async () => {
    // Otherwise an abandoned plan is indistinguishable from a running one.
    await renderPlan({
      explanation: null,
      steps,
      turnId: "t1",
      turnEnded: true,
    });
    expect(screen.getByText(/2 steps not done/)).toBeTruthy();
  });

  it("does not cry incomplete when every step finished", async () => {
    await renderPlan({
      explanation: null,
      steps: steps.map((s) => ({ ...s, status: "completed" as const })),
      turnId: "t1",
      turnEnded: true,
    });
    expect(screen.queryByText(/not done/)).toBeNull();
    expect(screen.getByText("plan complete")).toBeTruthy();
  });

  it("keeps the model's explanation below the steps it explains", async () => {
    await renderPlan({
      explanation: "Starting with the parser because the bug is upstream.",
      steps,
      turnId: "t1",
      turnEnded: false,
    });
    expect(screen.getByText(/bug is upstream/)).toBeTruthy();
  });

  it("renders nothing for an empty plan", async () => {
    await renderPlan({
      explanation: null,
      steps: [],
      turnId: null,
      turnEnded: false,
    });
    expect(document.querySelector(".plan")).toBeNull();
  });
});

/**
 * Delegated approval (§8.2).
 *
 * When the user hands approvals to the model, the transcript is the only
 * place a decision they did not make becomes visible. The cases that matter
 * are the ones that could pass unnoticed: a high-risk approval, and a review
 * that never reached a decision at all.
 */
describe("delegated approval (§8.2)", () => {
  afterEach(cleanup);

  const base = {
    reviewId: "r1",
    targetItemId: null,
    action: {
      type: "command" as const,
      source: "model" as never,
      command: "rm -rf build",
      cwd: "/repo",
    },
    startedAtMs: 0,
    completedAtMs: 1000,
    rationale: "Build output only.",
  };

  it("marks a high-risk approval so it cannot pass unnoticed", () => {
    render(
      <AutoReviewCard
        review={{ ...base, status: "approved", riskLevel: "high" } as never}
      />,
    );
    expect(screen.getByText("high risk")).toBeTruthy();
    expect(document.querySelector(".autoReview.elevated")).toBeTruthy();
  });

  it("does not flag an ordinary low-risk approval", () => {
    render(
      <AutoReviewCard
        review={{ ...base, status: "approved", riskLevel: "low" } as never}
      />,
    );
    expect(document.querySelector(".autoReview.elevated")).toBeNull();
  });

  it("says a timed-out review reached no decision, not that it succeeded", () => {
    render(
      <AutoReviewCard
        review={
          {
            ...base,
            status: "timedOut",
            riskLevel: "medium",
            rationale: null,
          } as never
        }
      />,
    );
    expect(screen.getByText(/No decision was reached/)).toBeTruthy();
    expect(screen.getByText(/timed out/)).toBeTruthy();
  });

  it("shows the reviewer's reasoning, which is the only account the user gets", () => {
    render(
      <AutoReviewCard
        review={{ ...base, status: "approved", riskLevel: "low" } as never}
      />,
    );
    expect(screen.getByText("Build output only.")).toBeTruthy();
  });

  /**
   * The approvals posture currently has **no UI**.
   *
   * It was a topbar dropdown, then a topbar-menu field, and the menu was
   * removed on 2026-07-27 — the setting belongs to a settings surface that
   * does not exist yet. The IPC path is still live and still tested here, so
   * that when a control returns it is a render rather than a
   * re-implementation. Delete this test if the capability is ever dropped;
   * do not "fix" it by re-adding a control to the topbar.
   */
  it("still sends an approval posture change over IPC", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    await act(async () => {
      void window.codexDesk.setApprovalsReviewer("auto_review");
    });

    expect(calls.approvals).toEqual(["auto_review"]);
  });

  it("has no approvals control in the topbar", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    const bar = document.querySelector(".topbar")!;
    expect(bar.querySelector("select")).toBeNull();
    expect(bar.textContent).not.toContain("Approvals");
  });
});

/**
 * The approval mode picker.
 *
 * It sits in the composer because that is where the choice has consequences.
 * The failures worth catching are a control that shows the wrong current
 * posture, and one that offers a mode the operator has disabled — both make
 * the user believe something about the agent's authority that is not true.
 */
describe("approval mode picker", () => {
  const openPicker = async () => {
    const trigger = screen.getByTitle("Approval mode");
    await act(async () => {
      fireEvent.click(trigger);
    });
    return trigger;
  };

  it("shows the active thread's posture rather than the default", async () => {
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: { ...view("A"), approvalMode: "read-only" },
      }),
    );
    render(<App />);
    await act(async () => {});

    expect(screen.getByTitle("Approval mode").textContent).toContain(
      "Read Only",
    );
  });

  it("sends the chosen mode for the active thread", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    await openPicker();
    await act(async () => {
      fireEvent.click(screen.getByText("Full Access"));
    });

    expect(calls.approvalModes).toEqual([
      { threadId: "A", mode: "full-access" },
    ]);
  });

  it("offers all three modes when no policy constrains them", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    await openPicker();
    const menu = document.querySelector(".approval-picker .model-menu")!;
    expect(menu.querySelectorAll(".model-choice")).toHaveLength(3);
  });

  it("omits a mode the operator has disabled", async () => {
    const snap = snapshot({ activeThreadId: "A", view: view("A") });
    snap.config = {
      ...snap.config,
      allowedApprovalModes: ["read-only", "auto"],
    };
    installBridge(snap);
    render(<App />);
    await act(async () => {});

    await openPicker();
    const menu = document.querySelector(".approval-picker .model-menu")!;
    expect(menu.textContent).not.toContain("Full Access");
    // Silently shortening the list would look like a bug, so say why.
    expect(menu.textContent).toContain("organization's policy");
  });
});

/**
 * The usage report (§8.6).
 *
 * Two things could quietly lie here: an account with no usage backend, which
 * must read as an absence rather than an error, and a missing figure, which
 * must not render as a zero.
 */
describe("usage report (§8.6)", () => {
  afterEach(cleanup);

  async function open() {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});
    await act(async () =>
      screen.getByRole("button", { name: "Account and settings" }).click(),
    );
    await act(async () =>
      screen.getByRole("menuitem", { name: "Usage" }).click(),
    );
    await act(async () => {});
  }

  it("shows the figures the account reports", async () => {
    usageFixture = {
      lifetimeTokens: 1_234_567,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: 4,
      longestStreakDays: null,
      dailyBuckets: [],
    };
    await open();
    expect(screen.getByText("1,234,567")).toBeTruthy();
    expect(screen.getByText("4 days")).toBeTruthy();
  });

  it("omits a missing figure instead of showing it as zero", async () => {
    usageFixture = {
      lifetimeTokens: 100,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
      dailyBuckets: [],
    };
    await open();
    expect(screen.queryByText("Peak day")).toBeNull();
    expect(
      within(document.querySelector(".usage-panel") as HTMLElement).queryByText(
        "0",
      ),
    ).toBeNull();
  });

  it("reads an account with no usage backend as an absence, not a failure", async () => {
    usageFixture = null;
    await open();
    expect(screen.getByText(/does not report usage/)).toBeTruthy();
  });

  it("draws one bar per day of usage", async () => {
    usageFixture = {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
      dailyBuckets: [
        { startDate: "2026-07-01", tokens: 10 },
        { startDate: "2026-07-02", tokens: 90 },
      ],
    };
    await open();
    expect(document.querySelectorAll(".usage-bar")).toHaveLength(2);
  });

  it("offers the reset credit at the moment the limit is reached", async () => {
    const limited = {
      ...view("A"),
      budget: {
        tokenUsage: null,
        rateLimits: {
          primary: {
            usedPercent: 100,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          credits: null,
          rateLimitReachedType: "primary",
        },
      },
    };
    installBridge(snapshot({ activeThreadId: "A", view: limited as never }));
    render(<App />);
    await act(async () => {});
    // Budget now lives inside the Usage panel rather than a permanent strip,
    // so the redeem action is reachable through the sidebar's Usage control.
    await act(async () =>
      screen.getByRole("button", { name: "Account and settings" }).click(),
    );
    await act(async () =>
      screen.getByRole("menuitem", { name: "Usage" }).click(),
    );
    await act(async () => screen.getByText("Use a reset credit").click());
    expect(calls.redeemed).toBe(1);
  });

  it("keeps the budget out of the header until Usage is opened", async () => {
    const limited = {
      ...view("A"),
      budget: {
        tokenUsage: {
          modelContextWindow: 100,
          total: { totalTokens: 42 },
        },
        rateLimits: null,
      },
    };
    installBridge(snapshot({ activeThreadId: "A", view: limited as never }));
    render(<App />);
    await act(async () => {});
    // The strip this replaced spent fixed vertical space on every thread.
    expect(screen.queryByText(/context 42%/)).toBeNull();

    await act(async () =>
      screen.getByRole("button", { name: "Account and settings" }).click(),
    );
    await act(async () =>
      screen.getByRole("menuitem", { name: "Usage" }).click(),
    );
    expect(screen.getByText(/context 42%/)).toBeTruthy();
  });

  it("does not offer a reset credit before the limit is hit", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});
    expect(screen.queryByText("Use a reset credit")).toBeNull();
  });
});

/**
 * Draft survival on a failed send (P1).
 *
 * The composer clears optimistically so sending feels instant. That is only
 * safe if failure puts the text back — otherwise a full queue or a dead
 * transport silently deletes what the user wrote, and the debounced
 * `saveDraft` persists the empty value over the copy the main process kept.
 *
 * The orchestrator already refused to clear *its* draft on failure. These
 * cover the renderer half, which is where the text actually lives.
 */
describe("draft survives a failed send (P1)", () => {
  afterEach(cleanup);

  const textarea = () =>
    document.querySelector(".composer textarea") as HTMLTextAreaElement;

  async function type(text: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea(), text);
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function mount() {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {});
  }

  it("puts the text back when the queue is full", async () => {
    sendResult = { queued: false, error: "the queue is full (10 messages)" };
    await mount();
    await type("something I do not want to lose");
    await act(async () => {
      (document.querySelector(".composer-action") as HTMLButtonElement).click();
    });

    expect(textarea().value).toBe("something I do not want to lose");
  });

  it("does not persist an empty draft over the failed one", async () => {
    // The debounce is what made this worse than a UI glitch: it wrote the
    // cleared value back to disk.
    vi.useFakeTimers();
    sendResult = { queued: false, error: "transport closed" };
    await mount();
    await type("precious");
    await act(async () => {
      (document.querySelector(".composer-action") as HTMLButtonElement).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(savedDrafts.at(-1)?.draft).toBe("precious");
  });

  it("still clears the box when the send succeeds", async () => {
    sendResult = { queued: false };
    await mount();
    await type("on its way");
    await act(async () => {
      (document.querySelector(".composer-action") as HTMLButtonElement).click();
    });

    expect(textarea().value).toBe("");
  });

  it("clears the box when the message was queued rather than sent", async () => {
    // Queued is a success: the message exists, it is just not running yet.
    sendResult = { queued: true };
    await mount();
    await type("later");
    await act(async () => {
      (document.querySelector(".composer-action") as HTMLButtonElement).click();
    });

    expect(textarea().value).toBe("");
  });

  it("does not clobber text the user typed after the failure", async () => {
    sendResult = { queued: false, error: "the queue is full (10 messages)" };
    await mount();
    await type("first attempt");
    // Fire the send but keep typing before the promise settles.
    await act(async () => {
      (document.querySelector(".composer-action") as HTMLButtonElement).click();
      await type("a new thought");
    });

    expect(textarea().value).toBe("a new thought");
  });
});

/** The repository mock's thread context and compact panel controls. */
describe("topbar", () => {
  const bar = () => document.querySelector(".topbar") as HTMLElement;

  it("names the current thread", async () => {
    const named = { ...view("A"), name: "Fix the parser" };
    installBridge(snapshot({ activeThreadId: "A", view: named }));
    render(<App />);
    await act(async () => {});

    expect(bar().textContent).toContain("Fix the parser");
  });

  it("falls back to the workspace when a thread has no name", async () => {
    // An unnamed thread is the common case on the first turn; an empty bar
    // would be worse than a true-but-generic label.
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    expect(bar().textContent).toContain("repo");
  });

  it("shows thread context, panel toggles, and an overflow", async () => {
    const contextual = {
      ...view("A"),
      worktreePath: "/repo/.worktrees/a",
      budget: {
        tokenUsage: {
          modelContextWindow: 100,
          total: { totalTokens: 42 },
        },
        rateLimits: null,
      },
    };
    installBridge(snapshot({ activeThreadId: "A", view: contextual as never }));
    render(<App />);
    await act(async () => {});

    const labels = [...bar().querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).not.toContain("Toggle the chat sidebar");
    expect(labels).toContain("Toggle the file tree (⌘B)");
    expect(labels).toContain("Toggle the side panel");
    expect(labels).toContain("More actions");
    expect(bar().textContent).toContain("Worktree");
    expect(bar().textContent).toContain("42 / 100");

    await act(async () =>
      screen.getByRole("button", { name: "More actions" }).click(),
    );
    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
  });

  it("does not duplicate the sidebar's own account controls", async () => {
    // Sign out remains account-scoped and therefore stays in the sidebar.
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    expect(bar().textContent).not.toContain("Sign out");
    expect(bar().textContent).not.toContain("Usage");
    await act(async () =>
      screen.getByRole("button", { name: "Account and settings" }).click(),
    );
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("offers a restore control only when a persisted sidebar is hidden", async () => {
    localStorage.setItem(
      "codexdesk.workbench.layout.v2:recent",
      JSON.stringify({ sidebarVisible: false }),
    );
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});
    expect(document.querySelector(".sidebar")).toBeNull();

    await act(async () =>
      screen.getByRole("button", { name: "Show the chat sidebar" }).click(),
    );
    expect(document.querySelector(".sidebar")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show the chat sidebar" }),
    ).toBeNull();
  });

  it("mounts the file tree beside the chat app instead of inside it", async () => {
    localStorage.removeItem("codexdesk.workbench.layout");
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    await act(async () => {
      (
        bar().querySelector(
          '[aria-label="Toggle the file tree (⌘B)"]',
        ) as HTMLButtonElement
      ).click();
    });

    await waitFor(() =>
      expect(document.querySelector(".tree-column")).not.toBeNull(),
    );
    const shell = document.querySelector(".workspace-shell")!;
    const app = document.querySelector(".app")!;
    const tree = document.querySelector(".tree-column")!;

    expect(app.parentElement).toBe(shell);
    expect(tree.parentElement).toBe(shell);
    expect(app.contains(tree)).toBe(false);
    expect(tree.querySelector(".filetree-head")).not.toBeNull();
  });

  it("mounts the file viewer as a full-height sibling of the chat app", async () => {
    localStorage.removeItem("codexdesk.workbench.layout");
    readDirFixture = [
      {
        path: "/repo/LICENSE",
        name: "LICENSE",
        kind: "file",
        presentation: { mode: "text", language: "text", size: 0 },
      },
    ];
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});

    await act(async () => {
      (
        bar().querySelector(
          '[aria-label="Toggle the file tree (⌘B)"]',
        ) as HTMLButtonElement
      ).click();
    });
    const license = await screen.findByRole("treeitem", { name: "LICENSE" });
    await act(async () => license.click());
    await waitFor(() =>
      expect(document.querySelector(".side-panel")).not.toBeNull(),
    );

    const shell = document.querySelector(".workspace-shell")!;
    const app = document.querySelector(".app")!;
    const panel = document.querySelector(".side-panel")!;

    expect(app.parentElement).toBe(shell);
    expect(panel.parentElement).toBe(shell);
    expect(app.contains(panel)).toBe(false);
    expect(panel.querySelector(".tabstrip")).not.toBeNull();
    expect(panel.textContent).toContain("LICENSE");
  });

  it("keeps review comments visible on the overflow entry point", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A") }));
    render(<App />);
    await act(async () => {});
    await act(async () => {
      emit({
        type: "reviewNotes",
        threadId: "A",
        notes: [
          {
            id: "note-1",
            originConversationId: "A",
            anchor: {
              path: "a.ts",
              side: "after",
              span: { start: 1, end: 1 },
              contextDigest: "fnv1a32:00000000",
              context: {
                before: [],
                selected: ["line 1"],
                after: [],
              },
              baseRevision: null,
            },
            body: "why",
            assets: [],
            resolution: "located",
            currentLocation: {
              path: "a.ts",
              side: "after",
              span: { start: 1, end: 1 },
              sectionId: "a.ts:1",
            },
            createdAt: 1,
          },
        ],
      });
    });

    expect(bar().querySelector(".topbar-badge")?.textContent).toBe("1");
    await act(async () =>
      screen.getByRole("button", { name: "More actions" }).click(),
    );
    expect(
      screen.getByRole("menuitem", { name: /Review changes and ship/ }),
    ).toBeTruthy();
  });
});

describe("topbar rename", () => {
  it("renames in place rather than through a dialog", async () => {
    // `window.prompt` throws "prompt() is not supported" in Electron — found
    // by reading the renderer console, not by any test. Inline editing also
    // matches the gesture the sidebar already uses.
    const named = { ...view("A"), name: "Old name" };
    installBridge(snapshot({ activeThreadId: "A", view: named }));
    render(<App />);
    await act(async () => {});

    const title = document.querySelector(".topbar-title") as HTMLElement;
    await act(async () => {
      title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = document.querySelector(
      ".topbar-title-input",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "New name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(calls.renamed).toEqual([{ id: "A", name: "New name" }]);
  });

  it("abandons the edit on Escape", async () => {
    const named = { ...view("A"), name: "Old name" };
    installBridge(snapshot({ activeThreadId: "A", view: named }));
    render(<App />);
    await act(async () => {});

    await act(async () => {
      (document.querySelector(".topbar-title") as HTMLElement).dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });
    await act(async () => {
      const input = document.querySelector(
        ".topbar-title-input",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "Discarded");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(calls.renamed).toEqual([]);
    expect(document.querySelector(".topbar")?.textContent).toContain(
      "Old name",
    );
  });
});

/**
 * Capability surfaces (§4.5 / V2.4).
 *
 * Two things are worth asserting in the DOM rather than the mapper: that a
 * skill parse error is *visible* (it was previously dropped before it reached
 * the renderer at all), and that the mention picker offers capabilities —
 * which is the difference between a settings page and a usable feature.
 */
describe("capabilities panel", () => {
  const skill = (over: Record<string, unknown> = {}) =>
    ({
      name: "review-diff",
      description: "Review a diff carefully",
      path: "/repo/.agents/skills/review-diff/SKILL.md",
      scope: "repo",
      enabled: true,
      ...over,
    }) as never;

  const openSettings = async () => {
    await act(async () =>
      screen.getByRole("button", { name: "Account and settings" }).click(),
    );
    await act(async () =>
      screen.getByRole("menuitem", { name: "Settings" }).click(),
    );
  };

  const openPanel = async () => {
    await openSettings();
    await act(async () => screen.getByRole("tab", { name: "Skills" }).click());
  };

  it("opens General first and persists the notification mode", async () => {
    installBridge(
      snapshot({
        auth: {
          kind: "signedIn",
          account: {
            type: "chatgpt",
            email: "you@example.com",
            planType: "plus",
          },
        },
        notifyMode: "unfocused",
      }),
    );
    render(<App />);
    await act(async () => {});
    await openSettings();

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Signed in with ChatGPT")).toBeTruthy();
    expect(
      document.querySelector(".settings-account-card")?.textContent,
    ).toContain("you@example.com · plus");
    await act(async () =>
      screen.getByRole("radio", { name: "Always" }).click(),
    );
    expect(calls.notifyModes).toEqual(["always"]);
    expect(
      screen
        .getByRole("radio", { name: "Always" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("shows skills grouped by scope, with their parse errors", async () => {
    installBridge(
      snapshot({
        config: {
          ...snapshot().config,
          skills: { status: "ready", items: [skill()] },
          skillErrors: [
            { path: "/repo/.agents/skills/bad/SKILL.md", message: "no title" },
          ],
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await openPanel();

    const panel = document.querySelector(".capabilities-panel")!;
    expect(panel.textContent).toContain("review-diff");
    expect(panel.textContent).toContain("This repository");
    // The regression: errors used to be discarded in `loadConfig`, so a
    // malformed SKILL.md was an unexplained absence.
    expect(panel.textContent).toContain("no title");
  });

  it("toggles a skill by path", async () => {
    installBridge(
      snapshot({
        config: {
          ...snapshot().config,
          skills: { status: "ready", items: [skill()] },
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await openPanel();

    const toggle = document.querySelector<HTMLInputElement>(
      ".capability-toggle input",
    )!;
    await act(async () => fireEvent.click(toggle));
    expect(calls.skillToggles).toEqual([
      { path: "/repo/.agents/skills/review-diff/SKILL.md", enabled: false },
    ]);
  });

  it("offers only the web search modes the operator permits", async () => {
    installBridge(
      snapshot({
        config: {
          ...snapshot().config,
          webSearchMode: "cached",
          allowedWebSearchModes: ["disabled", "cached"],
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await openPanel();
    const tabs = [...document.querySelectorAll(".capabilities-tabs button")];
    await act(async () =>
      (tabs.find((t) => t.textContent === "Web search") as HTMLElement).click(),
    );

    const modes = [...document.querySelectorAll(".capability-mode")].map(
      (m) => m.querySelector(".capability-name")?.textContent,
    );
    // `live` is in the enum but not in the allow-list; offering it would put
    // a control in front of the user that an admin has disabled.
    expect(modes).toEqual(["Off", "Cached"]);
  });

  it("does not expose an unowned plugin installation action", async () => {
    installBridge(
      snapshot({
        capabilities: {
          plugins: { status: "ready", items: [] },
          mcpServers: { status: "idle", items: [] },
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await openPanel();
    const tabs = [...document.querySelectorAll(".capabilities-tabs button")];
    await act(async () =>
      (tabs.find((t) => t.textContent === "Plugins") as HTMLElement).click(),
    );

    const body = document.querySelector(".capabilities-body")!;
    expect(body.textContent).toContain("No plugins are available");
    expect([...body.querySelectorAll("button")]).toHaveLength(0);
  });
});

describe("terminal panel lifecycle", () => {
  it("hides without disposing the shell and reserves Kill for disposal", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A"),
        terminalAvailable: true,
      }),
    );
    render(<App />);
    await act(async () => {});

    await act(async () =>
      screen.getByRole("button", { name: "Toggle the terminal (⌘`)" }).click(),
    );
    let panel = document.querySelector(".bottom-panel") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.querySelector(".tab-close")).toBeNull();

    await act(async () =>
      within(panel).getByRole("button", { name: "Hide" }).click(),
    );
    expect(document.querySelector(".bottom-panel")?.classList).toContain(
      "hidden",
    );
    expect(calls.termClosed).toEqual([]);

    await act(async () =>
      screen.getByRole("button", { name: "Toggle the terminal (⌘`)" }).click(),
    );
    panel = document.querySelector(".bottom-panel") as HTMLElement;
    await act(async () =>
      within(panel).getByRole("button", { name: "Kill" }).click(),
    );
    expect(calls.termClosed).toEqual(["A"]);
    expect(document.querySelector(".bottom-panel")).toBeNull();
  });
});

describe("mention picker sources", () => {
  const skill = (name: string, enabled = true) =>
    ({
      name,
      description: `${name} description`,
      path: `/repo/.agents/skills/${name}/SKILL.md`,
      scope: "repo",
      enabled,
      displayName: null,
      shortDescription: null,
      defaultPrompt: `Run ${name}`,
    }) as never;

  const openPicker = async () => {
    const mention = [...document.querySelectorAll("button")].find(
      (b) =>
        b.getAttribute("aria-label") === "Add files, mentions, or commands",
    );
    await act(async () => mention!.click());
  };

  const typeAtCaret = async (text: string, caret = text.length) => {
    const textarea = document.querySelector(
      ".composer textarea",
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, text);
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return textarea;
  };

  it("lists enabled skills in the @ mention picker", async () => {
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A", ""),
        config: {
          ...snapshot().config,
          skills: { status: "ready", items: [skill("review-diff")] },
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await typeAtCaret("@rev");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    const list = document.querySelector(".mentions")!;
    expect(list.textContent).toContain("Skills");
    expect(list.textContent).toContain("review-diff");
  });

  it("renders the add menu as a searchable, sectioned recents palette", async () => {
    fileSearchFixture = [
      "ItemView.tsx",
      "ItemStreams.ts",
      "index.css",
      "QueuePane.tsx",
      "App.tsx",
    ].map((fileName, index) => ({
      path: `/repo/app/src/renderer/main_window/${fileName}`,
      file_name: fileName,
      root: "/repo",
      match_type: "file",
      score: 1 - index / 10,
      indices: [],
    }));
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A", ""),
      }),
    );
    render(<App />);
    await act(async () => {});
    await openPicker();

    const search = screen.getByRole("searchbox", {
      name: "Search files, commands, and plugins",
    });
    expect(document.activeElement).toBe(search);
    const menu = screen.getByRole("listbox", { name: "Add menu" });
    expect(menu.textContent).toContain("Files or photos…from disk");
    expect(menu.textContent).not.toContain("AddFiles or photos");
    expect(menu.textContent).not.toContain("Skills");

    await waitFor(() => expect(menu.textContent).toContain("3 of 5"));
    expect(menu.textContent).toContain("ItemView.tsxmain_window");
    expect(menu.textContent).toContain("type to reach the other 2");
    expect(menu.textContent).not.toContain("QueuePane.tsx");
    expect(document.querySelector(".composer-picker-help")?.textContent).toBe(
      "Recents per section.↑↓ to move, ↵ to insert.",
    );

    await act(async () =>
      fireEvent.change(search, { target: { value: "queue" } }),
    );
    await waitFor(() =>
      expect(calls.fileSearches.at(-1)).toEqual({
        query: "queue",
        workspaceRoot: "/repo",
      }),
    );
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    const composer = document.querySelector(
      ".composer textarea",
    ) as HTMLTextAreaElement;
    expect(composer.value).toBe("@app/src/renderer/main_window/ItemView.tsx ");
    expect(screen.queryByRole("listbox", { name: "Add menu" })).toBeNull();
    expect(calls.sent).toEqual([]);
  });

  it("omits a disabled skill", async () => {
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A", ""),
        config: {
          ...snapshot().config,
          skills: { status: "ready", items: [skill("off-skill", false)] },
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await typeAtCaret("@off");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    // Offering to invoke something the agent will not load is a broken
    // promise; the toggle that fixes it is one panel away.
    const list = document.querySelector(".mentions")!;
    expect(list.textContent).not.toContain("off-skill");
  });

  it("inserts the skill's starter prompt when one is picked", async () => {
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A", ""),
        config: {
          ...snapshot().config,
          skills: { status: "ready", items: [skill("review-diff")] },
        },
      }),
    );
    render(<App />);
    await act(async () => {});
    await typeAtCaret("@review");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const row = [...document.querySelectorAll(".mention")].find((entry) =>
      entry.textContent?.includes("review-diff"),
    )!;
    await act(async () => fireEvent.mouseDown(row));

    // `defaultPrompt` exists for exactly this; inserting the bare name would
    // leave the user guessing what the skill expects.
    const composer = document.querySelector("textarea")!;
    expect(composer.value).toContain("@review-diff Run review-diff");
  });

  it("opens / commands from typing and inserts the selected command", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {});

    const textarea = await typeAtCaret("/re");
    const list = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(list).getByRole("option").textContent).toContain("/review");
    expect(list.textContent).not.toContain("/compact");

    await act(async () => fireEvent.keyDown(textarea, { key: "Enter" }));
    expect(textarea.value).toBe("/review ");
    expect(document.querySelector(".mentions")).toBeNull();
    expect(calls.sent).toEqual([]);
    expect(calls.reviews).toEqual([]);
  });

  it("runs /review with custom instructions instead of sending prompt text", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {});

    const textarea = await typeAtCaret("/review focus on the queue");
    await act(async () =>
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" }),
    );

    expect(calls.reviews).toEqual([
      {
        threadId: "A",
        target: { type: "custom", instructions: "focus on the queue" },
      },
    ]);
    expect(calls.sent).toEqual([]);
  });

  it("runs /compact through the dedicated protocol action", async () => {
    installBridge(snapshot({ activeThreadId: "A", view: view("A", "") }));
    render(<App />);
    await act(async () => {});

    const textarea = await typeAtCaret("/compact");
    // Escape closes autocomplete, then Enter executes the exact command.
    await act(async () => fireEvent.keyDown(textarea, { key: "Escape" }));
    await act(async () =>
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" }),
    );
    expect(calls.compacted).toEqual(["A"]);
    expect(calls.sent).toEqual([]);
  });

  it("replaces an @ token at the caret without deleting text after it", async () => {
    installBridge(
      snapshot({
        activeThreadId: "A",
        view: view("A", ""),
        config: {
          ...snapshot().config,
          skills: { status: "ready", items: [skill("queue-inspector")] },
        },
      }),
    );
    render(<App />);
    await act(async () => {});

    const textarea = await typeAtCaret("Check @que after this", 10);
    const row = await screen.findByRole("option", {
      name: /queue-inspector/,
    });
    await act(async () => fireEvent.mouseDown(row));

    expect(textarea.value).toBe(
      "Check @queue-inspector Run queue-inspector after this",
    );
  });

  it("supports @ files in new chat and searches its selected project root", async () => {
    const project = {
      id: "p1",
      name: "CodexDesk",
      roots: ["/repo"],
      activeRoot: "/repo",
    };
    fileSearchFixture = [
      {
        path: "/repo/app/src/QueuePane.tsx",
        file_name: "QueuePane.tsx",
        root: "/repo",
        match_type: "file",
        score: 1,
        indices: [14, 15, 16],
      },
    ];
    installBridge(
      snapshot({
        cwd: "/repo",
        activeThreadId: "A",
        view: { ...view("A", ""), cwd: "/repo" },
        projects: [project],
        activeProjectId: "p1",
      }),
    );
    render(<App />);
    await act(async () => {});
    await act(async () =>
      screen.getByRole("button", { name: "New chat" }).click(),
    );

    const textarea = await typeAtCaret("Inspect @que");
    await waitFor(() =>
      expect(calls.fileSearches.at(-1)).toEqual({
        query: "que",
        workspaceRoot: "/repo",
      }),
    );
    const row = await screen.findByRole("option", { name: /QueuePane.tsx/ });
    await act(async () => fireEvent.mouseDown(row));

    expect(textarea.value).toBe("Inspect @app/src/QueuePane.tsx ");
  });
});
