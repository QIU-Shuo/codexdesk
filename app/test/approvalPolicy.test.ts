import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  effectiveApprovalMode,
  isApprovalMode,
  permittedApprovalModes,
  threadParamsFor,
  turnParamsFor,
} from "../src/application/domains/approvals/policy";

/**
 * Approval postures.
 *
 * CodexDesk does not decide when an approval is required — codex core does, from
 * the approval policy and sandbox this module produces. So the invariants
 * worth testing are the mapping itself, the fact that the two param shapes
 * (thread config vs. per-turn) agree, and that operator policy is honored.
 */

describe("mode mapping", () => {
  it("maps each mode to its approval policy and sandbox", () => {
    expect(threadParamsFor("read-only")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(threadParamsFor("auto")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(threadParamsFor("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("defaults to the posture the app shipped with before modes existed", () => {
    // `auto` is exactly the old hardcoded pair, so an existing install sees
    // no behavior change on upgrade.
    expect(threadParamsFor(DEFAULT_APPROVAL_MODE)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("only full access turns approvals off", () => {
    const never = APPROVAL_MODES.filter(
      (mode) => threadParamsFor(mode).approvalPolicy === "never",
    );
    expect(never).toEqual(["full-access"]);
  });
});

describe("turn params", () => {
  /**
   * `turn/start` takes a structured `SandboxPolicy` while `thread/start`
   * takes a mode string, so the same posture is expressed twice. These pin
   * the two together — a drift here would mean a thread silently ran under a
   * different posture than the one it was started with.
   */
  it("agrees with the thread shape on the approval policy", () => {
    for (const mode of APPROVAL_MODES) {
      expect(turnParamsFor(mode, ["/repo"]).approvalPolicy).toBe(
        threadParamsFor(mode).approvalPolicy,
      );
    }
  });

  it("scopes writable roots to the thread's own root", () => {
    expect(turnParamsFor("auto", ["/repo/.worktrees/a"]).sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/.worktrees/a"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("grants no writable roots in read only", () => {
    expect(turnParamsFor("read-only", ["/repo"]).sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
  });

  it("drops the sandbox entirely in full access", () => {
    expect(turnParamsFor("full-access", ["/repo"]).sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });
});

describe("isApprovalMode", () => {
  it("accepts the known modes and rejects anything else", () => {
    expect(isApprovalMode("read-only")).toBe(true);
    expect(isApprovalMode("full-access")).toBe(true);
    // The IPC handler validates with this before widening what the agent may
    // do without asking, so a near miss must not pass.
    expect(isApprovalMode("full_access")).toBe(false);
    expect(isApprovalMode(null)).toBe(false);
    expect(isApprovalMode({ granular: {} })).toBe(false);
  });
});

describe("permittedApprovalModes", () => {
  it("offers everything when the operator sets no policy", () => {
    expect(permittedApprovalModes(null, null)).toEqual([...APPROVAL_MODES]);
    // An empty list is "unset", not "nothing allowed".
    expect(permittedApprovalModes([], [])).toEqual([...APPROVAL_MODES]);
  });

  it("withholds a mode whose sandbox the operator forbids", () => {
    expect(
      permittedApprovalModes(null, ["read-only", "workspace-write"]),
    ).toEqual(["read-only", "auto"]);
  });

  it("withholds a mode whose approval policy the operator forbids", () => {
    // Forbidding `never` is how an admin says "always ask".
    expect(permittedApprovalModes(["on-request"], null)).toEqual([
      "read-only",
      "auto",
    ]);
  });

  it("requires both halves of the pair to be permitted", () => {
    expect(permittedApprovalModes(["never"], ["read-only"])).toEqual([
      "read-only",
    ]);
  });

  it("falls back to the most restrictive mode rather than offering none", () => {
    // A policy matching none of our presets would otherwise leave the user
    // with an empty picker and no way to run anything.
    expect(permittedApprovalModes(["untrusted"], ["read-only"])).toEqual([
      "read-only",
    ]);
  });

  it("ignores the granular object variant", () => {
    expect(
      permittedApprovalModes(
        [
          {
            granular: {
              sandbox_approval: true,
              rules: true,
              skill_approval: true,
              request_permissions: true,
              mcp_elicitations: true,
            },
          },
        ],
        null,
      ),
    ).toEqual(["read-only"]);
  });
});

describe("effectiveApprovalMode", () => {
  it("keeps the saved mode when policy still permits it", () => {
    expect(effectiveApprovalMode("full-access", [...APPROVAL_MODES])).toBe(
      "full-access",
    );
  });

  it("narrows a saved mode an operator has since forbidden", () => {
    // The saved value outlives the policy that allowed it, so a thread saved
    // as full-access must not keep running that way after an admin change.
    expect(effectiveApprovalMode("full-access", ["read-only", "auto"])).toBe(
      "read-only",
    );
  });
});
