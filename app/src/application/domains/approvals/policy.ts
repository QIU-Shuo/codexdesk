import {
  APPROVAL_MODES,
  type ApprovalMode,
  type ApprovalPolicy,
  type ThreadSandboxMode,
  type TurnSandboxPolicy,
} from "../../../contracts/approvals";

export { APPROVAL_MODES } from "../../../contracts/approvals";
export type { ApprovalMode } from "../../../contracts/approvals";

/**
 * The three approval postures, mirroring Codex's own built-in presets
 * (`codex-rs/utils/approval-presets`). CodexDesk does not decide *when* an approval
 * is required — codex core does, from the approval policy and sandbox below.
 * All this module owns is the mapping from a user-facing mode to those two.
 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === "string" &&
    APPROVAL_MODES.some((candidate) => candidate === value)
  );
}

/** The `approvalPolicy` / `sandbox` pair each mode stands for. */
const MODE_POLICY: Record<
  ApprovalMode,
  { approvalPolicy: ApprovalPolicy; sandbox: ThreadSandboxMode }
> = {
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
};

/**
 * `thread/start`, `thread/resume` and `thread/fork` take the sandbox as a
 * plain `SandboxMode` string.
 */
export function threadParamsFor(mode: ApprovalMode): {
  approvalPolicy: ApprovalPolicy;
  sandbox: ThreadSandboxMode;
} {
  return { ...MODE_POLICY[mode] };
}

/**
 * `turn/start` takes a structured `SandboxPolicy` rather than the mode string,
 * so the same posture has to be expressed twice. Both derivations live here
 * precisely so the two paths cannot drift into different postures.
 *
 * `writableRoots` is the thread's effective root — its worktree when it has
 * one, otherwise its cwd.
 */
export function turnParamsFor(
  mode: ApprovalMode,
  writableRoots: string[],
): { approvalPolicy: ApprovalPolicy; sandboxPolicy: TurnSandboxPolicy } {
  const { approvalPolicy } = MODE_POLICY[mode];
  return { approvalPolicy, sandboxPolicy: sandboxPolicyFor(mode, writableRoots) };
}

function sandboxPolicyFor(
  mode: ApprovalMode,
  writableRoots: string[],
): TurnSandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "full-access":
      return { type: "dangerFullAccess" };
    case "auto":
      return {
        type: "workspaceWrite",
        writableRoots,
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

/**
 * Narrow the offered modes to what the operator permits.
 *
 * `allowedApprovalPolicies` and `allowedSandboxModes` come from
 * `configRequirements/read`. Null or empty means unconstrained; a list means a
 * mode is only offered when *both* halves of its pair are permitted. Offering
 * a mode outside that presents a control an admin has disabled.
 */
export function permittedApprovalModes(
  allowedPolicies: ApprovalPolicy[] | null,
  allowedSandboxes: ThreadSandboxMode[] | null,
): ApprovalMode[] {
  const policies = allowedPolicies?.length ? allowedPolicies : null;
  const sandboxes = allowedSandboxes?.length ? allowedSandboxes : null;
  if (!policies && !sandboxes) return [...APPROVAL_MODES];

  const permitted = APPROVAL_MODES.filter((mode) => {
    const { approvalPolicy, sandbox } = MODE_POLICY[mode];
    // `granular` is an object variant; only the string variants can match a
    // mode of ours, so a plain `includes` is the right comparison.
    const policyOk = !policies || policies.includes(approvalPolicy);
    const sandboxOk = !sandboxes || sandboxes.includes(sandbox);
    return policyOk && sandboxOk;
  });

  // An operator policy that permits none of our modes would otherwise leave
  // the user with no control at all; fall back to the most restrictive one.
  return permitted.length > 0 ? permitted : ["read-only"];
}

/** The saved mode, or the closest permitted one when policy excludes it. */
export function effectiveApprovalMode(
  mode: ApprovalMode,
  permitted: ApprovalMode[],
): ApprovalMode {
  return permitted.includes(mode) ? mode : (permitted[0] ?? "read-only");
}
