export type WorkspaceRecord = {
  id: string;
  label: string;
  roots: string[];
  selectedRoot: string;
  registeredAt: number;
};

/**
 * Navigation ownership is durable; a conversation's live working directory
 * remains part of conversation state. `navigationRoot` records the source
 * root used to place an isolated checkout without conflating the two.
 */
export type WorkspacePlacement =
  | {
      kind: "registered";
      workspaceId: string;
      navigationRoot: string;
    }
  | { kind: "unregistered"; root: string }
  | { kind: "unassigned" };

export type WorkspaceRegistryState = {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  placements: Record<string, WorkspacePlacement>;
  dismissedRoots: string[];
};
