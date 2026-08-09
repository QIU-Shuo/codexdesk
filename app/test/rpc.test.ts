import { describe, expect, it, vi } from "vitest";
import { RpcConnection, RpcError, METHOD_NOT_FOUND } from "../src/main/appServer/rpc";
import { StdioTransport } from "../src/main/appServer/transport";

function makeConn(opts?: {
  onServerRequest?: (m: string, p: unknown) => Promise<unknown>;
  onNotification?: (m: string, p: unknown) => void;
}) {
  const sent: any[] = [];
  const conn = new RpcConnection(
    (msg) => sent.push(msg),
    opts?.onServerRequest ?? (async () => ({})),
    opts?.onNotification ?? (() => {}),
  );
  return { conn, sent };
}

describe("RpcConnection", () => {
  it("correlates responses to requests by id", async () => {
    const { conn, sent } = makeConn();
    const a = conn.request("thread/start");
    const b = conn.request("account/read");
    expect(sent.map((m) => m.id)).toEqual([0, 1]);

    // Answer out of order — correlation must be by id, not arrival order.
    conn.handleMessage({ id: 1, result: { account: null } });
    conn.handleMessage({ id: 0, result: { thread: { id: "t1" } } });

    await expect(b).resolves.toEqual({ account: null });
    await expect(a).resolves.toEqual({ thread: { id: "t1" } });
    expect(conn.pendingCount).toBe(0);
  });

  it("rejects with RpcError on an error response", async () => {
    const { conn } = makeConn();
    const p = conn.request("thread/start");
    conn.handleMessage({ id: 0, error: { code: -32602, message: "bad cwd" } });
    await expect(p).rejects.toThrow(/thread\/start: bad cwd/);
    await expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it("replies to server->client requests", async () => {
    const { conn, sent } = makeConn({
      onServerRequest: async () => ({ decision: "decline" }),
    });
    conn.handleMessage({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ id: 7, result: { decision: "decline" } });
  });

  it("replies with an error rather than hanging on an unknown request", async () => {
    const { conn, sent } = makeConn({
      onServerRequest: async () => {
        throw new RpcError(METHOD_NOT_FOUND, "unhandled");
      },
    });
    conn.handleMessage({ id: 3, method: "some/futureMethod", params: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].id).toBe(3);
    expect(sent[0].error.code).toBe(METHOD_NOT_FOUND);
  });

  it("routes notifications without an id, including bare `error`", () => {
    const seen: string[] = [];
    const { conn, sent } = makeConn({
      onNotification: (m) => seen.push(m),
    });
    conn.handleMessage({ method: "turn/started", params: {} });
    conn.handleMessage({ method: "error", params: { willRetry: false } });
    expect(seen).toEqual(["turn/started", "error"]);
    expect(sent).toHaveLength(0); // notifications are never answered
  });

  it("ignores a response with no matching pending request", () => {
    const { conn } = makeConn();
    expect(() => conn.handleMessage({ id: 99, result: {} })).not.toThrow();
  });

  it("rejects everything in flight on close", async () => {
    const { conn } = makeConn();
    const p = conn.request("turn/start");
    conn.close("app-server exited");
    await expect(p).rejects.toThrow(/turn\/start: app-server exited/);
    expect(conn.pendingCount).toBe(0);
  });
});

describe("StdioTransport line buffering", () => {
  it("reassembles messages split across chunk boundaries", () => {
    const t = new StdioTransport();
    const got: unknown[] = [];
    t.on("message", (m) => got.push(m));

    t.onStdout('{"id":0,"resu');
    expect(got).toHaveLength(0); // partial line must not parse
    t.onStdout('lt":{"ok":true}}\n{"method":"turn/started"}\n');

    expect(got).toEqual([
      { id: 0, result: { ok: true } },
      { method: "turn/started" },
    ]);
  });

  it("handles several messages in one chunk and skips blank lines", () => {
    const t = new StdioTransport();
    const got: unknown[] = [];
    t.on("message", (m) => got.push(m));
    t.onStdout('{"a":1}\n\n{"b":2}\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reports a malformed line without dropping later messages", () => {
    const t = new StdioTransport();
    const got: unknown[] = [];
    const errs: string[] = [];
    t.on("message", (m) => got.push(m));
    t.on("stderr", (l) => errs.push(l));
    t.onStdout('not json\n{"ok":1}\n');
    expect(errs[0]).toMatch(/unparseable/);
    expect(got).toEqual([{ ok: 1 }]);
  });
});
