import { contextBridge, ipcRenderer } from "electron";
import type { FileEntryView, FileReadView } from "../contracts/views/files";
import {
  IPC,
  type AppEvent,
  type ChangesScope,
  type LoginMethod,
  type ReviewSubmissionTarget,
  type DiffSideView,
  type NewThreadOptions,
  type NotifyMode,
  type RequestAnswer,
  type ReviewTarget,
  type Snapshot,
  type FuzzyFileSearchResult,
  type GitBranchInfo,
  type WorkspaceRegistrationResult,
} from "../shared/ipc";
import type { WebSearchMode } from "../contracts/views/capabilities";
import type { ApprovalMode } from "../contracts/approvals";

/**
 * The renderer gets a fixed verb list, never arbitrary filesystem or process
 * authority (plan §5, step 0.0). Workspace selection, git, and thread
 * lifecycle all stay in the main process; the renderer only asks.
 */
const api = {
  onEvent(cb: (ev: AppEvent) => void): () => void {
    const listener = (_e: unknown, ev: AppEvent) => cb(ev);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.off(IPC.event, listener);
  },
  /** Pull current state on mount; events alone race the renderer's first
   * render and drop the initial preflight/auth/thread-list result. */
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.getSnapshot),
  installRuntime: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.installRuntime),

  selectWorkspace: () => ipcRenderer.invoke(IPC.selectWorkspace),
  setWorkspace: (cwd: string) => ipcRenderer.invoke(IPC.setWorkspace, cwd),
  readGitBranches: (cwd: string): Promise<GitBranchInfo | null> =>
    ipcRenderer.invoke(IPC.readGitBranches, cwd),

  // --- threads ---
  newThread: (opts: NewThreadOptions = {}): Promise<string | null> =>
    ipcRenderer.invoke(IPC.newThread, opts),
  openThread: (threadId: string) =>
    ipcRenderer.invoke(IPC.openThread, threadId),
  closeThread: (threadId: string) =>
    ipcRenderer.invoke(IPC.closeThread, threadId),
  renameThread: (threadId: string, name: string) =>
    ipcRenderer.invoke(IPC.renameThread, threadId, name),
  archiveThread: (threadId: string, archived: boolean) =>
    ipcRenderer.invoke(IPC.archiveThread, threadId, archived),
  deleteThread: (threadId: string) =>
    ipcRenderer.invoke(IPC.deleteThread, threadId),
  pinThread: (threadId: string, pinned: boolean) =>
    ipcRenderer.invoke(IPC.pinThread, threadId, pinned),
  forkThread: (threadId: string, lastTurnId?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.forkThread, threadId, lastTurnId),

  // --- turns ---
  /** Resolves `{ queued: true }` when a turn was active and the message was
   * enqueued instead of sent. */
  // `error` is part of the contract, not an afterthought: the composer clears
  // the draft optimistically and needs to know when to put it back.
  sendMessage: (
    threadId: string,
    text: string,
  ): Promise<{ queued: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.sendMessage, threadId, text),
  saveDraft: (threadId: string, draft: string) =>
    ipcRenderer.invoke(IPC.saveDraft, threadId, draft),
  removeQueued: (threadId: string, id: string) =>
    ipcRenderer.invoke(IPC.removeQueued, threadId, id),
  editQueued: (threadId: string, id: string, text: string) =>
    ipcRenderer.invoke(IPC.editQueued, threadId, id, text),
  moveQueued: (threadId: string, id: string, toIndex: number) =>
    ipcRenderer.invoke(IPC.moveQueued, threadId, id, toIndex),
  steerNow: (threadId: string) => ipcRenderer.invoke(IPC.steerNow, threadId),
  compactThread: (threadId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.compactThread, threadId),
  addAttachment: (
    threadId: string,
    file: {
      name: string;
      kind: "image" | "file";
      bytes: Uint8Array;
      preview?: string;
    },
  ) => ipcRenderer.invoke(IPC.addAttachment, threadId, file),
  removeAttachment: (threadId: string, id: string) =>
    ipcRenderer.invoke(IPC.removeAttachment, threadId, id),
  interrupt: (threadId: string) => ipcRenderer.invoke(IPC.interrupt, threadId),
  answerRequest: (requestId: string | number, answer: RequestAnswer) =>
    ipcRenderer.invoke(IPC.answerRequest, requestId, answer),

  // --- settings and workspace context ---
  // --- sign-in (§8.5) ---
  startLogin: (method: LoginMethod): Promise<void> =>
    ipcRenderer.invoke(IPC.startLogin, method),
  cancelLogin: (): Promise<void> => ipcRenderer.invoke(IPC.cancelLogin),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.logout),
  setApprovalsReviewer: (
    reviewer: "user" | "auto_review" | "guardian_subagent",
  ) => ipcRenderer.invoke(IPC.setApprovalsReviewer, reviewer),
  /** `threadId` null sets the default for threads without their own mode. */
  setApprovalMode: (threadId: string | null, mode: ApprovalMode) =>
    ipcRenderer.invoke(IPC.setApprovalMode, threadId, mode),
  readUsage: () => ipcRenderer.invoke(IPC.readUsage),
  consumeResetCredit: () => ipcRenderer.invoke(IPC.consumeResetCredit),
  setNotifyMode: (mode: NotifyMode) =>
    ipcRenderer.invoke(IPC.setNotifyMode, mode),
  setUseWorktrees: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.setUseWorktrees, enabled),
  startReview: (
    threadId: string,
    target: ReviewTarget,
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.startReview, threadId, target),
  searchFiles: (
    query: string,
    workspaceRoot?: string,
  ): Promise<FuzzyFileSearchResult[]> =>
    ipcRenderer.invoke(IPC.searchFiles, query, workspaceRoot),
  setModel: (model: string | null) => ipcRenderer.invoke(IPC.setModel, model),
  setReasoningEffort: (effort: string | null) =>
    ipcRenderer.invoke(IPC.setReasoningEffort, effort),
  setServiceTier: (tier: string | null) =>
    ipcRenderer.invoke(IPC.setServiceTier, tier),

  // --- terminal (3.6) ---
  termOpen: (id: string, cols: number, rows: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC.termOpen, id, cols, rows),
  termWrite: (id: string, data: string) =>
    ipcRenderer.invoke(IPC.termWrite, id, data),
  termResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.termResize, id, cols, rows),
  termClose: (id: string) => ipcRenderer.invoke(IPC.termClose, id),

  // --- windows (3.2) and quick chat (4.7) ---
  openInNewWindow: (threadId: string) =>
    ipcRenderer.invoke(IPC.openInNewWindow, threadId),
  promptCaptureSubmit: (text: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.promptCaptureSubmit, text),
  promptCaptureClose: () => ipcRenderer.invoke(IPC.promptCaptureClose),

  // --- projects (4.1) ---
  addProject: (root: string) => ipcRenderer.invoke(IPC.addProject, root),
  setActiveProject: (id: string) =>
    ipcRenderer.invoke(IPC.setActiveProject, id),
  renameProject: (id: string, name: string) =>
    ipcRenderer.invoke(IPC.renameProject, id, name),
  registerIsolatedWorkspace: (
    projectId: string,
    name: string,
  ): Promise<WorkspaceRegistrationResult> =>
    ipcRenderer.invoke(IPC.registerIsolatedWorkspace, projectId, name),
  revealProject: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.revealProject, id),
  removeProject: (id: string) => ipcRenderer.invoke(IPC.removeProject, id),

  // --- file tree (4.3) ---
  readDir: (dir: string): Promise<FileEntryView[]> =>
    ipcRenderer.invoke(IPC.readDir, dir),
  readFile: (file: string): Promise<FileReadView> =>
    ipcRenderer.invoke(IPC.readFile, file),
  /**
   * Read an image referenced by a transcript item, as a data URL, or null if
   * it is not a readable image. Attachments live outside the workspace, so
   * `readFile` refuses them; see `LocalFileSystem.readImage`.
   */
  readImage: (file: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.readImage, file),
  /** Opens a file in the OS default app. Resolves to a message on failure. */
  openPath: (target: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.openPath, target),
  /**
   * Copy a file's contents to the clipboard. Resolves to a message on failure.
   *
   * A read, so it goes through the main process and the same path allow-list
   * as `readFile` rather than becoming a second, unguarded read path.
   */
  copyFileContents: (target: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.copyFileContents, target),
  /** Show a file in Finder. Resolves to a message on failure. */
  revealPath: (target: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.revealPath, target),

  // --- capabilities (§4.5 / V2.4) ---
  setSkillEnabled: (path: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.setSkillEnabled, path, enabled),
  /** Explicit user refresh — re-scans disk, unlike the `skills/changed` path. */
  refreshSkills: (): Promise<void> => ipcRenderer.invoke(IPC.refreshSkills),
  setPluginEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.setPluginEnabled, pluginId, enabled),
  /**
   * Re-read plugins and MCP servers.
   *
   * Needed on focus because there is no `plugins/changed` notification and
   * plugin configuration may change outside this process.
   */
  refreshCapabilities: (): Promise<void> =>
    ipcRenderer.invoke(IPC.refreshCapabilities),
  reloadMcpServers: (): Promise<void> =>
    ipcRenderer.invoke(IPC.reloadMcpServers),
  setWebSearchMode: (mode: WebSearchMode): Promise<void> =>
    ipcRenderer.invoke(IPC.setWebSearchMode, mode),
  // --- changes pane, delivery, comments (milestone 3, §7) ---
  refreshChanges: (threadId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.refreshChanges, threadId),
  setChangesScope: (threadId: string, scope: ChangesScope): Promise<void> =>
    ipcRenderer.invoke(IPC.setChangesScope, threadId, scope),
  prepareDelivery: (threadId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.prepareDelivery, threadId),
  commitChanges: (
    threadId: string,
    message: string,
    selected?: string[],
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.commitChanges, threadId, message, selected),
  pushBranch: (threadId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.pushBranch, threadId),
  createPullRequest: (
    threadId: string,
    title: string,
    body: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.createPullRequest, threadId, title, body),
  generateCommitMessage: (threadId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.generateCommitMessage, threadId),
  addComment: (
    threadId: string,
    draft: {
      filePath: string;
      side: DiffSideView;
      startLine: number;
      endLine: number;
      text: string;
    },
  ): Promise<void> => ipcRenderer.invoke(IPC.addComment, threadId, draft),
  removeComment: (threadId: string, commentId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.removeComment, threadId, commentId),
  submitComments: (
    threadId: string,
    text: string,
    target: ReviewSubmissionTarget,
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.submitComments, threadId, text, target),
};

contextBridge.exposeInMainWorld("codexDesk", api);

export type CodexDeskApi = typeof api;
