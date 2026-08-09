export type OutboxAsset = {
  id: string;
  kind: "image" | "file";
  name: string;
  path: string;
  preview?: string;
};

export type OutboxFailure = {
  message: string;
  retryable: boolean;
  at: number;
};

export type OutboxEntry = {
  id: string;
  text: string;
  createdAt: number;
  assets: OutboxAsset[];
  schedule: "afterTurn" | "now";
  lastFailure: OutboxFailure | null;
};

export type InputOutboxState = {
  entries: OutboxEntry[];
};

export type OutboxPolicy = {
  capacity: number;
};

export type DispatchState =
  | { kind: "idle" }
  | { kind: "sending"; entryId: string; expectedTurnId: string | null }
  | {
      kind: "deferred";
      reason: "turnEnded" | "turnNotSteerable";
      detail: string | null;
    }
  | { kind: "failed"; entryId: string; message: string; retryable: boolean };

export type DispatchAttempt = {
  token: number;
  entry: OutboxEntry;
  route: "inject" | "startTurn";
  expectedTurnId: string | null;
};

function cloneEntry(entry: OutboxEntry): OutboxEntry {
  return {
    ...entry,
    assets: entry.assets.map((asset) => ({ ...asset })),
    lastFailure: entry.lastFailure ? { ...entry.lastFailure } : null,
  };
}

/** Durable entries plus a separate, non-persisted dispatch attempt. */
export class InputOutbox {
  private entries: OutboxEntry[];
  private dispatch: DispatchState = { kind: "idle" };
  private attemptSequence = 0;
  private activeAttempt: DispatchAttempt | null = null;

  constructor(
    initial: InputOutboxState,
    readonly policy: OutboxPolicy,
  ) {
    if (!Number.isInteger(policy.capacity) || policy.capacity < 1) {
      throw new Error("Outbox capacity must be a positive integer.");
    }
    this.entries = initial.entries.slice(0, policy.capacity).map(cloneEntry);
  }

  durableSnapshot(): InputOutboxState {
    return { entries: this.entries.map(cloneEntry) };
  }

  dispatchState(): DispatchState {
    return { ...this.dispatch };
  }

  enqueue(entry: OutboxEntry): { ok: true } | { ok: false; reason: "full" } {
    if (this.entries.length >= this.policy.capacity) {
      return { ok: false, reason: "full" };
    }
    this.entries.push(cloneEntry(entry));
    return { ok: true };
  }

  edit(id: string, text: string): boolean {
    if (this.activeAttempt) return false;
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    entry.text = text;
    entry.lastFailure = null;
    return true;
  }

  remove(id: string): boolean {
    if (this.activeAttempt) return false;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    return this.entries.length !== before;
  }

  move(id: string, toIndex: number): boolean {
    if (this.activeAttempt) return false;
    const from = this.entries.findIndex((entry) => entry.id === id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(this.entries.length - 1, toIndex));
    if (from === to) return false;
    const [entry] = this.entries.splice(from, 1);
    this.entries.splice(to, 0, entry!);
    return true;
  }

  scheduleNow(): boolean {
    if (this.activeAttempt || !this.entries[0]) return false;
    this.entries[0].schedule = "now";
    return true;
  }

  beginDispatch(expectedTurnId: string | null): DispatchAttempt | null {
    if (this.activeAttempt) return null;
    const entry = this.entries[0];
    if (!entry) return null;
    const attempt: DispatchAttempt = {
      token: ++this.attemptSequence,
      entry: cloneEntry(entry),
      route: expectedTurnId ? "inject" : "startTurn",
      expectedTurnId,
    };
    this.activeAttempt = attempt;
    this.dispatch = {
      kind: "sending",
      entryId: entry.id,
      expectedTurnId,
    };
    return attempt;
  }

  complete(attempt: DispatchAttempt): boolean {
    if (this.activeAttempt?.token !== attempt.token) return false;
    this.entries = this.entries.filter(
      (entry) => entry.id !== attempt.entry.id,
    );
    this.activeAttempt = null;
    this.dispatch = { kind: "idle" };
    return true;
  }

  defer(
    attempt: DispatchAttempt,
    reason: "turnEnded" | "turnNotSteerable",
    detail: string | null = null,
  ): boolean {
    if (this.activeAttempt?.token !== attempt.token) return false;
    const entry = this.entries.find((item) => item.id === attempt.entry.id);
    if (entry) entry.schedule = "afterTurn";
    this.activeAttempt = null;
    this.dispatch = { kind: "deferred", reason, detail };
    return true;
  }

  fail(attempt: DispatchAttempt, failure: OutboxFailure): boolean {
    if (this.activeAttempt?.token !== attempt.token) return false;
    const entry = this.entries.find((item) => item.id === attempt.entry.id);
    if (entry) entry.lastFailure = { ...failure };
    this.activeAttempt = null;
    this.dispatch = {
      kind: "failed",
      entryId: attempt.entry.id,
      message: failure.message,
      retryable: failure.retryable,
    };
    return true;
  }
}
