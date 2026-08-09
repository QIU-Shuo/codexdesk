import type { WorkspaceRegistryState } from "./WorkspacePlacement";

export type WorkspaceRegistryPort = {
  read(): WorkspaceRegistryState;
  write(state: WorkspaceRegistryState): void;
};

export type WorkspaceRootMatcher = (
  root: string,
  workspaces: WorkspaceRegistryState["workspaces"],
) => string | null;
