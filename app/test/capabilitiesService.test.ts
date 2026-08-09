import { describe, expect, it } from "vitest";
import { CapabilitiesService } from "../src/application/domains/capabilities/CapabilitiesService";
import type { CapabilitiesPort } from "../src/application/domains/capabilities/ports";
import type {
  CapabilitiesState,
  CollectionState,
  SkillErrorView,
  SkillView,
  WebSearchSettings,
} from "../src/contracts/views/capabilities";

function port(
  overrides: Partial<CapabilitiesPort> = {},
): CapabilitiesPort {
  return {
    async listSkills() {
      return { skills: [], errors: [] };
    },
    async setSkillEnabled() {},
    async listPlugins() {
      return [];
    },
    async listMcpServers() {
      return [];
    },
    async reloadMcpServers() {},
    async readWebSearchSettings() {
      return { mode: null, allowedModes: null };
    },
    async setPluginEnabled() {},
    async setWebSearchMode() {},
    ...overrides,
  };
}

function harness(capabilityPort: CapabilitiesPort) {
  let skills: CollectionState<SkillView> = { status: "idle", items: [] };
  let skillErrors: SkillErrorView[] = [];
  let inventory: CapabilitiesState = {
    plugins: { status: "idle", items: [] },
    mcpServers: { status: "idle", items: [] },
  };
  let search: WebSearchSettings = { mode: null, allowedModes: null };
  const service = new CapabilitiesService({
    publishSkills(next, errors) {
      skills = next;
      skillErrors = errors;
    },
    publishInventory(next) {
      inventory = next;
    },
    publishWebSearch(next) {
      search = next;
    },
  });
  service.setContext(capabilityPort, "/repo");
  return {
    service,
    state: () => ({ skills, skillErrors, inventory, search }),
  };
}

describe("CapabilitiesService", () => {
  it("keeps independent results when one inventory source fails", async () => {
    const { service, state } = harness(
      port({
        async listPlugins() {
          throw new Error("catalog unavailable");
        },
        async listMcpServers() {
          return [
            {
              name: "local-tools",
              authStatus: "unsupported",
              toolNames: ["read"],
              resourceCount: 0,
              status: null,
              error: null,
              failureReason: null,
            },
          ];
        },
      }),
    );

    await service.refreshInventory();

    expect(state().inventory.plugins).toMatchObject({
      status: "error",
      message: "catalog unavailable",
    });
    expect(state().inventory.mcpServers).toMatchObject({
      status: "ready",
      items: [{ name: "local-tools" }],
    });
  });

  it("does not publish a slower refresh over a newer result", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const { service, state } = harness(
      port({
        async listPlugins() {
          call += 1;
          const name = call === 1 ? "old" : "new";
          if (call === 1) await blocked;
          return [
            {
              id: `${name}@local`,
              name,
              displayName: name,
              description: null,
              marketplace: "local",
              enabled: true,
              authPolicy: "ON_INSTALL",
              availability: "AVAILABLE",
              skillNames: [],
              mcpServerNames: [],
              defaultPrompts: [],
            },
          ];
        },
      }),
    );

    const first = service.refreshInventory();
    await service.refreshInventory();
    release();
    await first;

    expect(state().inventory.plugins.items.map((plugin) => plugin.name)).toEqual(
      ["new"],
    );
  });

  it("clears workspace-scoped state when the workspace changes", async () => {
    const skill: SkillView = {
      name: "review",
      description: "",
      displayName: null,
      shortDescription: null,
      defaultPrompt: null,
      path: "/repo/review/SKILL.md",
      scope: "repo",
      enabled: true,
    };
    const capabilityPort = port({
      async listSkills() {
        return { skills: [skill], errors: [] };
      },
    });
    const { service, state } = harness(capabilityPort);
    await service.refreshSkills();
    expect(state().skills.items).toHaveLength(1);

    service.setContext(capabilityPort, "/other");

    expect(state().skills).toEqual({ status: "idle", items: [] });
    expect(state().inventory.plugins).toEqual({ status: "idle", items: [] });
  });
});

