import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Notification,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { AppServerClient } from "./appServer/client";
import { preflight } from "./preflight";
import {
  MANAGED_CODEX_RELEASE,
  ManagedCodexRuntime,
} from "./managedCodex";
import { Store } from "./store";
import { Orchestrator } from "./orchestrator";
import { TerminalHost } from "./terminal";
import {
  resolveUpdateConfig,
  shouldCreateWindowOnActivate,
  startAutoUpdates,
} from "./updates";
import { resolveUserDataPath } from "./profile";
import {
  isApprovalMode,
  permittedApprovalModes,
} from "../application/domains/approvals/policy";
import { LocalFileSystem } from "./fs/localFs";
import {
  IPC,
  type AppEvent,
  type ChangesScope,
  type LoginMethod,
  type ReviewSubmissionTarget,
  type DiffSideView,
  type NewThreadOptions,
  type NotifyMode,
  type PreflightState,
  type RequestAnswer,
  type ReviewTarget,
} from "../shared/ipc";
import type { WebSearchMode } from "../contracts/views/capabilities";
import { submitCapturedPrompt } from "../application/domains/desktop/PromptCapture";
import { shouldPresentNotification } from "../application/domains/desktop/NotificationPolicy";
import {
  dismissOnBlur,
  isSafeExternalUrl,
  isTrustedRendererNavigation,
  reusesExistingWindow,
  type AuxiliaryWindowRole,
} from "../application/domains/desktop/WindowPolicy";

/** Shape the renderer sends when anchoring a new comment (§7.3). */
type ReviewNoteDraftInput = {
  filePath: string;
  side: DiffSideView;
  startLine: number;
  endLine: number;
  text: string;
};

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const __CODEXDESK_UPDATE_FEED_URL__: string;
declare const __CODEXDESK_BUILD_CHANNEL__: "stable" | "canary";

if (process.env.CODEXDESK_DEBUG_PORT) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.CODEXDESK_DEBUG_PORT,
  );
}

/**
 * Run against a scratch profile.
 *
 * `userData` is keyed on the product name, so two checkouts of this app share
 * one state file, one worktree container, and one attachments directory.
 * Developing in a git worktree while the main app is open therefore means two
 * processes writing the same `codexdesk-state.json`. Setting this (together with a
 * distinct `CODEXDESK_DEBUG_PORT`) gives a run its own profile and leaves the real
 * one alone. Packaged canary builds get a separate profile automatically.
 */
const userDataPath = resolveUserDataPath({
  explicitPath: process.env.CODEXDESK_USER_DATA,
  buildChannel: __CODEXDESK_BUILD_CHANNEL__,
  appDataPath: app.getPath("appData"),
});
if (userDataPath) {
  app.setPath("userData", userDataPath);
}

let win: BrowserWindow | null = null;
/**
 * Extra windows (3.2) and the quick-chat window (4.7).
 *
 * The main process owns every app-server connection and all thread state, so
 * an extra window is a *view*: closing or reloading one cannot stop a turn.
 * Each carries a role that the renderer reads from its snapshot.
 */
const extraWindows = new Map<
  number,
  { win: BrowserWindow; role: AuxiliaryWindowRole }
>();

/** Role lookup for the window that sent an IPC message. */
function roleOf(senderId: number) {
  return extraWindows.get(senderId);
}
let client: AppServerClient | null = null;
let store: Store;
let orch: Orchestrator;
let terminals: TerminalHost;
let files: LocalFileSystem;
let managedRuntime: ManagedCodexRuntime;
let bootPromise: Promise<void> | null = null;
let stopAutoUpdates: (() => void) | null = null;
let servicesStopped = false;
let installingUpdate = false;
/** Connection-scoped ids for the active watches — workspace plus worktrees. */
let watchIds: string[] = [];

function emit(ev: AppEvent): void {
  win?.webContents.send(IPC.event, ev);
  for (const { win: w } of extraWindows.values()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.event, ev);
  }
}

/**
 * Compact macOS chrome gives the renderer the full window height while
 * Windows and Linux retain their standard frame.
 */
const nativeChrome: Electron.BrowserWindowConstructorOptions =
  process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 15 },
      }
    : {};

/** Open a URL outside Electron only when it is an ordinary web link. */
function openSafeExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  // Escape the window-open callback before asking the OS to open the URL.
  setImmediate(() => {
    void shell.openExternal(url);
  });
}

/**
 * Keep a privileged renderer on its own document. New windows are always
 * denied; safe web links are handed to the user's default browser instead.
 */
function restrictRendererNavigation(
  window: BrowserWindow,
  rendererUrl: string,
): void {
  const blockUntrustedNavigation = (
    event: Electron.Event,
    navigationUrl: string,
  ) => {
    if (!isTrustedRendererNavigation(navigationUrl, rendererUrl)) {
      event.preventDefault();
    }
  };

  window.webContents.on("will-navigate", blockUntrustedNavigation);
  window.webContents.on("will-redirect", blockUntrustedNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternalUrl(url);
    return { action: "deny" };
  });
}

/** Install the navigation guard before loading the shared renderer entry. */
function loadRenderer(window: BrowserWindow): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    restrictRendererNavigation(window, MAIN_WINDOW_VITE_DEV_SERVER_URL);
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    return;
  }

  const rendererPath = path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
  );
  restrictRendererNavigation(window, pathToFileURL(rendererPath).href);
  void window.loadFile(rendererPath);
}

/** Build a secondary conversation view or the transient prompt capture. */
function createAuxWindow(role: AuxiliaryWindowRole): BrowserWindow {
  const quick = role.kind === "promptCapture";
  const w = new BrowserWindow({
    width: quick ? 620 : 1100,
    height: quick ? 220 : 780,
    title: quick ? "Quick chat" : "CodexDesk",
    frame: !quick,
    // Quick chat is already frameless; the thread window gets the same
    // native chrome as the main one.
    ...(quick ? {} : nativeChrome),
    alwaysOnTop: quick,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--codexdesk-role=${quick ? "quick" : "thread"}`,
        ...(role.kind === "conversation"
          ? [`--codexdesk-thread=${role.conversationId}`]
          : []),
      ],
    },
  });

  // Register *before* loading: the renderer calls getSnapshot on mount, and
  // a role registered afterwards arrives too late to shape the first render.
  extraWindows.set(w.webContents.id, {
    win: w,
    role,
  });

  loadRenderer(w);
  w.once("ready-to-show", () => w.show());
  const wcId = w.webContents.id;
  w.on("closed", () => extraWindows.delete(wcId));
  // Quick chat is transient and closes when focus returns to other work.
  if (dismissOnBlur(role)) w.on("blur", () => w.close());
  return w;
}

/** Native attention for completed work and requests outside the visible view. */
function notify(title: string, body: string, threadId?: string): void {
  const mode = store.get().notifyMode;
  const focused = win?.isFocused() ?? false;
  const visible = threadId ? threadId === orch.activeThreadId : true;
  if (
    !shouldPresentNotification({
      mode,
      mainWindowFocused: focused,
      targetConversationVisible: visible,
    })
  ) {
    return;
  }
  if (!Notification.isSupported()) return;

  const n = new Notification({ title, body });
  n.on("click", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (threadId) void orch.openThread(threadId);
  });
  n.show();
}

/** Focus prompt capture, or create it if absent. */
function openPromptCapture(): void {
  if (orch.preflight.kind !== "ready") {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return;
  }
  const requested = { kind: "promptCapture" } as const;
  const existing = [...extraWindows.values()].find((candidate) =>
    reusesExistingWindow(candidate.role, requested),
  );
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return;
  }
  createAuxWindow(requested);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "CodexDesk",
    ...nativeChrome,
    webPreferences: {
      // Emitted as `preload.js` beside the main-process output — see
      // vite.preload.config.ts. `__dirname` rather than
      // `import.meta.dirname`: forge builds the main process as CJS.
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadRenderer(win);

  win.on("closed", () => {
    win = null;
  });

  /**
   * Refresh on focus because plugin configuration may change outside this
   * process. The app-server exposes `skills/changed`, but no corresponding
   * notification for plugin configuration.
   */
  win.on("focus", () => {
    void orch.refreshCapabilities();
  });
}

/** One idempotent shutdown path for ordinary quits and update installs. */
function stopServices(): void {
  if (servicesStopped) return;
  servicesStopped = true;
  stopAutoUpdates?.();
  terminals?.disposeAll();
  // Flush synchronously — a downloaded update can close windows before the
  // ordinary before-quit event, and drafts must survive either exit path.
  store?.flush();
  client?.dispose();
}

function configureAutoUpdates(): void {
  const config = resolveUpdateConfig({
    isPackaged: app.isPackaged,
    platform: process.platform,
    feedUrl: __CODEXDESK_UPDATE_FEED_URL__,
  });
  if (!config.enabled) return;

  stopAutoUpdates = startAutoUpdates({
    config,
    updater: {
      setFeedURL: (options) => autoUpdater.setFeedURL(options),
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      quitAndInstall: () => autoUpdater.quitAndInstall(),
      onError: (listener) => {
        autoUpdater.on("error", listener);
      },
      onUpdateAvailable: (listener) => {
        autoUpdater.on("update-available", listener);
      },
      onUpdateNotAvailable: (listener) => {
        autoUpdater.on("update-not-available", listener);
      },
      onUpdateDownloaded: (listener) => {
        autoUpdater.on("update-downloaded", (_event, _notes, releaseName) =>
          listener(releaseName),
        );
      },
      onBeforeQuitForUpdate: (listener) => {
        autoUpdater.on("before-quit-for-update", listener);
      },
    },
    showDialog: (options) =>
      dialog.showMessageBox({ type: "info", ...options }),
    restartBlockers: () => {
      const activeTurns = orch
        .threadList()
        .filter(
          ({ run }) => run.kind === "running" || run.kind === "waiting",
        ).length;
      const openTerminals = terminals.openSessionCount;
      return [
        ...(activeTurns
          ? [
              `${activeTurns} active Codex ${activeTurns === 1 ? "turn" : "turns"}`,
            ]
          : []),
        ...(openTerminals
          ? [
              `${openTerminals} open terminal ${openTerminals === 1 ? "session" : "sessions"}`,
            ]
          : []),
      ];
    },
    prepareForExit: () => {
      // quitAndInstall closes every window before it calls app.quit(). Without
      // this guard, macOS can activate the windowless app and create a new
      // window, leaving Squirrel unable to replace the still-running bundle.
      installingUpdate = true;
      stopServices();
    },
    log: (level, message) => emit({ type: "log", level, message }),
  });
}

function setPreflight(state: PreflightState): void {
  orch.preflight = state;
  emit({ type: "preflight", state: orch.preflight });
}

async function boot(): Promise<void> {
  if (client) return;
  if (!bootPromise) {
    bootPromise = startAppServer().finally(() => {
      bootPromise = null;
    });
  }
  await bootPromise;
}

async function startAppServer(): Promise<void> {
  setPreflight(await preflight(managedRuntime));
  if (orch.preflight.kind !== "ready") return;

  client = new AppServerClient(
    (ev) => orch.handleEvent(ev),
    managedRuntime.executable,
  );
  client.onThreadName = (threadId, name) => {
    const t = orch.getThread(threadId);
    if (t) t.name = name;
    orch.pushThreads();
  };
  // External edits — from the terminal, another editor, or the agent — all
  // arrive through one feed (plan §12.4).
  client.onFsChanged = (paths) => emit({ type: "filesChanged", paths });
  // A skill file was added, edited, or removed. The notification carries no
  // payload — it means "re-list", and without it the surface is correct only
  // until the user fixes the parse error it just showed them.
  client.onSkillsChanged = () => void orch.refreshSkills();
  // The only source of MCP startup state; the list response has none.
  client.onMcpStatus = (update) => orch.applyMcpStatusUpdate(update);
  // The browser flow finishes asynchronously (§8.5); without this the UI would
  // sit on "waiting for your browser" forever.
  client.onLoginCompleted = (_loginId, success, error) =>
    orch.onLoginCompleted(success, error);
  client.onAuthChanged = (state) => orch.setAuth(state);
  client.onThreadStatus = (threadId, run) => {
    const t = orch.getThread(threadId);
    // Trust our own turn tracking over an unloaded observation for a thread
    // whose runtime is already resident.
    if (t && run.kind !== "offline") {
      t.run = run;
      orch.pushThreads();
    }
  };
  orch.setClient(client);

  try {
    await client.connect();
  } catch (err) {
    emit({
      type: "log",
      level: "error",
      message: `handshake failed: ${err instanceof Error ? err.message : err}`,
    });
    return;
  }

  try {
    orch.auth = await client.readAuth();
    emit({ type: "auth", state: orch.auth });
  } catch {
    // Non-fatal; the banner stays in its unknown state.
  }

  await client.readRateLimits();
  emit({
    type: "workspace",
    cwd: orch.workspace,
    recents: store.get().recents,
  });

  if (orch.workspace) {
    await orch.refreshCatalog();
    await loadConfig();
    await watchRoots();
    // Reattach to whatever survived the last session (3.3).
    await orch.recover();
  }
}

/**
 * Watch every active root, not just the workspace.
 *
 * A worktree thread does its work in `<userData>/worktrees/<id>`, which is
 * *outside* the workspace. Watching only `orch.workspace` therefore meant the
 * file tree, the changes pane, and the delivery preview all went stale for
 * exactly the threads the worktree isolation exists to serve — the edit was on
 * disk and nothing said so until a manual refresh.
 *
 * Roots are re-read on every call rather than held, because worktrees appear
 * and disappear as threads are opened and removed.
 */
async function watchRoots(): Promise<void> {
  if (!client) return;
  for (const id of watchIds) await client.unwatch(id);
  watchIds = [];

  const roots = [orch.workspace, ...orch.worktreeRoots()].filter(
    (r): r is string => Boolean(r),
  );
  const stamp = Date.now();
  for (const [i, root] of roots.entries()) {
    const id = `ws-${stamp}-${i}`;
    if (await client.watchPath(id, root)) watchIds.push(id);
  }
}

async function loadConfig(): Promise<void> {
  if (!client || !orch.workspace) return;
  const [models, profiles, requirements] = await Promise.all([
    client.listModels().catch(() => null),
    client.listPermissionProfiles().catch(() => null),
    client.readConfigRequirements().catch(() => null),
  ]);
  orch.config = {
    ...orch.config,
    models: models?.data ?? orch.config.models,
    permissionProfiles: profiles?.data ?? orch.config.permissionProfiles,
    // Operator policy on which approval postures may be offered. Null when
    // unavailable, which the picker reads as unconstrained.
    allowedApprovalModes: requirements
      ? permittedApprovalModes(
          requirements.allowedApprovalPolicies,
          requirements.allowedSandboxModes,
        )
      : orch.config.allowedApprovalModes,
  };
  emit({ type: "config", config: orch.config });
  // These domains load independently so one failure cannot erase the others.
  void orch.refreshSkills();
  void orch.loadWebSearchMode();
  void orch.refreshCapabilities();
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, (e) => {
    const meta = roleOf(e.sender.id);
    return {
      ...orch.snapshot(),
      terminalAvailable: terminals.available,
      pinnedThreadId:
        meta?.role.kind === "conversation" ? meta.role.conversationId : null,
      promptCapture: meta?.role.kind === "promptCapture",
    };
  });

  ipcMain.handle(IPC.installRuntime, async () => {
    const previousReady =
      orch.preflight.kind === "ready" ? orch.preflight : null;
    try {
      const installed = await managedRuntime.install((progress) => {
        setPreflight({
          kind: "runtimeInstalling",
          version: MANAGED_CODEX_RELEASE.version,
          ...progress,
        });
      });
      setPreflight({
        kind: "ready",
        version: installed.version,
        warning: null,
        runtimePath: managedRuntime.displayPath,
      });
      if (!client) await boot();
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A failed Settings reinstall must not take a healthy, already-running
      // session offline. Initial setup has no fallback and uses the full retry
      // surface; a live session reports the failure inside Settings instead.
      if (client && previousReady) {
        setPreflight(previousReady);
      } else {
        setPreflight({
          kind: "runtimeError",
          version: MANAGED_CODEX_RELEASE.version,
          detail,
        });
      }
      return { ok: false, error: detail };
    }
  });

  // A thread in its own window (3.2).
  ipcMain.handle(IPC.openInNewWindow, (_e, threadId: string) => {
    createAuxWindow({ kind: "conversation", conversationId: threadId });
  });

  /**
   * Quick chat (4.7): start a thread without focusing the app. The draft
   * survives dismissal because it is persisted like any other draft.
   */
  ipcMain.handle(IPC.promptCaptureSubmit, async (_e, text: string) => {
    const result = await submitCapturedPrompt(text, {
      createConversation: () => orch.newThread({}),
      sendPrompt: (conversationId, prompt) =>
        orch.sendMessage(conversationId, prompt),
    });
    if (result.kind !== "submitted") return null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return result.conversationId;
  });

  ipcMain.handle(IPC.promptCaptureClose, (e) => {
    roleOf(e.sender.id)?.win.close();
  });

  ipcMain.handle(IPC.addProject, async (_e, root: string) => {
    if (await orch.useWorkspace(root)) {
      await loadConfig();
      await watchRoots();
    }
    return orch.snapshot().projects;
  });
  ipcMain.handle(IPC.setActiveProject, async (_e, id: string) => {
    await orch.setActiveProject(id);
    await loadConfig();
    await watchRoots();
  });
  ipcMain.handle(IPC.renameProject, (_e, id: string, name: string) =>
    orch.renameProject(id, name),
  );
  ipcMain.handle(
    IPC.registerIsolatedWorkspace,
    async (_e, projectId: string, name: string) => {
      const result = await orch.registerIsolatedWorkspace(projectId, name);
      if (result.project) {
        await orch.setActiveProject(result.project.id);
        await loadConfig();
        await watchRoots();
      }
      return result;
    },
  );
  ipcMain.handle(IPC.revealProject, (_e, id: string) => {
    const project = orch
      .snapshot()
      .projects.find((candidate) => candidate.id === id);
    if (project) shell.showItemInFolder(project.activeRoot);
  });
  ipcMain.handle(IPC.removeProject, (_e, id: string) => orch.removeProject(id));

  ipcMain.handle(IPC.selectWorkspace, async () => {
    const res = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = res.filePaths[0];
    if (res.canceled || !dir) return null;
    if (await orch.useWorkspace(dir)) {
      await loadConfig();
      await watchRoots();
    }
    return orch.workspace;
  });

  ipcMain.handle(IPC.setWorkspace, async (_e, dir: string) => {
    if (await orch.useWorkspace(dir)) {
      await loadConfig();
      await watchRoots();
    }
    return orch.workspace;
  });
  ipcMain.handle(IPC.readGitBranches, (_e, cwd: string) =>
    orch.readGitBranches(cwd),
  );

  // Each of these can bring a worktree into existence or into memory, and a
  // root that is not watched produces no `filesChanged` — so the changes pane
  // and file tree silently stop updating for exactly the isolated threads.
  ipcMain.handle(IPC.newThread, async (_e, opts: NewThreadOptions = {}) => {
    const id = await orch.newThread(opts);
    await watchRoots();
    return id;
  });
  ipcMain.handle(IPC.openThread, async (_e, threadId: string) => {
    await orch.openThread(threadId);
    await watchRoots();
  });
  ipcMain.handle(IPC.closeThread, (_e, threadId: string) =>
    orch.closeThread(threadId),
  );
  ipcMain.handle(IPC.renameThread, (_e, threadId: string, name: string) =>
    orch.renameThread(threadId, name),
  );
  ipcMain.handle(IPC.archiveThread, (_e, threadId: string, archived: boolean) =>
    orch.archiveThread(threadId, archived),
  );
  ipcMain.handle(IPC.deleteThread, (_e, threadId: string) =>
    orch.deleteThread(threadId),
  );
  ipcMain.handle(IPC.pinThread, (_e, threadId: string, pinned: boolean) =>
    orch.pinThread(threadId, pinned),
  );
  ipcMain.handle(
    IPC.forkThread,
    async (_e, threadId: string, lastTurnId?: string) => {
      const id = await orch.forkThread(threadId, lastTurnId);
      await watchRoots();
      return id;
    },
  );

  ipcMain.handle(IPC.sendMessage, (_e, threadId: string, text: string) =>
    orch.sendMessage(threadId, text),
  );
  ipcMain.handle(IPC.saveDraft, (_e, threadId: string, draft: string) =>
    orch.saveDraft(threadId, draft),
  );
  ipcMain.handle(IPC.removeQueued, (_e, threadId: string, id: string) =>
    orch.removeQueued(threadId, id),
  );
  ipcMain.handle(
    IPC.editQueued,
    (_e, threadId: string, id: string, text: string) =>
      orch.editQueued(threadId, id, text),
  );
  ipcMain.handle(IPC.steerNow, (_e, threadId: string) =>
    orch.steerNow(threadId),
  );
  ipcMain.handle(
    IPC.moveQueued,
    (_e, threadId: string, id: string, toIndex: number) =>
      orch.moveQueued(threadId, id, toIndex),
  );

  /**
   * Pasted or dropped attachments (4.4). The renderer hands over bytes, never
   * a path it chose — writing happens here, into our own temp directory, so
   * the renderer gains no filesystem authority.
   */
  ipcMain.handle(
    IPC.addAttachment,
    (
      _e,
      threadId: string,
      file: {
        name: string;
        kind: "image" | "file";
        bytes: Uint8Array;
        preview?: string;
      },
    ) => {
      const MAX = 10 * 1024 * 1024;
      if (file.bytes.byteLength > MAX) {
        emit({
          type: "log",
          level: "error",
          message: `attachment too large (${Math.round(file.bytes.byteLength / 1048576)}MB > 10MB)`,
        });
        return null;
      }
      const dir = path.join(app.getPath("userData"), "attachments");
      mkdirSync(dir, { recursive: true });
      const id = randomUUID();
      const safe = file.name.replace(/[^\w.\-]/g, "_").slice(-64) || "file";
      const dest = path.join(dir, `${id}-${safe}`);
      try {
        writeFileSync(dest, Buffer.from(file.bytes));
      } catch (err) {
        emit({
          type: "log",
          level: "error",
          message: `could not save attachment: ${err instanceof Error ? err.message : err}`,
        });
        return null;
      }
      const attachment = {
        id,
        kind: file.kind,
        name: file.name,
        path: dest,
        preview: file.preview,
      };
      orch.addAttachment(threadId, attachment);
      return attachment;
    },
  );

  ipcMain.handle(IPC.removeAttachment, (_e, threadId: string, id: string) =>
    orch.removeAttachment(threadId, id),
  );
  ipcMain.handle(IPC.interrupt, (_e, threadId: string) =>
    orch.interrupt(threadId),
  );
  ipcMain.handle(
    IPC.answerRequest,
    (_e, requestId: string | number, answer: RequestAnswer) =>
      orch.answerRequest(requestId, answer),
  );

  // --- sign-in (§8.5) ---
  ipcMain.handle(IPC.startLogin, (_e, method: LoginMethod) =>
    orch.startLogin(method),
  );
  ipcMain.handle(IPC.cancelLogin, () => orch.cancelLogin());
  ipcMain.handle(IPC.logout, () => orch.logout());

  ipcMain.handle(
    IPC.setApprovalsReviewer,
    (_e, reviewer: "user" | "auto_review" | "guardian_subagent") =>
      orch.setApprovalsReviewer(reviewer),
  );
  ipcMain.handle(
    IPC.setApprovalMode,
    (_e, threadId: string | null, mode: unknown) => {
      // Validated rather than trusted: this widens what the agent may do
      // without asking, so an unrecognized value must not reach the server.
      if (!isApprovalMode(mode)) return;
      orch.setApprovalMode(threadId, mode);
    },
  );
  ipcMain.handle(IPC.readUsage, () => orch.readUsage());
  ipcMain.handle(IPC.consumeResetCredit, () => orch.consumeResetCredit());
  ipcMain.handle(IPC.setNotifyMode, (_e, mode: NotifyMode) =>
    orch.setNotifyMode(mode),
  );
  ipcMain.handle(IPC.setUseWorktrees, (_e, enabled: boolean) =>
    orch.setUseWorktrees(enabled),
  );
  ipcMain.handle(
    IPC.startReview,
    (_e, threadId: string, target: ReviewTarget) =>
      orch.startReview(threadId, target),
  );
  ipcMain.handle(IPC.compactThread, (_e, threadId: string) =>
    orch.compactThread(threadId),
  );
  ipcMain.handle(IPC.searchFiles, (_e, query: string, workspaceRoot?: string) =>
    orch.searchFiles(query, workspaceRoot),
  );
  ipcMain.handle(IPC.setModel, (_e, model: string | null) =>
    orch.setModel(model),
  );
  ipcMain.handle(IPC.setReasoningEffort, (_e, effort: string | null) =>
    orch.setReasoningEffort(effort),
  );
  ipcMain.handle(IPC.setServiceTier, (_e, tier: string | null) =>
    orch.setServiceTier(tier),
  );

  // The terminal runs in the thread's own cwd — the worktree when one is
  // active — so it sees exactly what the agent sees.
  ipcMain.handle(IPC.termOpen, (_e, id: string, cols: number, rows: number) => {
    const t = orch.activeThreadId ? orch.getThread(orch.activeThreadId) : null;
    const cwd = t?.worktreePath ?? t?.cwd ?? orch.workspace;
    if (!cwd) return false;
    return terminals.open(id, cwd, cols, rows);
  });
  ipcMain.handle(IPC.termWrite, (_e, id: string, data: string) =>
    terminals.write(id, data),
  );
  ipcMain.handle(IPC.termResize, (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows),
  );
  ipcMain.handle(IPC.termClose, (_e, id: string) => terminals.close(id));

  // Reads are local Node `fs` behind a narrow interface, confined to the
  // workspace and worktree roots — the renderer never gets a free path.
  ipcMain.handle(IPC.readDir, (_e, dir: string) => files.readDirectory(dir));
  ipcMain.handle(IPC.readFile, (_e, file: string) => files.readFile(file));
  // Transcript images, which live outside the workspace — see `readImage`.
  ipcMain.handle(IPC.readImage, (_e, file: string) => files.readImage(file));

  /**
   * Hand a file to the OS default application.
   *
   * Confined to the same roots as reads: an unchecked `openPath` would let the
   * renderer launch anything on disk. `shell.openPath` resolves the user's own
   * file association, so "open in editor" needs no editor setting to be
   * useful — and returns a non-empty string on failure rather than throwing.
   */
  ipcMain.handle(IPC.openPath, async (_e, target: string) => {
    if (!files.isAllowed(target)) {
      return "That file is outside the current workspace.";
    }
    const problem = await shell.openPath(target);
    return problem || null;
  });

  /**
   * Copy a file's contents to the clipboard.
   *
   * Reuses `files.readFile` rather than reading directly: the tree's context
   * menu must not become a second read path that skips the allow-list, and
   * routing it through the same call means the typed states apply here too —
   * copying a `.zip` or a too-large file reports why instead of putting
   * mojibake on the clipboard.
   */
  ipcMain.handle(IPC.copyFileContents, async (_e, target: string) => {
    const contents = await files.readFile(target);
    if (contents.kind !== "text") {
      return contents.kind === "error"
        ? contents.detail
        : "That file has no text contents to copy.";
    }
    clipboard.writeText(contents.text);
    return null;
  });

  /** Show a file in Finder. Same confinement as `openPath`, same reasons. */
  ipcMain.handle(IPC.revealPath, (_e, target: string) => {
    if (!files.isAllowed(target)) {
      return "That file is outside the current workspace.";
    }
    shell.showItemInFolder(target);
    return null;
  });

  // --- capabilities (§4.5 / V2.4) ---
  ipcMain.handle(IPC.setSkillEnabled, (_e, path: string, enabled: boolean) =>
    orch.setSkillEnabled(path, enabled),
  );
  ipcMain.handle(IPC.refreshSkills, () => orch.refreshSkills(true));
  ipcMain.handle(
    IPC.setPluginEnabled,
    (_e, pluginId: string, enabled: boolean) =>
      orch.setPluginEnabled(pluginId, enabled),
  );
  ipcMain.handle(IPC.refreshCapabilities, () => orch.refreshCapabilities());
  ipcMain.handle(IPC.reloadMcpServers, () => orch.reloadMcpServers());
  ipcMain.handle(IPC.setWebSearchMode, (_e, mode: WebSearchMode) =>
    orch.setWebSearchMode(mode),
  );

  // --- changes pane, delivery, comments (milestone 3, §7) ---
  ipcMain.handle(IPC.refreshChanges, (_e, threadId: string) =>
    orch.refreshChanges(threadId),
  );
  ipcMain.handle(
    IPC.setChangesScope,
    (_e, threadId: string, scope: ChangesScope) =>
      orch.setChangesScope(threadId, scope),
  );
  ipcMain.handle(IPC.prepareDelivery, (_e, threadId: string) =>
    orch.prepareDelivery(threadId),
  );
  ipcMain.handle(
    IPC.commitChanges,
    (_e, threadId: string, message: string, selected?: string[]) =>
      orch.commitChanges(threadId, message, selected),
  );
  ipcMain.handle(IPC.pushBranch, (_e, threadId: string) =>
    orch.pushBranch(threadId),
  );
  ipcMain.handle(
    IPC.createPullRequest,
    (_e, threadId: string, title: string, body: string) =>
      orch.createPullRequest(threadId, title, body),
  );
  ipcMain.handle(IPC.generateCommitMessage, (_e, threadId: string) =>
    orch.proposeCommitMessage(threadId),
  );
  ipcMain.handle(
    IPC.addComment,
    (_e, threadId: string, draft: ReviewNoteDraftInput) =>
      orch.addReviewNote(threadId, draft),
  );
  ipcMain.handle(IPC.removeComment, (_e, threadId: string, commentId: string) =>
    orch.removeReviewNote(threadId, commentId),
  );
  ipcMain.handle(
    IPC.submitComments,
    (_e, threadId: string, text: string, target: ReviewSubmissionTarget) =>
      orch.submitReviewNotes(threadId, text, target),
  );
}

void app.whenReady().then(() => {
  store = new Store(Store.defaultPath());
  const persisted = store.load();
  // Roots are computed per call: the workspace plus every loaded worktree.
  files = new LocalFileSystem(
    () =>
      [orch.workspace, ...orch.worktreeRoots()].filter((r): r is string =>
        Boolean(r),
      ),
    // Image-only roots: our attachment directory and the OS temporary
    // directory used by app-server local-image inputs.
    () => [path.join(app.getPath("userData"), "attachments"), tmpdir()],
  );
  orch = new Orchestrator({
    store,
    emit,
    notify,
    worktreeContainer: path.join(app.getPath("userData"), "worktrees"),
    // Empty-`@` lists the root's files (fuzzyFileSearch cannot); reuse the
    // file-tree reader so the ignore rules and confinement match.
    listDir: async (dir) =>
      (await files.readDirectory(dir)).map((e) => ({
        path: e.path,
        file_name: e.name,
        root: dir,
      })),
    // The auth URL comes from app-server, so it is outside input. The
    // Markdown renderer already refuses non-http(s) hrefs for the same
    // reason; `shell.openExternal` will happily launch a `file://` or a
    // custom scheme, which is a wider door than signing in needs.
    openExternal: openSafeExternalUrl,
  });
  terminals = new TerminalHost({
    onData: (id, data) => emit({ type: "terminalData", id, data }),
    onExit: (id, code) => emit({ type: "terminalExit", id, code }),
  });
  managedRuntime = new ManagedCodexRuntime(
    path.join(app.getPath("userData"), "runtime", "codex"),
  );
  orch.workspace = persisted.recents[0] ?? null;
  registerIpc();
  createWindow();
  configureAutoUpdates();

  // Global shortcut for quick chat. Registration fails silently when another
  // app already owns the combination, which is not worth crashing over.
  try {
    globalShortcut.register("CommandOrControl+Shift+Space", openPromptCapture);
  } catch {
    // No quick chat; everything else still works.
  }

  void boot();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (
    shouldCreateWindowOnActivate({
      openWindowCount: BrowserWindow.getAllWindows().length,
      installingUpdate,
    })
  ) {
    createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  stopServices();
});
