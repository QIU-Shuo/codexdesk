import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  AppEvent,
  AuthState,
  ChangesView,
  LoginState,
  CapabilitiesState,
  ConfigState,
  GitBranchInfo,
  NotifyMode,
  PendingRequest,
  PreflightState,
  RequestAnswer,
  Project,
} from "../../shared/ipc";
import { ItemView, WorkDisclosure } from "./ItemView";
import { RequestCard } from "./RequestCard";
import { AutoReviewCard } from "./AutoReviewCard";
import { VirtualTranscript } from "./VirtualTranscript";
import { ThreadSidebar } from "./ThreadSidebar";
import {
  MentionPicker,
  type ComposerPickerMode,
  type MentionPick,
} from "./MentionPicker";
import { TerminalPane } from "./TerminalPane";
import { FileTree, FileTreeBoundary, FileViewer } from "./FileTree";
import {
  INITIAL_WORKBENCH,
  MIN_BOTTOM_HEIGHT,
  MIN_CHAT_WIDTH,
  clampToWidth,
  tabLabels,
  workbenchReducer,
} from "./workbench";
import {
  IconButton,
  OverflowMenu,
  PanelIcon,
  Splitter,
  TabStrip,
  ThreadTitle,
  TreeIcon,
  loadPersistedLayout,
  usePersistedLayout,
} from "./panels";
import { PromptCapture } from "./PromptCapture";
import { ModelPicker } from "./ModelPicker";
import { ApprovalPicker } from "./ApprovalPicker";
import { QueuePane } from "./QueuePane";
import { PlanStrip } from "./PlanStrip";
import { UsagePanel } from "./UsagePanel";
import { FileRefProvider } from "./Markdown";
import { CapabilitiesPanel, type CapabilityTab } from "./CapabilitiesPanel";
import { presentCapabilities } from "../compatibility/capabilityPresentation";
import {
  presentReviewNotes,
  type CurrentReviewComment,
} from "../compatibility/reviewPresentation";
import { presentOutbox } from "../compatibility/outboxPresentation";
import {
  presentThreadList,
  presentThreadView,
  type CurrentThreadListEntry,
  type CurrentThreadView,
} from "../compatibility/conversationPresentation";
import {
  presentDelivery,
  type CurrentDeliveryView,
} from "../compatibility/deliveryPresentation";
import { ChangesPane } from "./ChangesPane";
import { DeliveryBar } from "./DeliveryBar";
import { SignIn } from "./SignIn";
import { DEFAULT_BINDINGS, useShortcuts } from "./shortcuts";
import {
  buildTranscriptRows,
  endsSpeakerRun,
  speakerOf,
  startsSpeakerRun,
} from "./transcriptRows";
import {
  NewChatContextBar,
  NewChatWelcome,
  type DraftChatContext,
} from "./NewChat";

function accountLabel(auth: AuthState): string | undefined {
  if (auth.kind === "authenticated") return "Codex account";
  if (auth.kind !== "signedIn") return undefined;
  if (auth.account.type === "chatgpt") {
    return auth.account.email ?? "ChatGPT account";
  }
  if (auth.account.type === "apiKey") return "API key account";
  return "Amazon Bedrock";
}

function compactTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  const millions = value / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}m`;
}

function sidebarRequestDetail(request: PendingRequest): string {
  switch (request.kind) {
    case "commandApproval":
      return `${request.params.command ?? "Shell command"} — needs approval`;
    case "fileChangeApproval":
      return "File changes — needs approval";
    case "permissions":
      return "Additional permissions — needs approval";
    case "userInput":
      return "Question — needs your input";
    case "elicitation":
      return "MCP request — needs your input";
  }
}

/** Where the workbench layout is persisted. See `usePersistedLayout`. */
const LAYOUT_KEY = "codexdesk.workbench.layout.v2";

/** Fresh-project pane sizes from boards 1af–1ai; user drags override these. */
function responsiveWorkbenchDefaults() {
  const width = window.innerWidth;
  if (width >= 1600) {
    return {
      ...INITIAL_WORKBENCH,
      sidebarWidth: 280,
      treeWidth: 320,
      sideWidth: Math.max(440, width - 280 - 320 - 560),
    };
  }
  if (width >= 1400) {
    return { ...INITIAL_WORKBENCH, sidebarWidth: 240, treeWidth: 232 };
  }
  if (width >= 1280) return INITIAL_WORKBENCH;
  if (width >= 1100) {
    return { ...INITIAL_WORKBENCH, sidebarWidth: 180 };
  }
  return INITIAL_WORKBENCH;
}

type ComposerCompletion = {
  mode: ComposerPickerMode;
  query: string;
  /** UTF-16 offsets in the textarea value, matching selectionStart/End. */
  start: number;
  end: number;
};

type PendingAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  bytes: Uint8Array;
  preview?: string;
};

function attachmentFailureMessage(attachments: PendingAttachment[]): string {
  if (attachments.length === 1) {
    return `Could not attach ${attachments[0]!.name}. Remove it or try sending again.`;
  }
  return `Could not attach ${attachments.length} files. Remove them or try sending again.`;
}

/** Find the @mention or /command token immediately before the caret. */
function completionAt(value: string, caret: number): ComposerCompletion | null {
  const beforeCaret = value.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
  const command = /(^|\s)\/([^\s/]*)$/.exec(beforeCaret);
  const match = mention ?? command;
  if (!match) return null;
  const mode = mention ? "mention" : "command";
  const start = match.index + (match[1]?.length ?? 0);
  return {
    mode,
    query: match[2] ?? "",
    start,
    end: caret,
  };
}

/** Trim a path to its last two segments, so the topbar stays quiet. */
function shortenPath(p: string | null): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

const EMPTY_CONFIG: ConfigState = {
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
};

const EMPTY_CAPABILITIES: CapabilitiesState = {
  plugins: { status: "idle", items: [] },
  mcpServers: { status: "idle", items: [] },
};

/**
 * The renderer holds view state only. Thread state, git, and persistence all
 * live in the main process — this component renders whatever `threadView`
 * gives it, and sends commands back by id.
 */
export function App() {
  const [preflight, setPreflight] = useState<PreflightState>({
    kind: "checking",
  });
  const [auth, setAuth] = useState<AuthState>({ kind: "unknown" });
  /** In-flight sign-in (§8.5). Owned by main; this is render input only. */
  const [login, setLogin] = useState<LoginState>({ kind: "idle" });
  const [cwd, setCwd] = useState<string | null>(null);
  const [threads, setThreads] = useState<CurrentThreadListEntry[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [view, setView] = useState<CurrentThreadView | null>(null);
  const [config, setConfig] = useState<ConfigState>(EMPTY_CONFIG);
  const [capabilities, setCapabilities] =
    useState<CapabilitiesState>(EMPTY_CAPABILITIES);
  /** Which capability page the settings modal shows, or null when closed. */
  const [capabilitiesTab, setCapabilitiesTab] = useState<CapabilityTab | null>(
    null,
  );
  /** Notification mode, edited from the capabilities settings surface. */
  const [notifyMode, setNotifyMode] = useState<NotifyMode>("unfocused");
  const [showUsage, setShowUsage] = useState(false);
  const [useWorktrees, setUseWorktrees] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /**
   * A new chat is a renderer draft, not an empty server thread.
   * Context remains editable until the first send creates the real thread.
   */
  const [newChatDraft, setNewChatDraft] = useState<DraftChatContext | null>(
    null,
  );
  const [gitBranches, setGitBranches] = useState<GitBranchInfo | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [composerCompletion, setComposerCompletion] =
    useState<ComposerCompletion | null>(null);
  /**
   * Workbench layout: side and bottom panels, their tabs, and the file tree
   * column (see `workbench.ts`). This replaced the `showFiles` /
   * `showTerminal` / `openFile` booleans, which competed for the same
   * horizontal space and left the chat ~48px wide with two panes open.
   */
  const [workbench, dispatchWorkbench] = useReducer(
    workbenchReducer,
    INITIAL_WORKBENCH,
    () =>
      loadPersistedLayout(
        `${LAYOUT_KEY}:recent`,
        responsiveWorkbenchDefaults(),
      ),
  );
  /** Bumped on `fs/changed` so the tree and viewer re-read (§12.4). */
  const [changeToken, setChangeToken] = useState(0);
  /** Review and ship (§7). Owned by main; this is render input only. */
  /** Review-and-ship visibility, reachable from the topbar overflow. */
  const [showChanges, setShowChanges] = useState(false);
  const [changes, setChanges] = useState<ChangesView | null>(null);
  const [delivery, setDelivery] = useState<CurrentDeliveryView | null>(null);
  const [comments, setComments] = useState<CurrentReviewComment[]>([]);
  /** Set in a window opened for one thread (3.2) or for quick chat (4.7). */
  const [role, setRole] = useState<{
    pinnedThreadId: string | null;
    promptCapture: boolean;
  }>({ pinnedThreadId: null, promptCapture: false });
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [sidebarSearchRequest, setSidebarSearchRequest] = useState(0);
  const [terminalAvailable, setTerminalAvailable] = useState(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  /** Target of the `Mod+K` shortcut; the palette's own state stays in the
   * sidebar, so only focus is lifted here. */
  const threadFilterRef = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const activeRef = useRef<string | null>(null);
  /** Which thread the in-composer draft belongs to (guards the leak above). */
  const draftThreadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!newChatDraft?.cwd) {
      setGitBranches(null);
      setLoadingBranches(false);
      return;
    }
    let cancelled = false;
    setLoadingBranches(true);
    setGitBranches(null);
    void window.codexDesk.readGitBranches(newChatDraft.cwd).then((info) => {
      if (cancelled) return;
      setGitBranches(info);
      setLoadingBranches(false);
    });
    return () => {
      cancelled = true;
    };
  }, [newChatDraft?.cwd]);

  useEffect(() => {
    void window.codexDesk.getSnapshot().then((s) => {
      setPreflight(s.preflight);
      setAuth(s.auth);
      setCwd(s.cwd);
      setThreads(presentThreadList(s.threads));
      setActiveThreadId(s.activeThreadId);
      activeRef.current = s.activeThreadId;
      setView(s.view ? presentThreadView(s.view) : null);
      setConfig(s.config);
      setCapabilities(presentCapabilities(s.capabilities));
      setNotifyMode(s.notifyMode);
      setUseWorktrees(s.useWorktrees);
      setTerminalAvailable(s.terminalAvailable !== false);
      setProjects(s.projects);
      setActiveProjectId(s.activeProjectId);
      setRole({
        pinnedThreadId: s.pinnedThreadId ?? null,
        promptCapture: s.promptCapture ?? false,
      });
      // A window opened for one thread shows that thread, not whatever the
      // main window happens to have active.
      if (s.pinnedThreadId) void window.codexDesk.openThread(s.pinnedThreadId);
      if (s.view) {
        setDraft(s.view.draft);
        draftThreadRef.current = s.view.threadId;
      }
    });

    return window.codexDesk.onEvent((ev: AppEvent) => {
      revision.current++;
      switch (ev.type) {
        case "preflight":
          setPreflight(ev.state);
          break;
        case "auth":
          setAuth(ev.state);
          break;
        case "login":
          setLogin(ev.state);
          break;
        case "workspace":
          setCwd(ev.cwd);
          break;
        case "threads":
          setThreads(presentThreadList(ev.threads));
          break;
        case "activeThread":
          // Update the ref synchronously, not via render: main emits
          // `activeThread` and `threadView` back to back, and React batches
          // them, so a ref that only updates on render would still hold the
          // *previous* thread and the view would be discarded.
          activeRef.current = ev.threadId;
          setActiveThreadId(ev.threadId);
          // Drop the composer contents on switch; the incoming threadView
          // supplies the new thread's own draft.
          setDraft("");
          draftThreadRef.current = ev.threadId;
          if (!ev.threadId) setView(null);
          // Review state belongs to the thread that was being reviewed —
          // carrying a diff or comments across a switch would attribute one
          // thread's changes to another.
          setChanges(null);
          setDelivery(null);
          setComments([]);
          break;
        case "threadView":
          // Main owns thread state; this is the authoritative render input.
          if (ev.view.threadId === activeRef.current) {
            setView(presentThreadView(ev.view));
            // Only preserve local edits for the *same* thread. Keeping a
            // non-empty draft across a thread switch put thread A's text
            // into thread B's composer, and the save effect then persisted
            // it under B — silent cross-thread data corruption.
            setDraft((d) =>
              draftThreadRef.current === ev.view.threadId && d !== ""
                ? d
                : ev.view.draft,
            );
            draftThreadRef.current = ev.view.threadId;
          }
          break;
        case "config":
          setConfig(ev.config);
          break;
        case "capabilities":
          setCapabilities(presentCapabilities(ev.capabilities));
          break;
        case "filesChanged":
          setChangeToken((t) => t + 1);
          break;
        case "changes":
          // Gated on the active thread for the same reason `threadView` is: a
          // background thread's diff must not replace what you are reading.
          if (ev.threadId === activeRef.current) setChanges(ev.changes);
          break;
        case "delivery":
          if (ev.threadId === activeRef.current) {
            setDelivery(presentDelivery(ev.state));
          }
          break;
        case "reviewNotes":
          if (ev.threadId === activeRef.current) {
            setComments(presentReviewNotes(ev.notes));
          }
          break;
        case "projects":
          setProjects(ev.projects);
          setActiveProjectId(ev.activeProjectId);
          break;
        case "checkout":
          if (ev.state.kind === "failed") {
            console.error(`checkout: ${ev.state.message}`);
          }
          break;
        // The log panel is gone, but main still emits these — several are the
        // only report of a failure (handshake, app-server exit, a dropped
        // attachment). Route them to the console rather than dropping them.
        case "log":
          if (ev.level === "error") console.error(ev.message);
          else console.info(ev.message);
          break;
      }
    });
  }, []);

  /**
   * Send, and put the draft back if it did not go.
   *
   * The box is cleared optimistically because waiting on the round-trip makes
   * every send feel slow. That is only safe if failure restores it: a full
   * queue, a dead transport, or a thread that vanished would otherwise delete
   * what the user typed — and the debounced `saveDraft` effect below would
   * then persist the empty value over the copy the main process kept. The
   * orchestrator already declined to clear its own draft on failure; this is
   * the half that was missing.
   *
   * The restore is guarded on the thread still being the active one. Dropping
   * recovered text into a different thread's composer is the draft-leak bug
   * from Phase 3, and a failed send is not worth reintroducing it.
   */
  const uploadAttachments = useCallback(
    async (threadId: string, attachments: PendingAttachment[]) => {
      const failed: PendingAttachment[] = [];
      for (const attachment of attachments) {
        try {
          const saved = await window.codexDesk.addAttachment(threadId, {
            name: attachment.name,
            kind: attachment.kind,
            bytes: attachment.bytes,
            preview: attachment.preview,
          });
          if (!saved) failed.push(attachment);
        } catch {
          failed.push(attachment);
        }
      }
      return failed;
    },
    [],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const slash = /^\/(review|compact)(?:\s+([\s\S]+))?$/.exec(text);

    if (newChatDraft) {
      // There is no context to compact yet. Keep the command in the composer
      // instead of creating an empty task solely to compact it.
      if (slash?.[1] === "compact") return;
      const context = newChatDraft;
      setDraft("");
      setComposerCompletion(null);
      const threadId = await window.codexDesk.newThread({
        cwd: context.cwd,
        projectId: context.projectId,
        useWorktree: context.useWorktree,
        baseBranch: context.baseBranch ?? undefined,
      });
      if (!threadId) {
        setDraft(text);
        return;
      }
      const failedAttachments = await uploadAttachments(
        threadId,
        pendingAttachments,
      );
      setPendingAttachments(failedAttachments);
      setNewChatDraft(null);
      draftThreadRef.current = threadId;
      if (failedAttachments.length > 0) {
        setAttachmentError(attachmentFailureMessage(failedAttachments));
        setDraft(text);
        return;
      }
      setAttachmentError(null);
      if (slash?.[1] === "review") {
        const reviewThreadId = await window.codexDesk.startReview(
          threadId,
          slash[2]
            ? { type: "custom", instructions: slash[2] }
            : { type: "uncommittedChanges" },
        );
        if (!reviewThreadId) setDraft(text);
        return;
      }
      const res = await window.codexDesk.sendMessage(threadId, text);
      if (res?.error) setDraft(text);
      return;
    }

    if (!activeThreadId) return;
    const sentFrom = activeThreadId;

    if (pendingAttachments.length > 0) {
      const failedAttachments = await uploadAttachments(
        sentFrom,
        pendingAttachments,
      );
      setPendingAttachments(failedAttachments);
      if (failedAttachments.length > 0) {
        setAttachmentError(attachmentFailureMessage(failedAttachments));
        return;
      }
      setAttachmentError(null);
    }

    // Slash commands are client actions, not prompts for the model. Keeping
    // them out of `sendMessage` also means /compact uses the protocol's
    // dedicated compaction turn and /review opens the detached review task.
    if (slash) {
      setDraft("");
      setComposerCompletion(null);
      const ok =
        slash[1] === "compact"
          ? await window.codexDesk.compactThread(sentFrom)
          : Boolean(
              await window.codexDesk.startReview(
                sentFrom,
                slash[2]
                  ? { type: "custom", instructions: slash[2] }
                  : { type: "uncommittedChanges" },
              ),
            );
      if (!ok && draftThreadRef.current === sentFrom) setDraft(text);
      return;
    }

    setDraft("");
    setComposerCompletion(null);
    const res = await window.codexDesk.sendMessage(sentFrom, text);
    if (res?.error) {
      setDraft((current) => {
        if (draftThreadRef.current !== sentFrom) return current;
        // Anything typed since the failure wins; the user has moved on.
        return current ? current : text;
      });
    }
  }, [
    draft,
    activeThreadId,
    newChatDraft,
    pendingAttachments,
    uploadAttachments,
  ]);

  /**
   * The composer's trailing control has one button and three states:
   *   - running + empty box  → Stop (interrupt the turn)
   *   - running + typed text  → Send (queues/steers; does not stop)
   *   - idle                  → Send (disabled when empty)
   */
  const running = newChatDraft ? false : (view?.running ?? false);
  const hasText = draft.trim().length > 0;
  const blocked = preflight.kind !== "ready";
  const waitingForDecision = Boolean(
    !newChatDraft && view?.entries.some((entry) => entry.kind === "request"),
  );
  const composerUnavailable = blocked || waitingForDecision;
  const composerMode: "send" | "stop" | "disabled" = composerUnavailable
    ? "disabled"
    : running && !hasText
      ? "stop"
      : hasText
        ? "send"
        : "disabled";

  const composerAction = useCallback(() => {
    if (composerMode === "stop") {
      if (activeThreadId) void window.codexDesk.interrupt(activeThreadId);
    } else if (composerMode === "send") {
      void send();
    }
  }, [activeThreadId, composerMode, send]);

  const answer = useCallback((requestId: string | number, a: RequestAnswer) => {
    void window.codexDesk.answerRequest(requestId, a);
  }, []);

  // Auto-grow the composer with its content, capped so it never eats the
  // transcript. Runs on every draft change and on thread switch.
  useEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [draft, activeThreadId]);

  useEffect(() => {
    setComposerCompletion(null);
  }, [activeThreadId, newChatDraft?.cwd]);

  useEffect(() => {
    if (!activeThreadId || newChatDraft) return;
    // Belt and braces: never persist a draft under a thread it did not come
    // from, even if a render lands between the switch and this effect.
    if (draftThreadRef.current !== activeThreadId) return;
    const timer = setTimeout(() => {
      void window.codexDesk.saveDraft(activeThreadId, draft);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, activeThreadId, newChatDraft]);

  const beginNewChat = useCallback(
    (context?: { cwd?: string; projectId?: string | null }) => {
      const activeEntry = threads.find(
        (thread) => thread.threadId === activeThreadId,
      );
      const inheritedProjectId =
        context?.projectId !== undefined
          ? context.projectId
          : (activeEntry?.projectId ?? activeProjectId);
      const inheritedProject = projects.find(
        (project) => project.id === inheritedProjectId,
      );
      const inheritedCwd =
        context?.cwd ??
        (activeEntry?.worktreePath
          ? inheritedProject?.activeRoot
          : activeEntry?.cwd) ??
        inheritedProject?.activeRoot ??
        view?.cwd ??
        cwd;
      if (!inheritedCwd) return;

      setNewChatDraft({
        cwd: inheritedCwd,
        projectId: inheritedProjectId ?? null,
        useWorktree: useWorktrees,
        baseBranch: null,
      });
      setDraft("");
      setPendingAttachments([]);
      setAttachmentError(null);
      setComposerCompletion(null);
      draftThreadRef.current = null;
      setShowChanges(false);
      // Panels are workspace furniture, not thread state: a new chat should
      // not sweep away the file you were reading. Terminals are dropped by
      // the `threadChanged` effect, since a shell belongs to its thread.
      dispatchWorkbench({ type: "togglePanel", panel: "bottom" });
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [
      threads,
      activeThreadId,
      activeProjectId,
      projects,
      view?.cwd,
      cwd,
      useWorktrees,
    ],
  );

  const openThread = useCallback((threadId: string) => {
    setNewChatDraft(null);
    setPendingAttachments([]);
    setAttachmentError(null);
    void window.codexDesk.openThread(threadId);
  }, []);

  const addProjectFromNewChat = useCallback(async () => {
    const selectedRoot = await window.codexDesk.selectWorkspace();
    if (!selectedRoot) return;
    // The projects event normally arrives first, but read back the snapshot so
    // the draft context changes atomically even if renderer event delivery is
    // delayed behind the native folder picker.
    const next = await window.codexDesk.getSnapshot();
    setProjects(next.projects);
    setActiveProjectId(next.activeProjectId);
    const project = next.projects.find((candidate) =>
      candidate.roots.includes(selectedRoot),
    );
    setNewChatDraft((current) =>
      current
        ? {
            ...current,
            cwd: selectedRoot,
            projectId: project?.id ?? null,
            baseBranch: null,
          }
        : current,
    );
  }, []);

  const openFolderFromSearch = useCallback(async () => {
    const selectedRoot = await window.codexDesk.selectWorkspace();
    if (!selectedRoot) return;
    const next = await window.codexDesk.getSnapshot();
    setProjects(next.projects);
    setActiveProjectId(next.activeProjectId);
    const project = next.projects.find((candidate) =>
      candidate.roots.includes(selectedRoot),
    );
    beginNewChat({
      cwd: selectedRoot,
      projectId: project?.id ?? null,
    });
  }, [beginNewChat]);

  const searchFilesFromPalette = useCallback(() => {
    if (!activeThreadId && !newChatDraft) return;
    let tokenStart = 0;
    let tokenEnd = 0;
    setDraft((current) => {
      const existing = /@[^\s@]*$/.exec(current);
      if (existing) {
        tokenStart = existing.index;
        tokenEnd = current.length;
        return current;
      }
      const spacer = current !== "" && !current.endsWith(" ") ? " " : "";
      tokenStart = current.length + spacer.length;
      tokenEnd = tokenStart + 1;
      return `${current}${spacer}@`;
    });
    setComposerCompletion({
      mode: "mention",
      query: "",
      start: tokenStart,
      end: tokenEnd,
    });
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(tokenEnd, tokenEnd);
    });
  }, [activeThreadId, newChatDraft]);

  // Shortcuts are a data table rather than scattered key comparisons, so
  // they can be rebound without touching handlers (plan §6, 4.8).
  useShortcuts(DEFAULT_BINDINGS, {
    newThread: () => beginNewChat({ projectId: null }),
    interrupt: () => {
      if (view?.running && activeThreadId) {
        void window.codexDesk.interrupt(activeThreadId);
      }
    },
    toggleTerminal: () => {
      // With no tab yet this has to create one, or the shortcut toggles an
      // empty panel and appears to do nothing.
      if (bottomPanel.tabs.length === 0) {
        if (activeThreadId && terminalAvailable) {
          dispatchWorkbench({ type: "openTerminal", threadId: activeThreadId });
        }
      } else {
        dispatchWorkbench({ type: "togglePanel", panel: "bottom" });
      }
    },
    toggleFiles: () => dispatchWorkbench({ type: "toggleTree" }),
    focusComposer: () => composerRef.current?.focus(),
    filterThreads: () => {
      setSidebarSearchRequest((request) => request + 1);
    },
    openFolder: () => void openFolderFromSearch(),
    searchFiles: searchFilesFromPalette,
    nextThread: () => {
      const i = threads.findIndex((t) => t.threadId === activeThreadId);
      const next = threads[i + 1] ?? threads[0];
      if (next) void window.codexDesk.openThread(next.threadId);
    },
    prevThread: () => {
      const i = threads.findIndex((t) => t.threadId === activeThreadId);
      const prev = threads[i - 1] ?? threads[threads.length - 1];
      if (prev) void window.codexDesk.openThread(prev.threadId);
    },
  });

  const entries = view?.entries ?? [];
  const isNewChat = newChatDraft !== null;
  const requestEntries = useMemo(
    () => entries.filter((entry) => entry.kind === "request"),
    [entries],
  );
  const transcriptRows = useMemo(
    () => buildTranscriptRows(entries, view?.deltas ?? {}),
    [entries, view?.deltas],
  );
  const responseTurns = useMemo(
    () =>
      new Set(
        entries.flatMap((entry) =>
          entry.kind === "item" &&
          entry.item.type === "agentMessage" &&
          entry.item.phase !== "commentary"
            ? [entry.turnId]
            : [],
        ),
      ),
    [entries],
  );
  const outboxPresentation = view ? presentOutbox(view.outbox) : null;
  const workspaceRoot = newChatDraft?.cwd ?? view?.worktreePath ?? cwd;
  const tokenUsage = view?.budget.tokenUsage;
  const contextUsage = tokenUsage?.modelContextWindow
    ? `${compactTokenCount(tokenUsage.total.totalTokens)} / ${compactTokenCount(tokenUsage.modelContextWindow)}`
    : null;
  const composerAttachments = newChatDraft
    ? pendingAttachments
    : [...(view?.attachments ?? []), ...pendingAttachments];
  const changesVisible = !isNewChat && showChanges && Boolean(activeThreadId);
  /** The tree column only makes sense with a workspace behind it. */
  const treeVisible =
    !isNewChat && workbench.treeVisible && Boolean(workspaceRoot);
  const sidePanel = workbench.side;
  const bottomPanel = workbench.bottom;
  const sidePanelVisible =
    sidePanel.visible &&
    sidePanel.tabs.length > 0 &&
    // A projectless draft has no checkout to which an inherited file tab can
    // truthfully belong. Keep the tab in memory, but remove the pane until a
    // project is selected or an existing chat is reopened.
    !(isNewChat && newChatDraft?.projectId === null);
  const activeSideTab =
    sidePanel.tabs.find((t) => t.id === sidePanel.activeId) ?? null;
  const sideLabels = useMemo(() => tabLabels(sidePanel.tabs), [sidePanel.tabs]);
  const bottomLabels = useMemo(
    () => tabLabels(bottomPanel.tabs),
    [bottomPanel.tabs],
  );
  /** The file the tree should highlight — only when a file tab is showing. */
  const activeFilePath =
    activeSideTab?.kind === "file" ? activeSideTab.path : null;

  /**
   * What the topbar calls this chat.
   *
   * A thread keeps its server-assigned name until renamed, and an unnamed one
   * has none at all — so fall back to the workspace, which is at least true,
   * rather than showing an empty bar.
   */
  const threadName =
    view?.name ??
    threads.find((t) => t.threadId === activeThreadId)?.name ??
    (shortenPath(view?.cwd ?? cwd) || "New chat");

  /** Remaining window surface after the thread sidebar: chat plus tree rail. */
  const shellRef = useRef<HTMLDivElement>(null);
  /** Chat workbench only: transcript and optional bottom panel. */
  const layoutRef = useRef<HTMLDivElement>(null);

  const layoutScope = activeProjectId ?? "recent";
  const layoutScopeRef = useRef(layoutScope);
  useEffect(() => {
    if (layoutScopeRef.current === layoutScope) return;
    layoutScopeRef.current = layoutScope;
    dispatchWorkbench({
      type: "restore",
      state: loadPersistedLayout(
        `${LAYOUT_KEY}:${layoutScope}`,
        responsiveWorkbenchDefaults(),
      ),
    });
  }, [layoutScope]);
  usePersistedLayout(
    `${LAYOUT_KEY}:${layoutScope}`,
    workbench,
    layoutScopeRef.current === layoutScope,
  );

  // Terminals belong to a thread; files do not. Switching threads drops the
  // terminal tabs and leaves the file tabs alone.
  useEffect(() => {
    dispatchWorkbench({ type: "threadChanged", threadId: activeThreadId });
  }, [activeThreadId]);

  /**
   * Keep the chat above its floor when the window narrows.
   *
   * Panels are stored in pixels, so shrinking the window would otherwise
   * squeeze the chat to nothing — which is the failure the old competing
   * panes had, just reached a different way.
   */
  useEffect(() => {
    const onResize = () => {
      // Below the desktop breakpoint the viewer and tree become sheets over
      // the chat. Their remembered desktop widths must not be destroyed just
      // because the window briefly became narrow.
      if (window.innerWidth < 1100) return;
      const available = shellRef.current?.clientWidth;
      if (!available) return;
      const clamped = clampToWidth(workbench, available);
      if (
        clamped.sideWidth !== workbench.sideWidth ||
        clamped.treeWidth !== workbench.treeWidth
      ) {
        dispatchWorkbench({
          type: "resize",
          sideWidth: clamped.sideWidth,
          treeWidth: clamped.treeWidth,
        });
      }
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [workbench]);

  const openFileInWorkbench = useCallback((path: string, preview: boolean) => {
    dispatchWorkbench({ type: "openFile", path, preview });
  }, []);

  /**
   * Open a `[label](path:line)` citation from an agent message.
   *
   * Relative paths resolve against the thread's workspace root — an agent
   * working in a worktree cites paths relative to *that*, so resolving
   * against the project root would open the wrong copy of the file. Opens as
   * a preview tab: following a chain of citations should not leave a dozen
   * tabs behind, which is the same rule the file tree follows.
   */
  const openFileRef = useCallback(
    (path: string, line?: number) => {
      const abs = path.startsWith("/")
        ? path
        : `${workspaceRoot ?? ""}/${path.replace(/^\.\//, "")}`;
      dispatchWorkbench({ type: "openFile", path: abs, preview: true, line });
    },
    [workspaceRoot],
  );

  const addFileToChat = useCallback(
    (path: string) => {
      const relative =
        workspaceRoot && path.startsWith(`${workspaceRoot}/`)
          ? path.slice(workspaceRoot.length + 1)
          : path;
      let nextCaret = 0;
      setDraft((current) => {
        const textarea = composerRef.current;
        const start = textarea?.selectionStart ?? current.length;
        const end = textarea?.selectionEnd ?? start;
        const spacer =
          start > 0 && !/\s$/.test(current.slice(0, start)) ? " " : "";
        const insertion = `${spacer}@${relative} `;
        nextCaret = start + insertion.length;
        return `${current.slice(0, start)}${insertion}${current.slice(end)}`;
      });
      setComposerCompletion(null);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [workspaceRoot],
  );

  // Recompute the diff when the pane opens, when a turn finishes, and when
  // the watcher sees an edit. §7.1 asks for both sources: work done in the
  // terminal never arrives as a turn diff.
  useEffect(() => {
    if (!changesVisible || !activeThreadId) return;
    void window.codexDesk.refreshChanges(activeThreadId);
  }, [changesVisible, activeThreadId, changeToken, view?.running]);

  const renderRow = useMemo(
    () => (index: number) => {
      const entry = transcriptRows[index];
      if (!entry) return null;
      // The turn shell is an alignment column, not a container: rows are
      // virtualized and render independently, so each draws the column and
      // only the first of a run fills in the name. See `startsSpeakerRun`.
      const speaker = speakerOf(entry);
      const startsRun = startsSpeakerRun(transcriptRows, index);
      const endsRun = endsSpeakerRun(transcriptRows, index);
      const wrap = (content: React.ReactNode) => (
        <div
          className="turn"
          data-speaker={speaker ?? "none"}
          data-run-start={startsRun}
          data-run-end={endsRun}
        >
          <span className="turn-role" aria-hidden={true}>
            {startsRun ? (speaker === "user" ? "You" : "Codex") : ""}
          </span>
          <div className="turn-body">{content}</div>
        </div>
      );

      if (entry.kind === "work") {
        return wrap(
          <WorkDisclosure
            entries={entry.entries}
            deltas={view?.deltas ?? {}}
            workComplete={
              responseTurns.has(entry.turnId) ||
              Boolean(view?.turnIds.includes(entry.turnId))
            }
            turnComplete={Boolean(view?.turnIds.includes(entry.turnId))}
            pendingRequests={entry.pendingRequests ?? []}
            durationMs={entry.durationMs}
            onOpenFile={openFileRef}
            workspaceRoot={workspaceRoot ?? undefined}
          />,
        );
      }
      // Correlatable requests are absorbed into their work row during
      // transcript shaping and also rendered in the dock above the composer.
      // Keep this guard defensive so a future row source cannot duplicate one.
      if (entry.kind === "request") return null;
      if (entry.kind === "review") {
        return wrap(<AutoReviewCard review={entry.review} />);
      }
      if (entry.kind === "retry") {
        // Each reconnect attempt remains visible as transcript history.
        return wrap(
          <div className="item note retry" title={entry.message}>
            <div className="tag">
              <span className="mark running" aria-hidden="true">
                ⇄
              </span>{" "}
              {entry.attempt !== null && entry.max !== null
                ? `Reconnecting ${entry.attempt}/${entry.max}`
                : entry.message}
            </div>
          </div>,
        );
      }
      // Lifecycle timestamps tell us whether an item is truly still working.
      // This is more reliable than treating the newest row as active: a turn
      // can finish a thought, run a command, then continue with another item.
      const isActive = Boolean(
        view?.running &&
        entry.startedAtMs !== undefined &&
        entry.completedAtMs === undefined,
      );
      const turnCompleted = Boolean(view?.turnIds.includes(entry.turnId));
      return wrap(
        <ItemView
          item={entry.item}
          streams={view?.deltas[entry.id]}
          active={isActive}
          turnId={entry.turnId}
          turnCompleted={turnCompleted}
          startedAtMs={entry.startedAtMs}
          completedAtMs={entry.completedAtMs}
          onBranch={(turnId) =>
            activeThreadId
              ? window.codexDesk.forkThread(activeThreadId, turnId)
              : Promise.resolve(null)
          }
          onOpenFile={openFileRef}
          workspaceRoot={workspaceRoot ?? undefined}
        />,
      );
    },
    [
      transcriptRows,
      responseTurns,
      view?.deltas,
      view?.running,
      view?.turnIds,
      activeThreadId,
      answer,
      openFileRef,
      workspaceRoot,
    ],
  );

  const onDraftChange = (value: string, caret: number) => {
    setDraft(value);
    setComposerCompletion(completionAt(value, caret));
  };

  /** Paste or drop an image/file into the composer (4.4). */
  const attachFiles = async (files: FileList | File[]) => {
    if (!activeThreadId && !newChatDraft) return;
    const failedAttachments: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isImage = file.type.startsWith("image/");
      const preview = isImage
        ? await new Promise<string | undefined>((res) => {
            const reader = new FileReader();
            reader.onload = () => res(String(reader.result));
            reader.onerror = () => res(undefined);
            reader.readAsDataURL(file);
          })
        : undefined;
      const attachment: PendingAttachment = {
        id:
          globalThis.crypto?.randomUUID?.() ??
          `pending-${Date.now()}-${file.name}`,
        name: file.name || (isImage ? "pasted-image.png" : "file"),
        kind: isImage ? "image" : "file",
        bytes,
        preview,
      };
      if (newChatDraft) {
        setPendingAttachments((current) => [...current, attachment]);
      } else if (activeThreadId) {
        try {
          const saved = await window.codexDesk.addAttachment(
            activeThreadId,
            attachment,
          );
          if (!saved) failedAttachments.push(attachment);
        } catch {
          failedAttachments.push(attachment);
        }
      }
    }
    if (newChatDraft) {
      setAttachmentError(null);
    } else if (failedAttachments.length > 0) {
      setPendingAttachments((current) => [...current, ...failedAttachments]);
      setAttachmentError(attachmentFailureMessage(failedAttachments));
    } else if (pendingAttachments.length === 0) {
      setAttachmentError(null);
    }
  };

  /**
   * Insert a mention. Files become a path; a skill or plugin becomes its
   * name, followed by its starter prompt when it has one — that is what
   * `defaultPrompt` is for, and inserting the bare name would leave the user
   * to guess what the capability expects.
   */
  const pickMention = (pick: MentionPick) => {
    const completion = composerCompletion;
    if (!completion) return;
    if (pick.kind === "attachment") {
      setDraft(
        (current) =>
          `${current.slice(0, completion.start)}${current.slice(completion.end)}`,
      );
      setComposerCompletion(null);
      attachmentInputRef.current?.click();
      return;
    }
    const filePath =
      pick.kind === "file" &&
      workspaceRoot &&
      pick.path.startsWith(`${workspaceRoot}/`)
        ? pick.path.slice(workspaceRoot.length + 1)
        : pick.kind === "file"
          ? pick.path
          : null;
    const rawInsert =
      pick.kind === "command"
        ? `/${pick.command} `
        : pick.kind === "file"
          ? `@${filePath} `
          : pick.prompt
            ? `@${pick.name} ${pick.prompt} `
            : `@${pick.name} `;
    const insert = /^\s/.test(draft.slice(completion.end))
      ? rawInsert.trimEnd()
      : rawInsert;
    const nextCaret = completion.start + insert.length;
    setDraft(
      (current) =>
        `${current.slice(0, completion.start)}${insert}${current.slice(completion.end)}`,
    );
    setComposerCompletion(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  if (role.promptCapture) return <PromptCapture />;

  return (
    <div
      className={`app-shell${workbench.sidebarVisible ? "" : " sidebar-hidden"}`}
    >
      {!role.pinnedThreadId && workbench.sidebarVisible && (
        <ThreadSidebar
          width={workbench.sidebarWidth}
          threads={threads}
          activeThreadId={isNewChat ? null : activeThreadId}
          newChatActive={isNewChat}
          queuedThreadId={
            (view?.outbox.entries.length ?? 0) > 0 ? view?.threadId : null
          }
          attention={
            requestEntries.at(-1) && activeThreadId
              ? {
                  threadId: activeThreadId,
                  detail: sidebarRequestDetail(requestEntries.at(-1)!.request),
                }
              : null
          }
          onOpen={openThread}
          onNew={beginNewChat}
          onPin={(id, pinned) => void window.codexDesk.pinThread(id, pinned)}
          onArchive={(id, archived) =>
            void window.codexDesk.archiveThread(id, archived)
          }
          onDelete={(id) => void window.codexDesk.deleteThread(id)}
          onRename={(id, name) => void window.codexDesk.renameThread(id, name)}
          onOpenInNewWindow={(id) => void window.codexDesk.openInNewWindow(id)}
          projects={projects}
          onRemoveProject={(id) => void window.codexDesk.removeProject(id)}
          onRenameProject={(id, name) =>
            window.codexDesk.renameProject(id, name)
          }
          onRevealProject={(id) => void window.codexDesk.revealProject(id)}
          onRegisterIsolatedWorkspace={(projectId, name) =>
            window.codexDesk.registerIsolatedWorkspace(projectId, name)
          }
          onOpenFolder={() => void openFolderFromSearch()}
          onSearchFiles={searchFilesFromPalette}
          canSearchFiles={Boolean(activeThreadId && !isNewChat)}
          searchRequest={sidebarSearchRequest}
          accountLabel={accountLabel(auth)}
          onOpenUsage={
            auth.kind === "signedIn" || auth.kind === "authenticated"
              ? () => setShowUsage(true)
              : undefined
          }
          onOpenCapabilities={() => setCapabilitiesTab("general")}
          onSignOut={
            auth.kind === "signedIn" || auth.kind === "authenticated"
              ? () => void window.codexDesk.logout()
              : undefined
          }
          filterRef={threadFilterRef}
        />
      )}
      {!role.pinnedThreadId && workbench.sidebarVisible && (
        <Splitter
          className="sidebar-splitter"
          orientation="vertical"
          label="Resize the chat list"
          onResize={(x) =>
            dispatchWorkbench({ type: "resize", sidebarWidth: x })
          }
          onResizeBy={(delta) =>
            dispatchWorkbench({
              type: "resize",
              sidebarWidth: workbench.sidebarWidth + delta,
            })
          }
        />
      )}

      <div className="workspace-shell" ref={shellRef}>
        <div className={`app${isNewChat ? " new-chat-page" : ""}`}>
          <div className="topbar">
            {!role.pinnedThreadId && !workbench.sidebarVisible && (
              <IconButton
                className="topbar-sidebar-restore"
                label="Show the chat sidebar"
                onClick={() => dispatchWorkbench({ type: "toggleSidebar" })}
              >
                <PanelIcon side="left" />
              </IconButton>
            )}

            {isNewChat && (
              <span className="new-chat-topbar-title">New chat</span>
            )}

            {!isNewChat && (
              <>
                <ThreadTitle
                  name={threadName}
                  title={view?.cwd ?? cwd ?? ""}
                  // Double click to rename, matching the sidebar's own gesture.
                  onRename={
                    activeThreadId
                      ? (name) =>
                          void window.codexDesk.renameThread(
                            activeThreadId,
                            name,
                          )
                      : undefined
                  }
                />
                {view?.worktreePath && (
                  <span className="topbar-worktree" title={view.worktreePath}>
                    Worktree
                  </span>
                )}
              </>
            )}

            <span className="spacer" />

            {!isNewChat && (
              <>
                {contextUsage && (
                  <button
                    type="button"
                    className="topbar-context-usage"
                    title="Open context and account usage"
                    onClick={() => setShowUsage(true)}
                  >
                    {contextUsage}
                  </button>
                )}
                <div className="topbar-icons">
                  <IconButton
                    label="Toggle the file tree (⌘B)"
                    on={treeVisible}
                    onClick={() => dispatchWorkbench({ type: "toggleTree" })}
                  >
                    <TreeIcon />
                  </IconButton>

                  <IconButton
                    label="Toggle the side panel"
                    on={sidePanelVisible}
                    onClick={() =>
                      dispatchWorkbench({ type: "togglePanel", panel: "side" })
                    }
                  >
                    <PanelIcon side="right" />
                  </IconButton>

                  {terminalAvailable && activeThreadId && (
                    <IconButton
                      label="Toggle the terminal (⌘`)"
                      on={bottomPanel.visible && bottomPanel.tabs.length > 0}
                      onClick={() => {
                        // With no tab yet this has to create one, or the button
                        // toggles an empty panel and looks broken.
                        if (bottomPanel.tabs.length === 0) {
                          dispatchWorkbench({
                            type: "openTerminal",
                            threadId: activeThreadId,
                          });
                        } else {
                          dispatchWorkbench({
                            type: "togglePanel",
                            panel: "bottom",
                          });
                        }
                      }}
                    >
                      <PanelIcon side="bottom" />
                    </IconButton>
                  )}

                  <OverflowMenu badge={comments.length}>
                    {(close) => (
                      <>
                        {activeThreadId && (
                          <>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setShowChanges((shown) => !shown);
                                close();
                              }}
                            >
                              {showChanges
                                ? "Hide changes"
                                : "Review changes and ship"}
                              {comments.length > 0 && (
                                <span className="badge">{comments.length}</span>
                              )}
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => {
                                void window.codexDesk.startReview(
                                  activeThreadId,
                                  { type: "uncommittedChanges" },
                                );
                                close();
                              }}
                            >
                              Start a review
                            </button>
                            <div className="topbar-menu-sep" role="separator" />
                          </>
                        )}
                        <button
                          role="menuitem"
                          onClick={() => {
                            setShowUsage(true);
                            close();
                          }}
                        >
                          Usage
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setCapabilitiesTab("general");
                            close();
                          }}
                        >
                          Settings
                        </button>
                      </>
                    )}
                  </OverflowMenu>
                </div>
              </>
            )}
          </div>

          {/* Context and rate-limit headroom moved into the Usage panel: a
            permanent strip spent vertical space on every thread to answer a
            question that comes up occasionally. Open it from the sidebar. */}
          {!isNewChat && showUsage && (
            <UsagePanel
              onClose={() => setShowUsage(false)}
              budget={view?.budget}
              onRedeem={() => void window.codexDesk.consumeResetCredit()}
            />
          )}

          {preflight.kind === "cliMissing" && (
            <div className="banner error">{preflight.detail}</div>
          )}
          {preflight.kind === "cliTooOld" && (
            <div className="banner error">
              codex {preflight.found} is older than the required{" "}
              {preflight.minimum}. Run <code>brew upgrade codex</code>.
            </div>
          )}
          {preflight.kind === "ready" && preflight.warning && (
            <div className="banner warn">{preflight.warning}</div>
          )}
          {auth.kind === "signedOut" && (
            <SignIn
              login={login}
              requiresOpenaiAuth={auth.requiresOpenaiAuth}
              onStart={(method) => void window.codexDesk.startLogin(method)}
              onCancel={() => void window.codexDesk.cancelLogin()}
            />
          )}
          {!isNewChat && view?.lastError && (
            <div className="banner error">{view.lastError}</div>
          )}

          {!isNewChat && view?.plan && <PlanStrip plan={view.plan} />}

          {/*
          The workbench (V2.2 shape, built 2026-07-27).

          This workbench owns only the chat and its optional bottom panel.
          The file viewer and repository tree are siblings of the whole app,
          so both own the full window height instead of starting below the
          chat topbar.

          Panel widths are pixels, clamped so the chat keeps `MIN_CHAT_WIDTH`.
        */}
          <div className="workbench" ref={layoutRef}>
            <div className="workbench-upper">
              <div className="chat-column">
                <div className="main-row">
                  {isNewChat && newChatDraft ? (
                    <div className="new-chat-main">
                      <NewChatWelcome
                        context={newChatDraft}
                        project={projects.find(
                          (project) => project.id === newChatDraft.projectId,
                        )}
                        branchInfo={gitBranches}
                        threads={threads}
                        onOpenThread={openThread}
                        onOpenProject={() => void addProjectFromNewChat()}
                      />
                    </div>
                  ) : transcriptRows.length === 0 &&
                    requestEntries.length === 0 ? (
                    <div className="transcript">
                      <div className="empty">
                        {blocked
                          ? "Resolve the issue above to continue."
                          : !cwd
                            ? "Select a folder to start."
                            : !activeThreadId
                              ? "Create a thread to start."
                              : view && !view.loaded
                                ? "Loading conversation…"
                                : "Ask the coding agent something."}
                      </div>
                    </div>
                  ) : transcriptRows.length > 0 ? (
                    <FileRefProvider onOpenFile={openFileRef}>
                      <VirtualTranscript
                        count={transcriptRows.length}
                        renderRow={renderRow}
                        revision={revision.current}
                      />
                    </FileRefProvider>
                  ) : null}
                  {changesVisible && activeThreadId && (
                    <div className="changes-pane">
                      <ChangesPane
                        changes={changes}
                        comments={comments}
                        onRefresh={() =>
                          void window.codexDesk.refreshChanges(activeThreadId)
                        }
                        onSetScope={(scope) =>
                          void window.codexDesk.setChangesScope(
                            activeThreadId,
                            scope,
                          )
                        }
                        onAddComment={(draft) =>
                          void window.codexDesk.addComment(
                            activeThreadId,
                            draft,
                          )
                        }
                        onRemoveComment={(id) =>
                          void window.codexDesk.removeComment(
                            activeThreadId,
                            id,
                          )
                        }
                        onOpenFile={(p) => {
                          // Diff paths are relative to the worktree root. Opened
                          // persistent, not preview: arriving from a diff is a
                          // deliberate "I want to read this", not a browse.
                          if (workspaceRoot) {
                            openFileInWorkbench(`${workspaceRoot}/${p}`, false);
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/*
            Bottom panel. It belongs to the chat app; both right-hand rails
            remain full height beside it.
          */}
            {bottomPanel.tabs.length > 0 && (
              <>
                {bottomPanel.visible && (
                  <Splitter
                    orientation="horizontal"
                    label="Resize the bottom panel"
                    onResize={(y) => {
                      const box = layoutRef.current?.getBoundingClientRect();
                      if (!box) return;
                      dispatchWorkbench({
                        type: "resize",
                        bottomHeight: Math.min(
                          box.bottom - y,
                          box.height - MIN_BOTTOM_HEIGHT,
                        ),
                      });
                    }}
                    onResizeBy={(d) =>
                      dispatchWorkbench({
                        type: "resize",
                        bottomHeight: workbench.bottomHeight - d,
                      })
                    }
                  />
                )}
                <div
                  className={`bottom-panel${bottomPanel.visible ? "" : " hidden"}`}
                  aria-hidden={!bottomPanel.visible}
                  style={{
                    height: bottomPanel.visible ? workbench.bottomHeight : 0,
                  }}
                >
                  <TabStrip
                    tabs={bottomPanel.tabs.map((t) => ({
                      id: t.id,
                      label:
                        t.kind === "terminal"
                          ? "terminal"
                          : (bottomLabels.get(t.id) ?? ""),
                      preview: false,
                      closable: t.kind !== "terminal",
                    }))}
                    activeId={bottomPanel.activeId}
                    onActivate={(id) =>
                      dispatchWorkbench({
                        type: "activateTab",
                        panel: "bottom",
                        id,
                      })
                    }
                    onClose={(id) => {
                      // Closing a terminal tab kills its shell. Hiding the panel
                      // does not — that distinction already cost us once, when
                      // "Close" silently disposed a running PTY.
                      const tab = bottomPanel.tabs.find((t) => t.id === id);
                      if (tab?.kind === "terminal") {
                        void window.codexDesk.termClose(tab.threadId);
                      }
                      dispatchWorkbench({
                        type: "closeTab",
                        panel: "bottom",
                        id,
                      });
                    }}
                    actions={
                      <>
                        <button
                          className="panel-text-action danger"
                          title="Kill the shell and close the panel"
                          onClick={() => {
                            const active = bottomPanel.tabs.find(
                              (tab) => tab.id === bottomPanel.activeId,
                            );
                            if (active?.kind === "terminal") {
                              void window.codexDesk.termClose(active.threadId);
                              dispatchWorkbench({
                                type: "closeTab",
                                panel: "bottom",
                                id: active.id,
                              });
                            }
                          }}
                        >
                          Kill
                        </button>
                        <button
                          className="panel-text-action"
                          title="Hide the panel; shells keep running (⌘`)"
                          onClick={() =>
                            dispatchWorkbench({
                              type: "togglePanel",
                              panel: "bottom",
                            })
                          }
                        >
                          Hide
                        </button>
                      </>
                    }
                  />
                  <div className="panel-body">
                    {/*
                    Every terminal tab stays mounted; only the active one is
                    shown. xterm's scrollback lives in the renderer, so
                    unmounting a hidden tab would throw away everything the
                    shell had printed.
                  */}
                    {bottomPanel.tabs.map(
                      (tab) =>
                        tab.kind === "terminal" && (
                          <TerminalPane
                            key={tab.id}
                            id={tab.threadId}
                            embedded
                            visible={
                              bottomPanel.visible &&
                              tab.id === bottomPanel.activeId
                            }
                            onClose={() =>
                              dispatchWorkbench({
                                type: "closeTab",
                                panel: "bottom",
                                id: tab.id,
                              })
                            }
                          />
                        ),
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {changesVisible && activeThreadId && (
            <DeliveryBar
              delivery={delivery}
              comments={comments}
              onPrepare={() =>
                void window.codexDesk.prepareDelivery(activeThreadId)
              }
              onCommit={(m, sel) =>
                void window.codexDesk.commitChanges(activeThreadId, m, sel)
              }
              onPush={() => void window.codexDesk.pushBranch(activeThreadId)}
              onCreatePr={(t, b) =>
                void window.codexDesk.createPullRequest(activeThreadId, t, b)
              }
              onProposeMessage={() =>
                window.codexDesk.generateCommitMessage(activeThreadId)
              }
              onSubmitComments={(text, target) =>
                void window.codexDesk.submitComments(
                  activeThreadId,
                  text,
                  target,
                )
              }
              refreshToken={changeToken + (view?.running ? 1_000_000 : 0)}
            />
          )}

          {!isNewChat && activeThreadId && view && outboxPresentation && (
            <QueuePane
              messages={outboxPresentation.messages}
              steer={outboxPresentation.steer}
              capacity={outboxPresentation.capacity}
              running={view.running}
              onRemove={(id) =>
                void window.codexDesk.removeQueued(activeThreadId, id)
              }
              onEdit={(id, text) =>
                void window.codexDesk.editQueued(activeThreadId, id, text)
              }
              onMove={(id, to) =>
                void window.codexDesk.moveQueued(activeThreadId, id, to)
              }
              onSteerNow={() => void window.codexDesk.steerNow(activeThreadId)}
            />
          )}

          {requestEntries[0]?.kind === "request" && (
            <div className="request-dock" aria-live="polite">
              <RequestCard
                request={requestEntries[0].request}
                requestPosition={1}
                requestCount={requestEntries.length}
                onAnswer={answer}
              />
            </div>
          )}

          <div className={`composer-wrap${isNewChat ? " new-chat" : ""}`}>
            {composerCompletion && !composerUnavailable && (
              <MentionPicker
                mode={composerCompletion.mode}
                query={composerCompletion.query}
                workspaceRoot={workspaceRoot}
                allowAttachments={Boolean(activeThreadId || newChatDraft)}
                canCompact={Boolean(activeThreadId && !newChatDraft)}
                config={config}
                capabilities={capabilities}
                onPick={pickMention}
                onDismiss={() => setComposerCompletion(null)}
              />
            )}
            <div
              className={`composer${
                composerUnavailable || (!activeThreadId && !newChatDraft)
                  ? " disabled"
                  : ""
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!composerUnavailable && e.dataTransfer.files.length) {
                  void attachFiles(e.dataTransfer.files);
                }
              }}
            >
              {newChatDraft && (
                <NewChatContextBar
                  context={newChatDraft}
                  projects={projects}
                  branchInfo={gitBranches}
                  loadingBranches={loadingBranches}
                  onChange={setNewChatDraft}
                  onAddProject={() => void addProjectFromNewChat()}
                />
              )}
              {composerAttachments.length > 0 && (
                <div className="attachments">
                  {composerAttachments.map((a) => (
                    <div key={a.id} className="attachment">
                      {a.preview ? (
                        <img src={a.preview} alt={a.name} />
                      ) : (
                        <span className="filechip">{a.name}</span>
                      )}
                      <button
                        className="attach-x"
                        aria-label={`Remove ${a.name}`}
                        onClick={() => {
                          const pending = pendingAttachments.some(
                            (item) => item.id === a.id,
                          );
                          if (pending) {
                            const remaining = pendingAttachments.filter(
                              (item) => item.id !== a.id,
                            );
                            setPendingAttachments(remaining);
                            if (remaining.length === 0) {
                              setAttachmentError(null);
                            }
                          } else if (activeThreadId) {
                            void window.codexDesk.removeAttachment(
                              activeThreadId,
                              a.id,
                            );
                          }
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachmentError && (
                <div className="composer-attachment-error" role="alert">
                  {attachmentError}
                </div>
              )}
              <textarea
                ref={composerRef}
                rows={1}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length) {
                    e.preventDefault();
                    void attachFiles(files);
                  }
                }}
                value={draft}
                placeholder={
                  newChatDraft
                    ? "Describe a task, or paste an error…"
                    : !activeThreadId
                      ? "Create a thread to start"
                      : waitingForDecision
                        ? "Waiting on your decision…"
                        : "Message Codex…"
                }
                disabled={
                  (!activeThreadId && !newChatDraft) || composerUnavailable
                }
                onChange={(e) =>
                  onDraftChange(e.target.value, e.target.selectionStart)
                }
                onKeyDown={(e) => {
                  // The completion picker owns Enter while it is open.
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    composerCompletion === null
                  ) {
                    e.preventDefault();
                    composerAction();
                  }
                }}
              />
              <div className="composer-foot">
                <button
                  className="attachment-btn"
                  title="Add files, mentions, or commands"
                  aria-label="Add files, mentions, or commands"
                  aria-expanded={composerCompletion?.mode === "add"}
                  disabled={
                    (!activeThreadId && !newChatDraft) || composerUnavailable
                  }
                  onClick={() => {
                    if (composerCompletion?.mode === "add") {
                      setComposerCompletion(null);
                      return;
                    }
                    const textarea = composerRef.current;
                    const start = textarea?.selectionStart ?? draft.length;
                    const end = textarea?.selectionEnd ?? start;
                    setComposerCompletion({
                      mode: "add",
                      query: "",
                      start,
                      end,
                    });
                  }}
                >
                  +
                </button>
                <input
                  ref={attachmentInputRef}
                  className="composer-file-input"
                  type="file"
                  multiple
                  tabIndex={-1}
                  onChange={(event) => {
                    if (event.target.files?.length) {
                      void attachFiles(event.target.files);
                    }
                    event.target.value = "";
                  }}
                />
                {config.models.length > 0 && (
                  <ModelPicker
                    config={config}
                    disabled={
                      (!activeThreadId && !newChatDraft) || composerUnavailable
                    }
                    onSelectModel={(model) =>
                      void window.codexDesk.setModel(model)
                    }
                    onSelectEffort={(effort) =>
                      void window.codexDesk.setReasoningEffort(effort)
                    }
                    onSelectServiceTier={(tier) =>
                      void window.codexDesk.setServiceTier(tier)
                    }
                  />
                )}
                <ApprovalPicker
                  config={config}
                  mode={view?.approvalMode ?? config.approvalMode}
                  disabled={
                    (!activeThreadId && !newChatDraft) || composerUnavailable
                  }
                  onSelect={(mode) =>
                    // With no thread open the choice sets the default the next
                    // thread will start under; otherwise it retargets this one.
                    void window.codexDesk.setApprovalMode(activeThreadId, mode)
                  }
                />
                <span className="spacer" />
                <button
                  className={`composer-action ${composerMode}`}
                  disabled={composerMode === "disabled"}
                  title={
                    composerMode === "stop" ? "Stop (Esc)" : "Send (Enter)"
                  }
                  aria-label={composerMode === "stop" ? "Stop" : "Send"}
                  onClick={composerAction}
                >
                  {composerMode === "stop" ? "◼" : "↑"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Files open in a full-height workbench rail. It is a sibling of the
            chat app, so the transcript, topbar, and composer all receive the
            reduced width structurally rather than compensating for an
            overlay with padding. */}
        {sidePanelVisible && (
          <>
            <Splitter
              className="side-panel-splitter"
              orientation="vertical"
              label="Resize the side panel"
              onResize={(x) => {
                const box = shellRef.current?.getBoundingClientRect();
                if (!box) return;
                const treeWidth = treeVisible ? workbench.treeWidth : 0;
                dispatchWorkbench({
                  type: "resize",
                  sideWidth: Math.min(
                    box.right - x - treeWidth,
                    box.width - treeWidth - MIN_CHAT_WIDTH,
                  ),
                });
              }}
              onResizeBy={(d) =>
                dispatchWorkbench({
                  type: "resize",
                  sideWidth: workbench.sideWidth - d,
                })
              }
            />
            <div className="side-panel" style={{ width: workbench.sideWidth }}>
              <TabStrip
                tabs={sidePanel.tabs.map((tab) => ({
                  id: tab.id,
                  label: sideLabels.get(tab.id) ?? "",
                  preview: tab.kind === "file" && tab.preview,
                  title: tab.kind === "file" ? tab.path : undefined,
                }))}
                activeId={sidePanel.activeId}
                onActivate={(id) =>
                  dispatchWorkbench({
                    type: "activateTab",
                    panel: "side",
                    id,
                  })
                }
                onClose={(id) =>
                  dispatchWorkbench({ type: "closeTab", panel: "side", id })
                }
                onPromote={(id) =>
                  dispatchWorkbench({
                    type: "promoteTab",
                    panel: "side",
                    id,
                  })
                }
                actions={
                  <>
                    <button
                      className={`icon-toggle${treeVisible ? " on" : ""}`}
                      title="Toggle the file tree"
                      aria-pressed={treeVisible}
                      onClick={() => dispatchWorkbench({ type: "toggleTree" })}
                    >
                      ⌷
                    </button>
                    <button
                      className="icon-toggle"
                      title="Hide the side panel"
                      onClick={() =>
                        dispatchWorkbench({
                          type: "togglePanel",
                          panel: "side",
                        })
                      }
                    >
                      ✕
                    </button>
                  </>
                }
              />
              <div className="panel-body">
                {activeSideTab?.kind === "file" && workspaceRoot && (
                  <FileViewer
                    key={activeSideTab.id}
                    path={activeSideTab.path}
                    root={workspaceRoot}
                    changeToken={changeToken}
                    onOpenPath={(path) =>
                      openFileInWorkbench(path, activeSideTab.preview)
                    }
                    revealLine={activeSideTab.revealLine}
                    onRevealed={() =>
                      dispatchWorkbench({
                        type: "revealed",
                        panel: "side",
                        id: activeSideTab.id,
                      })
                    }
                  />
                )}
              </div>
            </div>
          </>
        )}

        {/* The repository tree is window chrome, not chat content. Both rails
            reduce the app width before transcript/composer centering. */}
        {treeVisible && workspaceRoot && (
          <>
            <Splitter
              className="tree-splitter"
              orientation="vertical"
              label="Resize the file tree"
              onResize={(x) => {
                const box = shellRef.current?.getBoundingClientRect();
                if (!box) return;
                dispatchWorkbench({
                  type: "resize",
                  treeWidth: box.right - x,
                });
              }}
              onResizeBy={(d) =>
                dispatchWorkbench({
                  type: "resize",
                  treeWidth: workbench.treeWidth - d,
                })
              }
            />
            <div className="tree-column" style={{ width: workbench.treeWidth }}>
              <FileTreeBoundary>
                <FileTree
                  root={workspaceRoot}
                  changeToken={changeToken}
                  activePath={activeFilePath}
                  onOpenFile={openFileInWorkbench}
                  onAddToChat={addFileToChat}
                />
              </FileTreeBoundary>
            </div>
          </>
        )}
      </div>

      {/*
        Outside the workbench columns deliberately: this is a modal over the
        whole window, not another pane competing for the chat's width.
      */}
      {capabilitiesTab && (
        <CapabilitiesPanel
          tab={capabilitiesTab}
          onTab={setCapabilitiesTab}
          config={config}
          capabilities={capabilities}
          auth={auth}
          notifyMode={notifyMode}
          codexVersion={preflight.kind === "ready" ? preflight.version : null}
          onNotifyMode={(mode) => {
            setNotifyMode(mode);
            void window.codexDesk.setNotifyMode(mode);
          }}
          onSignOut={() => void window.codexDesk.logout()}
          onClose={() => setCapabilitiesTab(null)}
        />
      )}
    </div>
  );
}
