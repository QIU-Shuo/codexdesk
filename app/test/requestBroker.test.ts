import { describe, expect, it, vi } from "vitest";
import {
  RequestBroker,
  declineFor,
  toWireResponse,
} from "../src/main/appServer/requestBroker";
import type { PendingRequest } from "../src/shared/ipc";

function makeBroker() {
  const pending: PendingRequest[] = [];
  const resolved: (string | number)[] = [];
  const logs: string[] = [];
  const broker = new RequestBroker({
    onPending: (r) => pending.push(r),
    onResolved: (_threadId, id) => resolved.push(id),
    log: (m) => logs.push(m),
  });
  return { broker, pending, resolved, logs };
}

const cmdParams = {
  threadId: "t1",
  turnId: "u1",
  itemId: "i1",
  startedAtMs: 0,
  environmentId: null,
  command: "rm -rf build",
};

describe("RequestBroker", () => {
  it("holds a request open until answered, then resolves with the wire shape", async () => {
    const { broker, pending } = makeBroker();
    const p = broker.handle(
      "item/commandExecution/requestApproval",
      cmdParams,
      1,
    );

    // Still pending — this is the state that keeps a turn alive.
    expect(pending).toHaveLength(1);
    expect(broker.pending).toHaveLength(1);

    broker.answer(pending[0]!.requestId, {
      kind: "commandApproval",
      decision: "accept",
    });

    await expect(p).resolves.toEqual({ decision: "accept" });
    expect(broker.pending).toHaveLength(0);
  });

  it("rejects — never hangs — on a request kind it does not render", async () => {
    const { broker, logs } = makeBroker();
    await expect(broker.handle("some/futureRequest", {}, 1)).rejects.toThrow(
      /unhandled request/,
    );
    expect(logs.join()).toMatch(/refused/);
  });

  it("clears pending requests without replying when the server resolves them", async () => {
    const { broker, pending, resolved } = makeBroker();
    const p = broker.handle("item/commandExecution/requestApproval", cmdParams, 5);
    const settled = vi.fn();
    void p.then(settled, settled);

    broker.clearAll("turn interrupted");

    expect(resolved).toEqual([pending[0]!.requestId]);
    expect(broker.pending).toHaveLength(0);
    // The id is already dead server-side; replying to it would be a protocol
    // error, so the promise is intentionally left unsettled.
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it("ignores an answer for an already-cleared request", async () => {
    const { broker, pending } = makeBroker();
    void broker.handle("item/commandExecution/requestApproval", cmdParams, 7);
    const id = pending[0]!.requestId;
    broker.clearAll("cleared");
    expect(() =>
      broker.answer(id, { kind: "commandApproval", decision: "accept" }),
    ).not.toThrow();
  });

  it("keys requests by the JSON-RPC id the server sent", () => {
    const { broker, pending } = makeBroker();
    void broker.handle("item/commandExecution/requestApproval", cmdParams, 11);
    void broker.handle("item/fileChange/requestApproval", cmdParams, 12);
    expect(pending.map((p) => p.requestId)).toEqual([11, 12]);
    expect(broker.pending).toHaveLength(2);
  });

  it("clears only the request the server resolved", async () => {
    // Phase 1 cleared every pending request on any resolution. Harmless with
    // one thread; wrong the moment two threads have approvals open at once.
    const { broker, resolved } = makeBroker();
    void broker.handle("item/commandExecution/requestApproval", { ...cmdParams, threadId: "a" }, 1);
    void broker.handle("item/commandExecution/requestApproval", { ...cmdParams, threadId: "b" }, 2);

    broker.clearOne(1);

    expect(resolved).toEqual([1]);
    expect(broker.pending.map((p) => p.requestId)).toEqual([2]);
  });

  it("clears only the requests belonging to one thread", () => {
    const { broker } = makeBroker();
    void broker.handle("item/commandExecution/requestApproval", { ...cmdParams, threadId: "a" }, 1);
    void broker.handle("item/commandExecution/requestApproval", { ...cmdParams, threadId: "b" }, 2);
    void broker.handle("item/fileChange/requestApproval", { ...cmdParams, threadId: "a" }, 3);

    broker.clearThread("a", "interrupted");

    expect(broker.pending.map((p) => p.requestId)).toEqual([2]);
  });

  it("tracks which thread each request belongs to", () => {
    const { broker, pending } = makeBroker();
    void broker.handle("item/commandExecution/requestApproval", { ...cmdParams, threadId: "t9" }, 1);
    expect(pending[0]!.threadId).toBe("t9");
    expect(broker.pendingFor("t9")).toHaveLength(1);
    expect(broker.pendingFor("other")).toHaveLength(0);
  });
});

describe("toWireResponse", () => {
  const base = { requestId: "r1", receivedAtMs: 0, threadId: "t1" };

  it("sends structured command decisions as objects, not strings", () => {
    const req = {
      ...base,
      kind: "commandApproval",
      params: cmdParams,
    } as PendingRequest;
    const out = toWireResponse(req, {
      kind: "commandApproval",
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] },
      },
    });
    expect(out).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] },
      },
    });
  });

  it("maps question answers to a map keyed by question id", () => {
    const req = {
      ...base,
      kind: "userInput",
      params: {
        threadId: "t",
        turnId: "u",
        itemId: "i",
        autoResolutionMs: null,
        questions: [
          { id: "q1", header: "h", question: "?", isOther: false, isSecret: false, options: null },
        ],
      },
    } as PendingRequest;

    // Not an array — the Phase 0 stub returned `{ answers: [] }`, which is
    // the wrong shape for ToolRequestUserInputResponse.
    expect(toWireResponse(req, { kind: "userInput", answers: { q1: ["yes"] } })).toEqual(
      { answers: { q1: { answers: ["yes"] } } },
    );
  });

  it("expresses a permission refusal as an empty grant", () => {
    const req = {
      ...base,
      kind: "permissions",
      params: {
        threadId: "t",
        turnId: "u",
        itemId: "i",
        environmentId: null,
        startedAtMs: 0,
        cwd: "/tmp",
        reason: null,
        permissions: { network: null, fileSystem: null },
      },
    } as PendingRequest;

    expect(
      toWireResponse(req, { kind: "permissions", granted: null, scope: "turn" }),
    ).toEqual({ permissions: {}, scope: "turn" });
  });

  it("only sends elicitation content when accepting", () => {
    const req = {
      ...base,
      kind: "elicitation",
      params: { threadId: "t", turnId: null, serverName: "s", mode: "form" },
    } as unknown as PendingRequest;

    expect(
      toWireResponse(req, { kind: "elicitation", action: "decline", content: { a: 1 } }),
    ).toEqual({ action: "decline", content: null, _meta: null });
  });
});

describe("declineFor", () => {
  it("answers every question so the tool is not left waiting on a key", () => {
    const req = {
      requestId: "r",
      receivedAtMs: 0,
      threadId: "t1",
      kind: "userInput",
      params: {
        threadId: "t",
        turnId: "u",
        itemId: "i",
        autoResolutionMs: null,
        questions: [
          { id: "a", header: "", question: "", isOther: false, isSecret: false, options: null },
          { id: "b", header: "", question: "", isOther: false, isSecret: false, options: null },
        ],
      },
    } as PendingRequest;

    expect(declineFor(req)).toEqual({
      answers: { a: { answers: [] }, b: { answers: [] } },
    });
  });
});
