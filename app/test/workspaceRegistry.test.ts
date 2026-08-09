import { describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "../src/application/domains/workspaces/WorkspaceRegistry";
import type { WorkspaceRegistryState } from "../src/application/domains/workspaces/WorkspacePlacement";

function ownerFor(root: string, state: WorkspaceRegistryState): string | null {
  return (
    state.workspaces
      .flatMap((workspace) =>
        workspace.roots.map((candidate) => ({
          id: workspace.id,
          root: candidate.replace(/\/$/, ""),
        })),
      )
      .filter(
        (candidate) =>
          root === candidate.root || root.startsWith(`${candidate.root}/`),
      )
      .sort((a, b) => b.root.length - a.root.length)[0]?.id ?? null
  );
}

function harness() {
  let state: WorkspaceRegistryState = {
    workspaces: [],
    activeWorkspaceId: null,
    placements: {},
    dismissedRoots: [],
  };
  const registry = new WorkspaceRegistry(
    {
      read: () => state,
      write: (next) => {
        state = next;
      },
    },
    (root, workspaces) => ownerFor(root, { ...state, workspaces }),
  );
  return { registry, state: () => state };
}

describe("WorkspaceRegistry", () => {
  it("distinguishes registered, unregistered, and unassigned placement", () => {
    const { registry } = harness();
    registry.add({
      id: "parent",
      label: "Parent",
      roots: ["/repo"],
      selectedRoot: "/repo",
      registeredAt: 1,
    });
    registry.add({
      id: "nested",
      label: "Nested",
      roots: ["/repo/packages/app"],
      selectedRoot: "/repo/packages/app",
      registeredAt: 2,
    });

    registry.setPlacement("owned", {
      kind: "registered",
      workspaceId: "parent",
      navigationRoot: "/repo/packages/app",
    });
    registry.setPlacement("outside", {
      kind: "unregistered",
      root: "/outside",
    });
    registry.setPlacement("none", { kind: "unassigned" });

    expect(
      registry.workspaceFor("/repo/packages/app", registry.placement("owned")),
    ).toBe("parent");
    expect(
      registry.workspaceFor("/outside", registry.placement("outside")),
    ).toBeNull();
    expect(
      registry.workspaceFor("/repo", registry.placement("none")),
    ).toBeNull();
    expect(registry.workspaceFor("/repo/packages/app/src")).toBe("nested");
  });

  it("preserves a removed workspace root without retaining its ownership", () => {
    const { registry, state } = harness();
    registry.add({
      id: "repo",
      label: "Repo",
      roots: ["/repo"],
      selectedRoot: "/repo",
      registeredAt: 1,
    });
    registry.setPlacement("conversation", {
      kind: "registered",
      workspaceId: "repo",
      navigationRoot: "/repo",
    });

    registry.remove("repo");

    expect(registry.placement("conversation")).toEqual({
      kind: "unregistered",
      root: "/repo",
    });
    expect(state().dismissedRoots).toEqual(["/repo"]);
    expect(state().activeWorkspaceId).toBeNull();
  });
});
