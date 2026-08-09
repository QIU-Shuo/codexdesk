/** Stable approval vocabulary shared by UI, persistence, and application code. */
export const APPROVAL_MODES = ["read-only", "auto", "full-access"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** App-server approval policy, kept behind our contract boundary. */
export type ApprovalPolicy =
  | "untrusted"
  | "on-request"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    }
  | "never";

/** Sandbox value accepted by thread start/resume/fork. */
export type ThreadSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

/** Sandbox value accepted by turn/start. */
export type TurnSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
