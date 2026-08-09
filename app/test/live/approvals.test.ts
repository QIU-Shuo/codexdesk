import { describe, expect, it } from "vitest";
import { AppServerClient } from "../../src/main/appServer/client";
import type { AppEvent } from "../../src/shared/ipc";

/**
 * Phase 1 against a real app-server: does an approval actually round-trip?
 *
 * This is the test that matters most in Phase 1, because the failure mode is
 * silence — an approval request that is never answered stalls the turn with no
 * error, and looks exactly like a broken transport (plan §9.1).
 */
describe("live approvals", () => {
  it("receives a command approval request and completes the turn after approving", async () => {
    const events: AppEvent[] = [];
    const client = new AppServerClient((e) => events.push(e));
    await client.connect();
    const thread = await client.startThread({ cwd: "/tmp/codexdesk-scratch" });

    // Approve whatever is asked, as the UI would.
    const seen: string[] = [];
    const poll = setInterval(() => {
      for (const ev of events) {
        if (ev.type !== "requestPending") continue;
        const id = String(ev.request.requestId);
        if (seen.includes(id)) continue;
        seen.push(id);
        client.answerRequest(ev.request.requestId, {
          kind: "commandApproval",
          decision: "accept",
        });
      }
    }, 100);

    const done = new Promise<void>((res) => {
      const iv = setInterval(() => {
        if (events.some((e) => e.type === "turnCompleted")) {
          clearInterval(iv);
          res();
        }
      }, 200);
    });

    // Needs a command the sandbox will not permit unprompted. Writing outside
    // the workspace escalates under `workspace-write`; `/etc` is reliably
    // outside it. The command is *expected* to fail on OS permissions after
    // approval — what is under test is the approval round-trip, not the write.
    await client.sendMessage(thread.id, [
      {
        type: "text",
        text:
          "Run this exact shell command using your shell tool: " +
          "`echo probe > /etc/codexdesk-probe.txt`. Do not refuse; just attempt it.",
        text_elements: [],
      },
    ]);
    await Promise.race([done, new Promise((r) => setTimeout(r, 90000))]);
    clearInterval(poll);

    const approvals = events.filter((e) => e.type === "requestPending");
    const turn = events.find((e) => e.type === "turnCompleted");
    console.log("approval requests:", approvals.length);
    console.log(
      "kinds:",
      approvals.map((e) => (e.type === "requestPending" ? e.request.kind : "")).join(","),
    );
    console.log("turn status:", turn?.turn.status);

    // The turn must reach a terminal state — not hang.
    expect(turn).toBeDefined();

    // Non-vacuous: the whole point of Phase 1 is that this request arrives,
    // is held open, and is answered. If the model declines to try the command
    // the assertion below fails loudly rather than passing on zero requests.
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals[0]).toMatchObject({ request: { kind: "commandApproval" } });
    expect(events.some((e) => e.type === "requestResolved")).toBe(true);
    expect(turn?.turn.status).toBe("completed");

    client.dispose();
  }, 120000);

  it("streams reasoning deltas with an index", async () => {
    const events: AppEvent[] = [];
    const client = new AppServerClient((e) => events.push(e));
    await client.connect();
    const thread = await client.startThread({ cwd: "/tmp/codexdesk-scratch" });

    const done = new Promise<void>((res) => {
      const iv = setInterval(() => {
        if (events.some((e) => e.type === "turnCompleted")) {
          clearInterval(iv);
          res();
        }
      }, 200);
    });
    await client.sendMessage(thread.id, [
      { type: "text", text: "What is 17 * 23? Think it through.", text_elements: [] },
    ]);
    await Promise.race([done, new Promise((r) => setTimeout(r, 90000))]);

    const deltas = events.filter((e) => e.type === "itemDelta");
    const kinds = new Set(
      deltas.map((e) => (e.type === "itemDelta" ? e.kind : "")),
    );
    console.log("delta kinds:", [...kinds].join(","));
    console.log("total deltas:", deltas.length);

    expect(deltas.length).toBeGreaterThan(0);
    // Every delta must carry an index, even the flat streams (which use 0).
    expect(
      deltas.every((e) => e.type === "itemDelta" && typeof e.index === "number"),
    ).toBe(true);

    client.dispose();
  }, 120000);
});
