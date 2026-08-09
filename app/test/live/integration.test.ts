import { describe, expect, it } from "vitest";
import { AppServerClient } from "../../src/main/appServer/client";
import type { AppEvent } from "../../src/shared/ipc";

/**
 * End-to-end against a real `codex app-server`. Requires a signed-in CLI and
 * network, so this asserts on the client's own behavior — item lifecycle,
 * delta assembly, terminal status — rather than on the model's output.
 *
 * Upstream stream disconnects are common and are reported with
 * `willRetry: true`. Those are not our failures, so a turn that ends `failed`
 * only after exhausting retries is tolerated; what must hold is that we
 * observed the full lifecycle and rendered a terminal status either way.
 */
describe("live app-server", () => {
  it("handshakes, starts a thread, streams a turn, renders items", async () => {
    const events: AppEvent[] = [];
    const client = new AppServerClient((e) => events.push(e));

    await client.connect();
    const auth = await client.readAuth();
    const thread = await client.startThread({ cwd: "/tmp/codexdesk-scratch" });
    const threadId = thread.id;
    expect(threadId).toBeTruthy();

    const done = new Promise<void>((res) => {
      const iv = setInterval(() => {
        if (events.some((e) => e.type === "turnCompleted")) {
          clearInterval(iv);
          res();
        }
      }, 200);
    });
    await client.sendMessage(threadId, [
      {
        type: "text",
        text: "Read hello.ts and tell me in one sentence what it does.",
        text_elements: [],
      },
    ]);
    await Promise.race([done, new Promise((r) => setTimeout(r, 90000))]);

    const completed = events.filter((e) => e.type === "itemCompleted");
    const itemTypes = completed.map((e) => e.item.type);
    const turnCompleted = events.find((e) => e.type === "turnCompleted");
    const retried = events.filter(
      (e) => e.type === "turnError" && e.willRetry,
    ).length;

    console.log("auth:", auth.kind);
    console.log("item types:", itemTypes.join(", "));
    console.log("deltas:", events.filter((e) => e.type === "itemDelta").length);
    console.log("turn status:", turnCompleted?.turn.status);
    if (retried) console.log(`upstream retries: ${retried}`);

    // The turn ran its full lifecycle.
    expect(events.some((e) => e.type === "turnStarted")).toBe(true);
    expect(turnCompleted).toBeDefined();

    // Our own input came back as an item, and the agent produced output.
    expect(itemTypes).toContain("userMessage");

    if (turnCompleted?.turn.status === "completed") {
      expect(itemTypes).toContain("agentMessage");
      // Text arrived incrementally rather than only at the item boundary.
      expect(events.some((e) => e.type === "itemDelta")).toBe(true);
    } else {
      // Anything non-`completed` must be accompanied by a rendered reason —
      // a failure the UI cannot explain is the §9.1 failure mode (step 0.8).
      const explained =
        turnCompleted?.turn.error != null ||
        events.some((e) => e.type === "turnError");
      expect(explained).toBe(true);
    }

    client.dispose();
  }, 120000);
});
