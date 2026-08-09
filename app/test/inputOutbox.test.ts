import { describe, expect, it } from "vitest";
import {
  InputOutbox,
  type OutboxEntry,
} from "../src/application/domains/conversations/InputOutbox";

function entry(id: string, text = id): OutboxEntry {
  return {
    id,
    text,
    createdAt: 1,
    assets: [],
    schedule: "afterTurn",
    lastFailure: null,
  };
}

describe("InputOutbox", () => {
  it("uses the injected capacity", () => {
    const outbox = new InputOutbox({ entries: [] }, { capacity: 2 });
    expect(outbox.enqueue(entry("one"))).toEqual({ ok: true });
    expect(outbox.enqueue(entry("two"))).toEqual({ ok: true });
    expect(outbox.enqueue(entry("three"))).toEqual({
      ok: false,
      reason: "full",
    });
  });

  it("keeps durable entries separate from an in-flight attempt", () => {
    const outbox = new InputOutbox(
      { entries: [entry("one"), entry("two")] },
      { capacity: 8 },
    );
    const attempt = outbox.beginDispatch("turn-1")!;

    expect(attempt).toMatchObject({
      route: "inject",
      expectedTurnId: "turn-1",
    });
    expect(outbox.durableSnapshot().entries).toHaveLength(2);
    expect(outbox.edit("one", "changed while sending")).toBe(false);
    expect(outbox.remove("one")).toBe(false);
    expect(outbox.move("two", 0)).toBe(false);

    outbox.complete(attempt);
    expect(outbox.durableSnapshot().entries.map((item) => item.id)).toEqual([
      "two",
    ]);
  });

  it("retains a stale-turn attempt for dispatch after the turn", () => {
    const outbox = new InputOutbox(
      { entries: [entry("one")] },
      { capacity: 8 },
    );
    const attempt = outbox.beginDispatch("turn-1")!;
    outbox.defer(attempt, "turnEnded");

    expect(outbox.durableSnapshot().entries).toMatchObject([
      { id: "one", schedule: "afterTurn" },
    ]);
    expect(outbox.dispatchState()).toEqual({
      kind: "deferred",
      reason: "turnEnded",
      detail: null,
    });
    expect(outbox.beginDispatch(null)).toMatchObject({ route: "startTurn" });
  });

  it("persists a failure but resets transient dispatch state on restart", () => {
    const outbox = new InputOutbox(
      { entries: [entry("one")] },
      { capacity: 8 },
    );
    const attempt = outbox.beginDispatch(null)!;
    outbox.fail(attempt, {
      message: "transport unavailable",
      retryable: true,
      at: 5,
    });
    const durable = outbox.durableSnapshot();
    expect(durable.entries[0]?.lastFailure).toMatchObject({
      message: "transport unavailable",
    });

    const restarted = new InputOutbox(durable, { capacity: 8 });
    expect(restarted.dispatchState()).toEqual({ kind: "idle" });
    const retry = restarted.beginDispatch(null)!;
    restarted.complete(retry);
    expect(restarted.durableSnapshot().entries).toEqual([]);
  });

  it("edits, removes, and reorders entries while idle", () => {
    const outbox = new InputOutbox(
      { entries: [entry("one"), entry("two"), entry("three")] },
      { capacity: 8 },
    );
    expect(outbox.edit("one", "updated")).toBe(true);
    expect(outbox.move("three", 0)).toBe(true);
    expect(outbox.remove("two")).toBe(true);
    expect(outbox.durableSnapshot().entries).toMatchObject([
      { id: "three" },
      { id: "one", text: "updated" },
    ]);
  });
});
