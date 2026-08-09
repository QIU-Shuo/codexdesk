import { StdioTransport } from "./transport";
import { RpcConnection, type JsonRpcId } from "./rpc";
import { RequestBroker } from "./requestBroker";
import type { GetAccountResponse } from "../../protocol/generated/v2/GetAccountResponse";
import type { LoginAccountParams } from "../../protocol/generated/v2/LoginAccountParams";
import type { LoginAccountResponse } from "../../protocol/generated/v2/LoginAccountResponse";
import type { AccountLoginCompletedNotification } from "../../protocol/generated/v2/AccountLoginCompletedNotification";
import type { ThreadStartResponse } from "../../protocol/generated/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "../../protocol/generated/v2/ThreadResumeResponse";
import type { ThreadForkResponse } from "../../protocol/generated/v2/ThreadForkResponse";
import type { ThreadListResponse } from "../../protocol/generated/v2/ThreadListResponse";
import type { ThreadReadResponse } from "../../protocol/generated/v2/ThreadReadResponse";
import type { Thread } from "../../protocol/generated/v2/Thread";
import type { ItemStartedNotification } from "../../protocol/generated/v2/ItemStartedNotification";
import type { ItemCompletedNotification } from "../../protocol/generated/v2/ItemCompletedNotification";
import type { TurnStartedNotification } from "../../protocol/generated/v2/TurnStartedNotification";
import type { TurnCompletedNotification } from "../../protocol/generated/v2/TurnCompletedNotification";
import type { ErrorNotification } from "../../protocol/generated/v2/ErrorNotification";
import type { ServerRequestResolvedNotification } from "../../protocol/generated/v2/ServerRequestResolvedNotification";
import type { ReasoningTextDeltaNotification } from "../../protocol/generated/v2/ReasoningTextDeltaNotification";
import type { ReasoningSummaryTextDeltaNotification } from "../../protocol/generated/v2/ReasoningSummaryTextDeltaNotification";
import type { TurnDiffUpdatedNotification } from "../../protocol/generated/v2/TurnDiffUpdatedNotification";
import type { TurnPlanUpdatedNotification } from "../../protocol/generated/v2/TurnPlanUpdatedNotification";
import type { ThreadTokenUsageUpdatedNotification } from "../../protocol/generated/v2/ThreadTokenUsageUpdatedNotification";
import type { AccountRateLimitsUpdatedNotification } from "../../protocol/generated/v2/AccountRateLimitsUpdatedNotification";
import type { GetAccountTokenUsageResponse } from "../../protocol/generated/v2/GetAccountTokenUsageResponse";
import type { GetAccountRateLimitsResponse } from "../../protocol/generated/v2/GetAccountRateLimitsResponse";
import type { ItemGuardianApprovalReviewStartedNotification } from "../../protocol/generated/v2/ItemGuardianApprovalReviewStartedNotification";
import type { ItemGuardianApprovalReviewCompletedNotification } from "../../protocol/generated/v2/ItemGuardianApprovalReviewCompletedNotification";
import type { ThreadNameUpdatedNotification } from "../../protocol/generated/v2/ThreadNameUpdatedNotification";
import type { ThreadStatusChangedNotification } from "../../protocol/generated/v2/ThreadStatusChangedNotification";
import type { UserInput } from "../../protocol/generated/v2/UserInput";
import type { RateLimitSnapshot } from "../../protocol/generated/v2/RateLimitSnapshot";
import type { FuzzyFileSearchResponse } from "../../protocol/generated/FuzzyFileSearchResponse";
import type { ApprovalsReviewer } from "../../protocol/generated/v2/ApprovalsReviewer";
import type { AskForApproval } from "../../protocol/generated/v2/AskForApproval";
import type { SandboxMode } from "../../protocol/generated/v2/SandboxMode";
import type { SandboxPolicy } from "../../protocol/generated/v2/SandboxPolicy";
import type { ReasoningEffort } from "../../protocol/generated/ReasoningEffort";
import type { ModelListResponse } from "../../protocol/generated/v2/ModelListResponse";
import type { PermissionProfileListResponse } from "../../protocol/generated/v2/PermissionProfileListResponse";
import type { SkillsListResponse } from "../../protocol/generated/v2/SkillsListResponse";
import type { PluginInstalledResponse } from "../../protocol/generated/v2/PluginInstalledResponse";
import type { McpServerStatus } from "../../protocol/generated/v2/McpServerStatus";
import type { McpServerStatusDetail } from "../../protocol/generated/v2/McpServerStatusDetail";
import type { ListMcpServerStatusResponse } from "../../protocol/generated/v2/ListMcpServerStatusResponse";
import type { McpServerStatusUpdatedNotification } from "../../protocol/generated/v2/McpServerStatusUpdatedNotification";
import type { ConfigRequirements } from "../../protocol/generated/v2/ConfigRequirements";
import type { ConfigReadResponse } from "../../protocol/generated/v2/ConfigReadResponse";
import type { ReviewStartResponse } from "../../protocol/generated/v2/ReviewStartResponse";
import type { CapabilitiesPort } from "../../application/domains/capabilities/ports";
import type {
  McpServerView,
  PluginView,
  SkillCatalog,
  WebSearchMode,
  WebSearchSettings,
} from "../../contracts/views/capabilities";
import {
  mapMcpServers,
  mapMcpStatus,
  mapPlugins,
  mapSkillCatalog,
  mapWebSearchSettings,
  pluginConfigKey,
} from "../../infrastructure/app-server/adapters/capabilities";
import { mapThreadStatus } from "../../infrastructure/app-server/adapters/conversations";
import type { AgentRunState } from "../../contracts/views/conversations";
import type {
  AppEvent,
  AuthState,
  DeltaKind,
  RequestAnswer,
  ReviewTarget,
  UsageReport,
} from "../../shared/ipc";

const CLIENT_INFO = {
  name: "codexdesk",
  title: "CodexDesk",
  version: "0.1.0",
};

/**
 * Delta streams that carry no index. Reasoning is handled separately because
 * its two streams key on *different* counters (`contentIndex` vs
 * `summaryIndex`) and must not share a buffer.
 */
const FLAT_DELTAS: Record<string, DeltaKind> = {
  "item/agentMessage/delta": "agentMessage",
  "item/commandExecution/outputDelta": "commandOutput",
};

export type ThreadConfig = {
  cwd: string;
  model?: string | null;
  effort?: ReasoningEffort | null;
  serviceTier?: string | null;
  /**
   * Who answers approvals (§8.2). Omitted means the server's default; we
   * always pass it explicitly so a resumed thread follows the app's current
   * posture rather than the one it was created under.
   */
  approvalsReviewer?: ApprovalsReviewer | null;
  /**
   * The safety posture (approval policy plus sandbox), derived from the
   * thread's approval mode by `threadParamsFor`. Both halves travel together
   * because codex core decides when to ask for approval from the pair.
   */
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
};

/**
 * Typed facade over the app-server connection.
 *
 * One connection serves every thread — app-server multiplexes by `threadId`,
 * so opening a second thread costs a method call rather than a process. All
 * notifications carry `threadId`, which is what makes the fan-out in
 * `onNotification` possible.
 *
 * The renderer never sees raw protocol shapes; this is where `[UNSTABLE]`
 * parts of the schema stop (§12.1).
 */
export class AppServerClient implements CapabilitiesPort {
  private transport = new StdioTransport();
  private rpc: RpcConnection;
  readonly broker: RequestBroker;
  /** Last full snapshot; sparse updates merge into this (§5, step 2.4). */
  private rateLimits: RateLimitSnapshot | null = null;
  private activeTurns = new Map<string, string>();

  constructor(private readonly emit: (ev: AppEvent) => void) {
    this.broker = new RequestBroker({
      onPending: (request) => this.emit({ type: "requestPending", request }),
      onResolved: (threadId, requestId) =>
        this.emit({ type: "requestResolved", threadId, requestId }),
      log: (message) => this.emit({ type: "log", level: "error", message }),
    });

    this.rpc = new RpcConnection(
      (msg) => this.transport.send(msg),
      (method, params, id) => this.broker.handle(method, params, id),
      (method, params) => this.onNotification(method, params),
    );

    this.transport.on("message", (msg) => this.rpc.handleMessage(msg));
    // app-server's stderr is a debug firehose — model-cache JSON dumps and
    // tracing lines that mean nothing to a user. Forwarding all of it produced
    // hundreds of entries on a normal startup. Keep it on the process stderr
    // for development, and surface only lines that look like something the
    // user can act on.
    this.transport.on("stderr", (line) => {
      if (process.env.CODEXDESK_VERBOSE) console.error(`[codex] ${line}`);
      if (isNoise(line)) return;
      this.emit({ type: "log", level: "error", message: `[codex] ${line}` });
    });
    this.transport.on("exit", (code, signal) => {
      const reason = `app-server exited (code=${code} signal=${signal})`;
      this.rpc.close(reason);
      this.broker.clearAll(reason);
      this.activeTurns.clear();
      this.emit({ type: "log", level: "error", message: reason });
    });
  }

  async connect(): Promise<void> {
    this.transport.start();
    await this.rpc.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.rpc.notify("initialized", {});
  }

  /**
   * Read the account, distinguishing "signed out" from "no account details".
   *
   * `account` and `requiresOpenaiAuth` are independent. A valid ChatGPT
   * session can return `account: null` with `requiresOpenaiAuth: false` —
   * verified live against 0.144.4 while `codex login status` reported
   * `Logged in using ChatGPT`. Mapping a null account straight to signed-out
   * (as this did since Phase 0) therefore prompted a working install to sign
   * in, which only became visible once §8.5 replaced the one-line banner with
   * a real sign-in surface.
   */
  async readAuth(): Promise<AuthState> {
    const res = await this.rpc.request<GetAccountResponse>("account/read", {});
    if (res.account) return { kind: "signedIn", account: res.account };
    return res.requiresOpenaiAuth
      ? { kind: "signedOut", requiresOpenaiAuth: true }
      : { kind: "authenticated" };
  }

  /**
   * Begin signing in (§8.5).
   *
   * `account/login/start` is a discriminated union whose *params* type is
   * `LoginAccountParams` — not the `AccountLoginStartParams` name the method
   * might suggest. Each variant returns a different response:
   *
   * - `chatgpt` → `loginId` + `authUrl`; open the URL, then await completion.
   * - `chatgptDeviceCode` → `loginId` + `verificationUrl` + `userCode`.
   * - `apiKey` / `chatgptAuthTokens` → nothing; success is immediate.
   *
   * The first two only *start* login. The outcome arrives asynchronously as
   * `account/login/completed`, which is why `onLoginCompleted` exists.
   *
   * `amazonBedrock` is absent from the installed CLI's union (0.144.4), so
   * keep these variants aligned with the generated types when upgrading.
   */
  async startLogin(params: LoginAccountParams): Promise<LoginAccountResponse> {
    return this.rpc.request<LoginAccountResponse>(
      "account/login/start",
      params,
    );
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.rpc.request("account/login/cancel", { loginId });
  }

  /** Signs out. The server answers with `account/updated`. */
  async logout(): Promise<void> {
    await this.rpc.request("account/logout", {});
  }

  /**
   * The account usage report (§8.6).
   *
   * **The numeric fields are `bigint`.** `ts-rs` maps Rust's u64 that way, and
   * a bigint cannot cross `JSON.stringify` — which is exactly what Electron
   * IPC does to everything it carries. Left alone this throws
   * `TypeError: Do not know how to serialize a BigInt` at the boundary, not
   * at the call site. So the conversion to `number` happens here, at the edge
   * that owns the protocol shapes.
   *
   * Token counts are far below 2^53, so the narrowing is lossless in practice.
   */
  async readUsage(): Promise<UsageReport | null> {
    try {
      const res = await this.rpc.request<GetAccountTokenUsageResponse>(
        "account/usage/read",
        {},
      );
      const n = (v: bigint | null): number | null =>
        v == null ? null : Number(v);
      return {
        lifetimeTokens: n(res.summary.lifetimeTokens),
        peakDailyTokens: n(res.summary.peakDailyTokens),
        longestRunningTurnSec: n(res.summary.longestRunningTurnSec),
        currentStreakDays: n(res.summary.currentStreakDays),
        longestStreakDays: n(res.summary.longestStreakDays),
        dailyBuckets: (res.dailyUsageBuckets ?? []).map((b) => ({
          startDate: b.startDate,
          tokens: Number(b.tokens),
        })),
      };
    } catch {
      // Unavailable when signed out, and on API-key accounts that have no
      // usage backend. Not an error worth a banner.
      return null;
    }
  }

  /**
   * Redeem an earned rate-limit reset (§8.6).
   *
   * `idempotencyKey` identifies one logical attempt, so a retry must reuse
   * the key it was given rather than minting a new one — the caller owns it
   * for that reason.
   */
  async consumeResetCredit(idempotencyKey: string): Promise<boolean> {
    try {
      await this.rpc.request("account/rateLimitResetCredit/consume", {
        idempotencyKey,
      });
      // The fresh limits arrive as account/rateLimits/updated; re-read so the
      // bar does not keep showing the exhausted window until the next event.
      await this.readRateLimits();
      return true;
    } catch {
      return false;
    }
  }

  async readRateLimits(): Promise<RateLimitSnapshot | null> {
    try {
      const res = await this.rpc.request<GetAccountRateLimitsResponse>(
        "account/rateLimits/read",
        {},
      );
      this.rateLimits = res.rateLimits;
      return this.rateLimits;
    } catch {
      return null; // unavailable when signed out; not an error worth surfacing
    }
  }

  // ---- thread lifecycle (plan §6, 3.1) ----

  /**
   * The config fields every thread-lifecycle method sends.
   *
   * Start, resume and fork all re-accept the full thread config, so the
   * posture has to be spelled out three times; sharing the derivation is what
   * keeps them from drifting. Each field is omitted when unset so the server's
   * own default applies rather than a null overriding it.
   */
  private threadConfigParams(config: ThreadConfig): Record<string, unknown> {
    return {
      cwd: config.cwd,
      ...(config.approvalPolicy
        ? { approvalPolicy: config.approvalPolicy }
        : {}),
      ...(config.sandbox ? { sandbox: config.sandbox } : {}),
      ...(config.approvalsReviewer
        ? { approvalsReviewer: config.approvalsReviewer }
        : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
    };
  }

  async startThread(config: ThreadConfig): Promise<Thread> {
    const res = await this.rpc.request<ThreadStartResponse>("thread/start", {
      ...this.threadConfigParams(config),
    });
    return res.thread;
  }

  /**
   * Resume re-accepts the full thread config, so this is not purely a
   * restore. The caller decides which posture to re-send; it passes the
   * thread's *own* saved approval mode, so a thread that was read-only three
   * days ago comes back read-only rather than silently widening.
   */
  async resumeThread(threadId: string, config: ThreadConfig): Promise<Thread> {
    const res = await this.rpc.request<ThreadResumeResponse>("thread/resume", {
      threadId,
      ...this.threadConfigParams(config),
    });
    return res.thread;
  }

  /**
   * `lastTurnId` forks from a specific point rather than the tip — the
   * checkpoint primitive (§9.4 explains why not `thread/rollback`).
   * Note it does **not** revert files; that is the worktree's job.
   */
  async forkThread(
    threadId: string,
    config: ThreadConfig,
    lastTurnId?: string,
  ): Promise<Thread> {
    const res = await this.rpc.request<ThreadForkResponse>("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...this.threadConfigParams(config),
    });
    return res.thread;
  }

  /**
   * `useStateDbOnly` skips JSONL rollout scanning — the fast path for a
   * launch-time picker. `searchTerm` filters by title server-side.
   */
  async listThreads(params: {
    cwd?: string | string[];
    limit?: number;
    cursor?: string;
    archived?: boolean;
    searchTerm?: string;
    fast?: boolean;
  }): Promise<ThreadListResponse> {
    const { fast, ...rest } = params;
    return this.rpc.request<ThreadListResponse>("thread/list", {
      ...rest,
      ...(fast ? { useStateDbOnly: true } : {}),
    });
  }

  /** `includeTurns` is the difference between a picker row and full history. */
  async readThread(threadId: string, includeTurns: boolean): Promise<Thread> {
    const res = await this.rpc.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns,
    });
    return res.thread;
  }

  /** Thread ids app-server still holds in memory — the reconciliation
   * primitive for launch-time recovery (plan §6, 3.3). */
  async loadedThreadIds(): Promise<string[]> {
    try {
      const res = await this.rpc.request<{ data: string[] }>(
        "thread/loaded/list",
        {},
      );
      return res.data;
    } catch {
      return [];
    }
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.rpc.request("thread/name/set", { threadId, name });
  }

  async archiveThread(threadId: string, archived: boolean): Promise<void> {
    await this.rpc.request(archived ? "thread/archive" : "thread/unarchive", {
      threadId,
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.rpc.request("thread/delete", { threadId });
  }

  /** Stop receiving notifications without deleting the thread. */
  async unsubscribe(threadId: string): Promise<void> {
    try {
      await this.rpc.request("thread/unsubscribe", { threadId });
    } catch {
      // Not fatal — worst case we keep receiving events we ignore.
    }
  }

  // ---- turns ----

  async sendMessage(
    threadId: string,
    input: UserInput[],
    options: {
      model?: string | null;
      effort?: ReasoningEffort | null;
      serviceTier?: string | null;
      approvalPolicy?: AskForApproval | null;
      sandboxPolicy?: SandboxPolicy | null;
    } = {},
  ): Promise<void> {
    // `summary: "auto"` asks the model to emit reasoning summaries. Without
    // it the server sends a reasoning *item* with empty `summary`/`content`
    // and no delta stream — the "thinking" box then shows a header with
    // nothing under it (verified against 0.144.4).
    //
    // The approval and sandbox overrides apply "for this turn and subsequent
    // turns", which is what lets a mode change take effect on a thread that
    // is already open rather than only on the next one.
    await this.rpc.request("turn/start", {
      threadId,
      input,
      summary: "auto",
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.approvalPolicy
        ? { approvalPolicy: options.approvalPolicy }
        : {}),
      ...(options.sandboxPolicy
        ? { sandboxPolicy: options.sandboxPolicy }
        : {}),
    });
  }

  async interrupt(threadId: string): Promise<void> {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) return;
    await this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  /** Ask the server to replace this thread's accumulated context with a
   * compact summary. Unlike a user turn, compaction is its own protocol verb. */
  async compact(threadId: string): Promise<void> {
    await this.rpc.request("thread/compact/start", { threadId });
  }

  /**
   * Inject input into the *running* turn (§8.1).
   *
   * `expectedTurnId` is a required precondition, not a convenience: if the
   * turn we meant to steer has already ended, the server rejects rather than
   * silently applying our input to whatever turn is running now. That race is
   * real — a queued message drains on a timer, and turns end on their own
   * schedule.
   *
   * Not every turn is steerable. `activeTurnNotSteerable` names the two kinds
   * that are not (`review`, `compact`), and the caller is expected to fall
   * back to queueing rather than dropping the input.
   */
  async steer(
    threadId: string,
    expectedTurnId: string,
    input: UserInput[],
  ): Promise<
    | { kind: "delivered" }
    | { kind: "turnEnded" }
    | { kind: "notSteerable"; detail: string | null }
  > {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId || turnId !== expectedTurnId) return { kind: "turnEnded" };
    try {
      await this.rpc.request("turn/steer", {
        threadId,
        input,
        expectedTurnId,
      });
      return { kind: "delivered" };
    } catch (error) {
      const detail = activeTurnNotSteerableDetail(error);
      if (detail !== undefined) return { kind: "notSteerable", detail };
      throw error;
    }
  }

  answerRequest(requestId: JsonRpcId, answer: RequestAnswer): void {
    this.broker.answer(requestId, answer);
  }

  pendingFor(threadId: string) {
    return this.broker.pendingFor(threadId);
  }

  isTurnActive(threadId: string): boolean {
    return this.activeTurns.has(threadId);
  }

  activeTurnId(threadId: string): string | null {
    return this.activeTurns.get(threadId) ?? null;
  }

  // ---- Phase 4 surfaces ----

  /** Detached review runs on its own thread and returns its id (§12.3). */
  async startReview(
    threadId: string,
    target: ReviewTarget,
  ): Promise<ReviewStartResponse> {
    return this.rpc.request<ReviewStartResponse>("review/start", {
      threadId,
      target,
      delivery: "detached",
    });
  }

  async searchFiles(
    query: string,
    roots: string[],
  ): Promise<FuzzyFileSearchResponse> {
    return this.rpc.request<FuzzyFileSearchResponse>("fuzzyFileSearch", {
      query,
      roots,
      cancellationToken: null,
    });
  }

  async listModels(): Promise<ModelListResponse> {
    return this.rpc.request<ModelListResponse>("model/list", {});
  }

  async listPermissionProfiles(): Promise<PermissionProfileListResponse> {
    return this.rpc.request<PermissionProfileListResponse>(
      "permissionProfile/list",
      {},
    );
  }

  /**
   * Subscribe to filesystem changes (plan §12.4).
   *
   * Reads stay local, but the *watch* comes from app-server so our change
   * feed is coherent with the agent's own view — an edit the agent makes and
   * an edit you make arrive the same way.
   */
  async watchPath(watchId: string, path: string): Promise<boolean> {
    try {
      await this.rpc.request("fs/watch", { watchId, path });
      return true;
    } catch {
      return false;
    }
  }

  async unwatch(watchId: string): Promise<void> {
    try {
      await this.rpc.request("fs/unwatch", { watchId });
    } catch {
      // Best effort; a stale watch only costs notifications we ignore.
    }
  }

  /**
   * `forceReload` bypasses the server's skill cache. Pass it for an explicit
   * user refresh only — the `skills/changed` path already means the server
   * knows its cache is stale, so re-scanning disk there is wasted work.
   */
  async listSkills(cwd: string, forceReload = false): Promise<SkillCatalog> {
    const response = await this.rpc.request<SkillsListResponse>("skills/list", {
      cwds: [cwd],
      ...(forceReload ? { forceReload: true } : {}),
    });
    return mapSkillCatalog(response);
  }

  /**
   * Enable or disable one skill. The selector is `path` *or* `name`; we use
   * `path` because names collide across scopes — two marketplaces can both
   * ship a `github:pr-review`.
   */
  async setSkillEnabled(path: string, enabled: boolean): Promise<void> {
    await this.rpc.request("skills/config/write", { path, enabled });
  }

  /**
   * Installed plugins, with the skills/MCP servers each one provides.
   *
   * This gateway reads inventory only. Installation is a separate product
   * workflow and is not implied by listing the local catalog.
   */
  async listPlugins(cwd: string): Promise<PluginView[]> {
    const response = await this.rpc.request<PluginInstalledResponse>(
      "plugin/installed",
      {
        cwds: [cwd],
      },
    );
    return mapPlugins(response);
  }

  /**
   * MCP inventory. Paginated — a single unpaged call silently truncates, so
   * this drains `nextCursor` before returning and the renderer never sees a
   * cursor.
   *
   * Startup transitions arrive through a separate notification. The
   * application service combines that stream with this inventory.
   */
  async listMcpServers(): Promise<McpServerView[]> {
    const all: McpServerStatus[] = [];
    let cursor: string | null = null;
    // Bounded: a server list long enough to hit this is a bug, not a catalog.
    for (let page = 0; page < 50; page++) {
      const res: ListMcpServerStatusResponse =
        await this.rpc.request<ListMcpServerStatusResponse>(
          "mcpServerStatus/list",
          {
            detail: "full" satisfies McpServerStatusDetail,
            ...(cursor ? { cursor } : {}),
          },
        );
      all.push(...res.data);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return mapMcpServers(all);
  }

  /** Restart MCP servers after a config edit. Type name does not match the
   * method string — `McpServerRefresh` → `config/mcpServer/reload` (§9.6). */
  async reloadMcpServers(): Promise<void> {
    await this.rpc.request("config/mcpServer/reload", undefined);
  }

  /** Server-supplied policy: which web-search modes an operator permits. */
  async readConfigRequirements(): Promise<ConfigRequirements | null> {
    try {
      return await this.rpc.request<ConfigRequirements>(
        "configRequirements/read",
        undefined,
      );
    } catch {
      return null;
    }
  }

  async readConfig(): Promise<ConfigReadResponse | null> {
    try {
      return await this.rpc.request<ConfigReadResponse>("config/read", {});
    } catch {
      return null;
    }
  }

  /**
   * Write one key into `config.toml`. `mergeStrategy: "replace"` because
   * every value we write here is a scalar; `upsert` is for tables.
   */
  async writeConfigValue(keyPath: string, value: unknown): Promise<void> {
    await this.rpc.request("config/value/write", {
      keyPath,
      value,
      mergeStrategy: "replace",
    });
  }

  async readWebSearchSettings(): Promise<WebSearchSettings> {
    const [config, requirements] = await Promise.all([
      this.readConfig(),
      this.readConfigRequirements(),
    ]);
    return mapWebSearchSettings(config, requirements);
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    await this.writeConfigValue(pluginConfigKey(pluginId), enabled);
  }

  async setWebSearchMode(mode: WebSearchMode): Promise<void> {
    await this.writeConfigValue("web_search", mode);
  }

  private onNotification(method: string, params: unknown): void {
    // `error` is the one notification with no namespace prefix — a dispatch
    // table keyed on "/" silently drops it (§5, step 0.8).
    if (method === "error") {
      const p = params as ErrorNotification;
      this.emit({
        type: "turnError",
        threadId: p.threadId,
        error: p.error,
        willRetry: p.willRetry,
      });
      return;
    }

    const flat = FLAT_DELTAS[method];
    if (flat) {
      const p = params as { threadId: string; itemId: string; delta: string };
      this.emit({
        type: "itemDelta",
        threadId: p.threadId,
        itemId: p.itemId,
        kind: flat,
        index: 0,
        delta: p.delta,
      });
      return;
    }

    switch (method) {
      // Two reasoning streams, two separate index spaces. Merging them, or
      // ignoring the index, interleaves blocks into nonsense (§5, Phase 2).
      case "item/reasoning/textDelta": {
        const p = params as ReasoningTextDeltaNotification;
        this.emit({
          type: "itemDelta",
          threadId: p.threadId,
          itemId: p.itemId,
          kind: "reasoningText",
          index: p.contentIndex,
          delta: p.delta,
        });
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const p = params as ReasoningSummaryTextDeltaNotification;
        this.emit({
          type: "itemDelta",
          threadId: p.threadId,
          itemId: p.itemId,
          kind: "reasoningSummary",
          index: p.summaryIndex,
          delta: p.delta,
        });
        return;
      }

      case "turn/started": {
        const p = params as TurnStartedNotification;
        this.activeTurns.set(p.threadId, p.turn.id);
        this.emit({
          type: "turnStarted",
          threadId: p.threadId,
          turnId: p.turn.id,
        });
        return;
      }
      case "item/started": {
        const p = params as ItemStartedNotification;
        this.emit({
          type: "itemStarted",
          threadId: p.threadId,
          turnId: p.turnId,
          item: p.item,
          startedAtMs: p.startedAtMs,
        });
        return;
      }
      case "item/completed": {
        const p = params as ItemCompletedNotification;
        this.emit({
          type: "itemCompleted",
          threadId: p.threadId,
          turnId: p.turnId,
          item: p.item,
          completedAtMs: p.completedAtMs,
        });
        return;
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        this.activeTurns.delete(p.threadId);
        this.emit({
          type: "turnCompleted",
          threadId: p.threadId,
          turn: p.turn,
        });
        return;
      }

      // Clears exactly the resolved request. Phase 1 cleared all of them,
      // which breaks as soon as two threads have approvals open at once.
      case "serverRequest/resolved": {
        const p = params as ServerRequestResolvedNotification;
        this.broker.clearOne(p.requestId);
        return;
      }

      case "item/autoApprovalReview/started": {
        const p = params as ItemGuardianApprovalReviewStartedNotification;
        this.emit({
          type: "autoReview",
          threadId: p.threadId,
          review: {
            reviewId: p.reviewId,
            targetItemId: p.targetItemId,
            status: p.review.status,
            riskLevel: p.review.riskLevel,
            rationale: p.review.rationale,
            action: p.action,
            startedAtMs: p.startedAtMs,
            completedAtMs: null,
          },
        });
        return;
      }
      case "item/autoApprovalReview/completed": {
        const p = params as ItemGuardianApprovalReviewCompletedNotification;
        this.emit({
          type: "autoReview",
          threadId: p.threadId,
          review: {
            reviewId: p.reviewId,
            targetItemId: p.targetItemId,
            status: p.review.status,
            riskLevel: p.review.riskLevel,
            rationale: p.review.rationale,
            action: p.action,
            startedAtMs: p.startedAtMs,
            completedAtMs: p.completedAtMs,
          },
        });
        return;
      }

      case "turn/diff/updated": {
        const p = params as TurnDiffUpdatedNotification;
        this.emit({ type: "diff", threadId: p.threadId, diff: p.diff });
        return;
      }
      case "turn/plan/updated": {
        const p = params as TurnPlanUpdatedNotification;
        this.emit({
          type: "plan",
          threadId: p.threadId,
          plan: {
            explanation: p.explanation,
            steps: p.plan,
            turnId: p.turnId,
            turnEnded: false,
          },
        });
        return;
      }

      case "thread/tokenUsage/updated": {
        const p = params as ThreadTokenUsageUpdatedNotification;
        this.emit({
          type: "budget",
          threadId: p.threadId,
          budget: { tokenUsage: p.tokenUsage, rateLimits: this.rateLimits },
        });
        return;
      }

      // Explicitly sparse: merge into the last full snapshot rather than
      // replacing it, or a limit warning flickers (§5, step 2.4).
      case "account/rateLimits/updated": {
        const p = params as AccountRateLimitsUpdatedNotification;
        this.rateLimits = mergeRateLimits(this.rateLimits, p.rateLimits);
        this.emit({
          type: "budget",
          threadId: "",
          budget: { tokenUsage: null, rateLimits: this.rateLimits },
        });
        return;
      }

      case "thread/name/updated": {
        // The field is `threadName`, not `name` — §9.6's rule applies to
        // fields as well as methods.
        const p = params as ThreadNameUpdatedNotification;
        this.onThreadName?.(p.threadId, p.threadName ?? null);
        return;
      }

      case "thread/status/changed": {
        const p = params as ThreadStatusChangedNotification;
        this.onThreadStatus?.(
          p.threadId,
          mapThreadStatus(p.status, this.activeTurnId(p.threadId)),
        );
        return;
      }

      case "fs/changed": {
        const p = params as { watchId: string; changedPaths: string[] };
        this.onFsChanged?.(p.changedPaths);
        return;
      }

      /**
       * Pure invalidation — the payload is `Record<string, never>` and the
       * doc comment says to re-run `skills/list` with our current params.
       * There is no `threadId`, so this is global rather than per-thread.
       */
      case "skills/changed": {
        this.onSkillsChanged?.();
        return;
      }

      case "mcpServer/startupStatus/updated": {
        const p = params as McpServerStatusUpdatedNotification;
        this.onMcpStatus?.(mapMcpStatus(p));
        return;
      }

      case "thread/compacted": {
        const p = params as { threadId: string };
        this.emit({ type: "compacted", threadId: p.threadId });
        return;
      }

      case "account/login/completed": {
        const p = params as AccountLoginCompletedNotification;
        this.onLoginCompleted?.(p.loginId, p.success, p.error);
        return;
      }

      case "account/updated": {
        // Emitted after logout and after a successful login. Re-reading is
        // cheaper than trusting a payload shape we would have to keep in sync.
        void this.readAuth().then((state) => this.onAuthChanged?.(state));
        return;
      }

      default:
        return;
    }
  }

  /** Set by the owner to observe catalog-relevant changes. */
  onThreadName?: (threadId: string, name: string | null) => void;
  onThreadStatus?: (threadId: string, run: AgentRunState) => void;
  onFsChanged?: (paths: string[]) => void;
  /** A skill was added, edited, or removed on disk — re-list (§4.1). */
  onSkillsChanged?: () => void;
  /** MCP startup transition. The only source of `starting`/`ready`/`failed`. */
  onMcpStatus?: (
    update: import("../../contracts/views/capabilities").McpStatusUpdate,
  ) => void;
  /** Outcome of an asynchronous browser or device-code login (§8.5). */
  onLoginCompleted?: (
    loginId: string | null,
    success: boolean,
    error: string | null,
  ) => void;
  onAuthChanged?: (state: AuthState) => void;

  dispose(): void {
    this.rpc.close("client disposed");
    this.broker.clearAll("client disposed");
    this.transport.stop();
  }
}

/** Convert the public app-server refusal into an application result. */
export function activeTurnNotSteerableDetail(
  error: unknown,
): string | null | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): string | null | undefined => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const refusal = record.activeTurnNotSteerable;
    if (refusal && typeof refusal === "object") {
      const turnKind = (refusal as Record<string, unknown>).turnKind;
      return typeof turnKind === "string" ? turnKind : null;
    }
    for (const child of Object.values(record)) {
      const found = walk(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(error, 0);
}

/**
 * app-server logs tracing output and raw JSON to stderr. Only genuine
 * `ERROR`/`WARN` lines are worth showing; everything else is continuation
 * lines from a multi-line dump or routine tracing.
 */
export function isNoise(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  // Structured tracing: keep errors and warnings, drop INFO/DEBUG/TRACE.
  if (/\b(ERROR|WARN)\b/.test(trimmed)) return false;
  if (/\b(INFO|DEBUG|TRACE)\b/.test(trimmed)) return true;
  // Fragments of pretty-printed JSON dumps.
  if (/^[[\]{}(),]/.test(trimmed)) return true;
  if (/^"[^"]*":/.test(trimmed)) return true;
  if (/^[a-z_]+:\s*(true|false|\d+|null)/i.test(trimmed)) return true;
  return false;
}

/**
 * Merge a sparse rate-limit update into the last full snapshot.
 *
 * `null` means *unavailable in this update*, not *cleared* — so a null must
 * never overwrite a previously observed value. Getting this backwards makes a
 * limit warning flicker on and off (plan §5, step 2.4).
 */
export function mergeRateLimits(
  prev: RateLimitSnapshot | null,
  update: RateLimitSnapshot,
): RateLimitSnapshot {
  if (!prev) return update;
  const merged = { ...prev } as Record<string, unknown>;
  for (const [key, value] of Object.entries(update)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged as unknown as RateLimitSnapshot;
}
