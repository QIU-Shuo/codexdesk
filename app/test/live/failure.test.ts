import { describe, expect, it } from "vitest";
import { AppServerClient } from "../../src/main/appServer/client";
import type { AppEvent } from "../../src/shared/ipc";

type RequestFn = (method: string, params: unknown) => Promise<unknown>;

/**
 * Phase 0 step 0.8: a failure the UI does not render is indistinguishable
 * from a hang. Verifies both the RPC-error path and terminal turn status.
 */
describe("failure surfacing", () => {
  // Verified against 0.144.4: `thread/start` does NOT validate `cwd`, and
  // happily returns a thread id for a path that does not exist. Validating
  // the workspace is therefore the client's job (§5, step 0.0) — the server
  // will not do it for us, and the failure would otherwise surface much later
  // as a confusing mid-turn error.
  it("accepts a nonexistent cwd — cwd validation is ours to do", async () => {
    const client = new AppServerClient(() => {});
    await client.connect();
    const thread = await client.startThread({
      cwd: "/nonexistent/path/definitely-not-here",
    });
    expect(thread.id).toBeTruthy();
    client.dispose();
  }, 60000);

  // A bogus model id is the cheapest induced error (plan §10). The failure
  // must reach the UI through one of the three channels in step 0.8 — an RPC
  // error, an `error` notification, or a non-`completed` terminal status —
  // rather than leaving the turn hanging, which is indistinguishable from a
  // broken transport (§9.1).
  it("surfaces an induced failure rather than hanging", async () => {
    const events: AppEvent[] = [];
    const client = new AppServerClient((e) => events.push(e));
    await client.connect();
    const thread = await client.startThread({ cwd: "/tmp/codexdesk-scratch" });
    const threadId = thread.id;

    const rpc = (client as unknown as { rpc: { request: RequestFn } }).rpc;
    const outcome = await rpc
      .request("turn/start", {
        threadId,
        input: [{ type: "text", text: "hi", text_elements: [] }],
        model: "definitely-not-a-real-model-xyz",
      })
      .then(() => "resolved" as const)
      .catch(() => "rejected" as const);

    // If the request itself was accepted, the failure must arrive as an
    // event instead. Wait for a terminal signal rather than a fixed delay.
    let surfaced = outcome === "rejected";
    if (!surfaced) {
      surfaced = await new Promise<boolean>((res) => {
        const deadline = Date.now() + 45000;
        const iv = setInterval(() => {
          const hit = events.some(
            (e) =>
              (e.type === "turnError" && !e.willRetry) ||
              (e.type === "turnCompleted" && e.turn.status !== "completed"),
          );
          if (hit || Date.now() > deadline) {
            clearInterval(iv);
            res(hit);
          }
        }, 250);
      });
    }

    console.log(
      "outcome:",
      outcome,
      "| events:",
      [...new Set(events.map((e) => e.type))].join(","),
    );
    expect(surfaced).toBe(true);
    client.dispose();
  }, 90000);
});
