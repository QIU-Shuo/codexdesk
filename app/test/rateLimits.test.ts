import { describe, expect, it } from "vitest";
import { mergeRateLimits } from "../src/main/appServer/client";
import type { RateLimitSnapshot } from "../src/protocol/generated/v2/RateLimitSnapshot";

const full: RateLimitSnapshot = {
  limitId: "codex",
  limitName: "Codex",
  primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1000 },
  secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000 },
  credits: { hasCredits: true, unlimited: false, balance: "5.00" },
  individualLimit: null,
  planType: null,
  rateLimitReachedType: null,
};

describe("mergeRateLimits", () => {
  it("uses the update wholesale when there is no prior snapshot", () => {
    expect(mergeRateLimits(null, full)).toEqual(full);
  });

  it("overwrites values the update actually carries", () => {
    const merged = mergeRateLimits(full, {
      ...full,
      primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1000 },
    });
    expect(merged.primary?.usedPercent).toBe(90);
  });

  it("does not let a null clear a previously observed value", () => {
    // The update is explicitly sparse: null means "unavailable in this
    // update", not "cleared". Treating it as a clear makes the limit warning
    // flicker on and off (plan §5, step 2.4).
    const sparse = {
      ...full,
      secondary: null,
      credits: null,
      limitName: null,
    } as RateLimitSnapshot;

    const merged = mergeRateLimits(full, sparse);
    expect(merged.secondary).toEqual(full.secondary);
    expect(merged.credits).toEqual(full.credits);
    expect(merged.limitName).toBe("Codex");
  });

  it("keeps a reached-limit flag that a later sparse update omits", () => {
    // The old `as RateLimitSnapshot` cast hid that "primary" is not a member
    // of RateLimitReachedType at all — the test was asserting against a value
    // the protocol never produces.
    const reached: RateLimitSnapshot = {
      ...full,
      rateLimitReachedType: "rate_limit_reached",
    };
    const merged = mergeRateLimits(reached, full);
    expect(merged.rateLimitReachedType).toBe("rate_limit_reached");
  });
});
