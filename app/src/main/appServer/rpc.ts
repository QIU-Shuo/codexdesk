/**
 * Bidirectional JSON-RPC 2.0 dispatch (plan §5, step 0.2).
 *
 * The trap this file exists to avoid: this is NOT request/response. The server
 * initiates requests too (approvals, elicitations, attestation), and a client
 * that only models client->server will deadlock the moment the agent runs a
 * command — with no error, which presents as a broken transport (§9.1/§9.2).
 *
 * Four shapes, distinguished by the presence of `id` and `method`:
 *
 *   id + method  -> server->client request  (we MUST reply)
 *   id, no method-> response to our request
 *   method only  -> server->client notification
 *   (outbound)   -> our requests and notifications
 *
 * The wire omits the `"jsonrpc": "2.0"` member (§2.1).
 */

export type JsonRpcId = number | string;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

/** JSON-RPC reserved code for an unrecognized method. */
export const METHOD_NOT_FOUND = -32601;

export type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
};

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type ServerRequestHandler = (
  method: string,
  params: unknown,
  /** The JSON-RPC id. Needed to correlate `serverRequest/resolved`. */
  id: JsonRpcId,
) => Promise<unknown>;

export type NotificationHandler = (method: string, params: unknown) => void;

export class RpcConnection {
  private nextId = 0;
  private pending = new Map<JsonRpcId, Pending>();
  private closed = false;

  constructor(
    private readonly write: (msg: unknown) => void,
    private readonly onServerRequest: ServerRequestHandler,
    private readonly onNotification: NotificationHandler,
  ) {}

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`connection closed (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      });
      this.write({ id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ method, params: params ?? {} });
  }

  /** Route one decoded inbound message. */
  handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    const hasId = "id" in m && m.id !== null && m.id !== undefined;

    if (hasId && typeof m.method === "string") {
      void this.handleServerRequest(m.id as JsonRpcId, m.method, m.params);
      return;
    }

    if (hasId) {
      this.handleResponse(m.id as JsonRpcId, m);
      return;
    }

    if (typeof m.method === "string") {
      this.onNotification(m.method, m.params);
    }
  }

  private handleResponse(id: JsonRpcId, m: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return; // late or duplicate response; nothing to settle
    this.pending.delete(id);

    if (m.error) {
      const e = m.error as JsonRpcError;
      pending.reject(
        new RpcError(
          e.code,
          `${pending.method}: ${e.message ?? "unknown error"}`,
          e.data,
        ),
      );
      return;
    }
    pending.resolve(m.result);
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    // Every path below must write exactly one reply. A server request left
    // unanswered stalls the turn forever (§9.1).
    try {
      const result = await this.onServerRequest(method, params, id);
      this.write({ id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : METHOD_NOT_FOUND;
      this.write({ id, error: { code, message } });
    }
  }

  /**
   * Reject everything still in flight. Called on transport exit so pending
   * promises fail loudly instead of hanging (§5, step 0.8).
   */
  close(reason: string): void {
    this.closed = true;
    const inFlight = [...this.pending.entries()];
    this.pending.clear();
    for (const [, p] of inFlight) {
      p.reject(new Error(`${p.method}: ${reason}`));
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
