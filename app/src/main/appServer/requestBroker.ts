import { RpcError, METHOD_NOT_FOUND, type JsonRpcId } from "./rpc";
import type { PendingRequest, RequestAnswer } from "../../shared/ipc";

/**
 * Holds server-initiated requests open until the user answers them.
 *
 * Phase 0 auto-declined everything as defense against the silent approval hang
 * (§9.1). Phase 1 replaced that with real routing, but the invariant is
 * unchanged and now harder to hold: **every request must eventually be
 * answered exactly once**, whether by the user, by `serverRequest/resolved`,
 * or by a fallback for kinds we do not render.
 *
 * Phase 3 change: requests are keyed by the **JSON-RPC id**, not a synthetic
 * handle. `serverRequest/resolved` carries that id, so with several threads
 * alive we can clear exactly the one the server resolved. Phase 1 cleared all
 * pending requests on any resolution — harmless with one thread, wrong the
 * moment two threads have approvals open at once.
 */
export type BrokerEvents = {
  onPending: (req: PendingRequest) => void;
  onResolved: (threadId: string, requestId: JsonRpcId) => void;
  log: (message: string) => void;
};

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  request: PendingRequest;
};

/** Server request methods we render. Anything else gets a typed refusal. */
const RENDERED: Record<string, PendingRequest["kind"]> = {
  "item/commandExecution/requestApproval": "commandApproval",
  "item/fileChange/requestApproval": "fileChangeApproval",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "userInput",
  "mcpServer/elicitation/request": "elicitation",
};

export class RequestBroker {
  private waiting = new Map<JsonRpcId, Waiter>();

  constructor(private readonly events: BrokerEvents) {}

  /** Called for every server->client request. Resolves when answered. */
  handle(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    const kind = RENDERED[method];
    if (!kind) return this.refuse(method);

    const p = params as { threadId?: string };
    const request = {
      requestId: id,
      receivedAtMs: Date.now(),
      threadId: p.threadId ?? "",
      kind,
      params,
    } as PendingRequest;

    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, request });
      this.events.onPending(request);
    });
  }

  /** The user answered. Translates our UI vocabulary into wire shapes. */
  answer(requestId: JsonRpcId, answer: RequestAnswer): void {
    const waiter = this.waiting.get(requestId);
    if (!waiter) return; // already resolved or cleared; nothing to answer
    this.waiting.delete(requestId);
    waiter.resolve(toWireResponse(waiter.request, answer));
    this.events.onResolved(waiter.request.threadId, requestId);
  }

  /**
   * The server resolved one request itself — it fires on turn start,
   * completion, and interrupt as well as on a normal answer. Drop the card
   * without replying: the id is already dead (plan §5, Phase 1).
   */
  clearOne(requestId: JsonRpcId): void {
    const waiter = this.waiting.get(requestId);
    if (!waiter) return;
    this.waiting.delete(requestId);
    this.events.onResolved(waiter.request.threadId, requestId);
  }

  /** Drop every request for one thread (thread closed, turn interrupted). */
  clearThread(threadId: string, reason: string): void {
    let n = 0;
    for (const [id, waiter] of [...this.waiting]) {
      if (waiter.request.threadId !== threadId) continue;
      this.waiting.delete(id);
      this.events.onResolved(threadId, id);
      n++;
    }
    if (n) this.events.log(`cleared ${n} pending request(s): ${reason}`);
  }

  /** Drop everything (transport died, client disposed). */
  clearAll(reason: string): void {
    const open = [...this.waiting.entries()];
    this.waiting.clear();
    for (const [id, waiter] of open) {
      this.events.onResolved(waiter.request.threadId, id);
    }
    if (open.length) {
      this.events.log(`cleared ${open.length} pending request(s): ${reason}`);
    }
  }

  get pending(): PendingRequest[] {
    return [...this.waiting.values()].map((w) => w.request);
  }

  pendingFor(threadId: string): PendingRequest[] {
    return this.pending.filter((r) => r.threadId === threadId);
  }

  private refuse(method: string): Promise<never> {
    // Still an answer — a refusal unblocks the turn, silence does not.
    this.events.log(`refused unhandled server request: ${method}`);
    return Promise.reject(
      new RpcError(METHOD_NOT_FOUND, `unhandled request: ${method}`),
    );
  }
}

/**
 * Map a UI answer onto the exact response shape each request kind expects.
 *
 * Every shape here is taken from the generated types, not from the plan's
 * prose — `ToolRequestUserInputResponse.answers` in particular is a **map
 * keyed by question id**, not an array, which the Phase 0 stub got wrong.
 */
export function toWireResponse(
  request: PendingRequest,
  answer: RequestAnswer,
): unknown {
  if (answer.kind === "decline") return declineFor(request);

  switch (answer.kind) {
    case "commandApproval":
    case "fileChangeApproval":
      return { decision: answer.decision };

    case "permissions": {
      // No explicit deny exists; an empty grant is the refusal.
      if (!answer.granted) {
        return { permissions: {}, scope: answer.scope };
      }
      const { network, readPaths, writePaths } = answer.granted;
      return {
        permissions: {
          ...(network === undefined ? {} : { network: { enabled: network } }),
          ...(readPaths || writePaths
            ? {
                fileSystem: {
                  read: readPaths ?? null,
                  write: writePaths ?? null,
                },
              }
            : {}),
        },
        scope: answer.scope,
      };
    }

    case "userInput": {
      // `{ [questionId]: { answers: string[] } }`
      const answers: Record<string, { answers: string[] }> = {};
      for (const [id, values] of Object.entries(answer.answers)) {
        answers[id] = { answers: values };
      }
      return { answers };
    }

    case "elicitation":
      return {
        action: answer.action,
        content: answer.action === "accept" ? (answer.content ?? null) : null,
        _meta: null,
      };
  }
}

/** The safe answer for each kind, used for explicit declines. */
export function declineFor(request: PendingRequest): unknown {
  switch (request.kind) {
    case "commandApproval":
    case "fileChangeApproval":
      return { decision: "decline" };
    case "permissions":
      return { permissions: {}, scope: "turn" };
    case "userInput": {
      // Every question needs a key, or the tool may block on a missing answer.
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of request.params.questions) answers[q.id] = { answers: [] };
      return { answers };
    }
    case "elicitation":
      return { action: "decline", content: null, _meta: null };
  }
}
