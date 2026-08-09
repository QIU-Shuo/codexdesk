/** Durable ownership of a conversation's execution root. */
export type WorkspacePlacement =
  | {
      kind: "registered";
      workspaceId: string;
      navigationRoot: string;
    }
  | { kind: "unregistered"; root: string }
  | { kind: "unassigned" };

export type WorkspaceView = {
  id: string;
  name: string;
  roots: string[];
  selectedRoot: string;
  registeredAt: number;
};

export type WorkspaceCatalogView = {
  workspaces: WorkspaceView[];
  activeWorkspaceId: string | null;
};

export type ConversationPlacementView = {
  conversationId: string;
  placement: WorkspacePlacement;
};
