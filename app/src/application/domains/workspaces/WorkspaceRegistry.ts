import type {
  WorkspacePlacement,
  WorkspaceRecord,
  WorkspaceRegistryState,
} from "./WorkspacePlacement";
import type { WorkspaceRegistryPort, WorkspaceRootMatcher } from "./ports";

function cloneState(state: WorkspaceRegistryState): WorkspaceRegistryState {
  return {
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      roots: [...workspace.roots],
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    placements: { ...state.placements },
    dismissedRoots: [...state.dismissedRoots],
  };
}

/** Owns workspace registration and conversation placement as one model. */
export class WorkspaceRegistry {
  constructor(
    private readonly port: WorkspaceRegistryPort,
    private readonly matchRoot: WorkspaceRootMatcher,
  ) {}

  snapshot(): WorkspaceRegistryState {
    return cloneState(this.port.read());
  }

  workspace(id: string): WorkspaceRecord | null {
    return this.port.read().workspaces.find((item) => item.id === id) ?? null;
  }

  placement(conversationId: string): WorkspacePlacement | undefined {
    return this.port.read().placements[conversationId];
  }

  navigationRoot(conversationId: string): string | undefined {
    const placement = this.placement(conversationId);
    if (placement?.kind === "registered") return placement.navigationRoot;
    if (placement?.kind === "unregistered") return placement.root;
    return undefined;
  }

  add(record: WorkspaceRecord): WorkspaceRecord {
    const state = this.snapshot();
    const existing = state.workspaces.find((workspace) =>
      workspace.roots.includes(record.selectedRoot),
    );
    if (existing) {
      state.activeWorkspaceId = existing.id;
      state.dismissedRoots = state.dismissedRoots.filter(
        (root) => root !== record.selectedRoot,
      );
      this.port.write(state);
      return existing;
    }
    state.workspaces.push(record);
    state.activeWorkspaceId = record.id;
    state.dismissedRoots = state.dismissedRoots.filter(
      (root) => root !== record.selectedRoot,
    );
    this.port.write(state);
    return record;
  }

  setActive(id: string | null): boolean {
    const state = this.snapshot();
    if (id !== null && !state.workspaces.some((item) => item.id === id)) {
      return false;
    }
    state.activeWorkspaceId = id;
    this.port.write(state);
    return true;
  }

  rename(id: string, label: string): boolean {
    const state = this.snapshot();
    const workspace = state.workspaces.find((item) => item.id === id);
    if (!workspace) return false;
    workspace.label = label;
    this.port.write(state);
    return true;
  }

  selectRoot(id: string, root: string): boolean {
    const state = this.snapshot();
    const workspace = state.workspaces.find((item) => item.id === id);
    if (!workspace || !workspace.roots.includes(root)) return false;
    workspace.selectedRoot = root;
    this.port.write(state);
    return true;
  }

  remove(id: string): WorkspaceRecord | null {
    const state = this.snapshot();
    const removed = state.workspaces.find((item) => item.id === id) ?? null;
    if (!removed) return null;
    state.workspaces = state.workspaces.filter((item) => item.id !== id);
    state.dismissedRoots = [
      ...new Set([...state.dismissedRoots, ...removed.roots]),
    ];
    if (state.activeWorkspaceId === id) state.activeWorkspaceId = null;
    for (const [conversationId, placement] of Object.entries(
      state.placements,
    )) {
      if (placement.kind === "registered" && placement.workspaceId === id) {
        state.placements[conversationId] = {
          kind: "unregistered",
          root: placement.navigationRoot,
        };
      }
    }
    this.port.write(state);
    return removed;
  }

  setPlacement(conversationId: string, placement: WorkspacePlacement): void {
    const state = this.snapshot();
    state.placements[conversationId] = placement;
    this.port.write(state);
  }

  clearPlacement(conversationId: string): void {
    const state = this.snapshot();
    delete state.placements[conversationId];
    this.port.write(state);
  }

  replace(state: WorkspaceRegistryState): void {
    this.port.write(cloneState(state));
  }

  workspaceFor(root: string, placement?: WorkspacePlacement): string | null {
    const state = this.port.read();
    if (placement?.kind === "unassigned") return null;
    if (
      placement?.kind === "registered" &&
      state.workspaces.some((item) => item.id === placement.workspaceId)
    ) {
      return placement.workspaceId;
    }
    const navigationRoot =
      placement?.kind === "registered"
        ? placement.navigationRoot
        : placement?.kind === "unregistered"
          ? placement.root
          : root;
    return this.matchRoot(navigationRoot, state.workspaces);
  }
}
