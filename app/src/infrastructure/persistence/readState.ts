import { emptyPersistedState, type PersistedState } from "./stateSchema";
import { readLegacyV2 } from "./legacyV2Reader";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPersistedState(raw: unknown): PersistedState {
  if (!isRecord(raw) || raw.version !== 3 || !isRecord(raw.workspaceRegistry)) {
    return readLegacyV2(isRecord(raw) ? raw : {});
  }

  const empty = emptyPersistedState();
  const registry =
    raw.workspaceRegistry as unknown as PersistedState["workspaceRegistry"];
  return {
    ...empty,
    ...(raw as Partial<PersistedState>),
    version: 3,
    threads: (raw.threads as PersistedState["threads"] | undefined) ?? {},
    pinnedOrder:
      (raw.pinnedOrder as PersistedState["pinnedOrder"] | undefined) ?? [],
    recents: (raw.recents as PersistedState["recents"] | undefined) ?? [],
    workspaceRegistry: {
      workspaces: registry.workspaces ?? [],
      activeWorkspaceId: registry.activeWorkspaceId ?? null,
      placements: registry.placements ?? {},
      dismissedRoots: registry.dismissedRoots ?? [],
    },
  };
}
