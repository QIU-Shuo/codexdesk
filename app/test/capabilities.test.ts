import { describe, expect, it } from "vitest";
import {
  mapMcpServers,
  mapMcpStatus,
  mapPlugins,
  mapSkillCatalog,
  pluginConfigKey,
} from "../src/infrastructure/app-server/adapters/capabilities";
import {
  isWebSearchMode,
  permittedWebSearchModes,
} from "../src/application/domains/capabilities/policy";
import type { SkillsListResponse } from "../src/protocol/generated/v2/SkillsListResponse";
import type { PluginInstalledResponse } from "../src/protocol/generated/v2/PluginInstalledResponse";
import type { McpServerStatus } from "../src/protocol/generated/v2/McpServerStatus";

/**
 * Capability mapping (§4.5 / V2.4).
 *
 * These are the parts with invariants rather than markup: the two-source MCP
 * merge, the errors half of `skills/list` that used to be silently dropped,
 * and the config key a plugin toggle writes.
 */

// ------------------------------------------------------------------ skills

describe("mapSkills", () => {
  it("keeps parse errors instead of dropping them", () => {
    // The regression this exists for: `loadConfig` used to flatMap to
    // `e.skills` and discard `e.errors`, which made a malformed SKILL.md
    // invisible rather than reported.
    const res = {
      data: [
        {
          cwd: "/repo",
          skills: [
            {
              name: "review",
              description: "Review a diff",
              path: "/repo/.agents/skills/review/SKILL.md",
              scope: "repo",
              enabled: true,
            },
          ],
          errors: [
            { path: "/repo/.agents/skills/bad/SKILL.md", message: "no title" },
          ],
        },
      ],
    } as unknown as SkillsListResponse;

    const { skills, errors } = mapSkillCatalog(res);
    expect(skills).toHaveLength(1);
    expect(errors).toEqual([
      { path: "/repo/.agents/skills/bad/SKILL.md", message: "no title" },
    ]);
  });

  it("survives an entry with no errors array", () => {
    const res = {
      data: [{ cwd: "/repo", skills: [] }],
    } as unknown as SkillsListResponse;
    expect(mapSkillCatalog(res)).toEqual({ skills: [], errors: [] });
  });
});

// ----------------------------------------------------------------- plugins

const pluginResponse = (
  overrides: Record<string, unknown> = {},
): PluginInstalledResponse =>
  ({
    marketplaces: [
      {
        name: "openai-curated",
        path: null,
        interface: null,
        plugins: [
          {
            id: "github@openai-curated",
            name: "github",
            installed: true,
            enabled: true,
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            interface: {
              displayName: "GitHub",
              shortDescription: "Issues and PRs",
              defaultPrompt: ["Open a PR", "Review this issue"],
            },
            ...overrides,
          },
        ],
      },
    ],
    marketplaceLoadErrors: [],
  }) as unknown as PluginInstalledResponse;

describe("mapPlugins", () => {
  it("maps the fields the catalog renders", () => {
    const [plugin] = mapPlugins(pluginResponse());
    expect(plugin).toMatchObject({
      id: "github@openai-curated",
      displayName: "GitHub",
      marketplace: "openai-curated",
      enabled: true,
      authPolicy: "ON_USE",
      availability: "AVAILABLE",
      defaultPrompts: ["Open a PR", "Review this issue"],
    });
  });

  it("omits uninstalled entries", () => {
    // `plugin/installed` can return uninstalled plugins as install
    // suggestions. Showing one implies the agent can use it, which is false.
    expect(mapPlugins(pluginResponse({ installed: false }))).toEqual([]);
  });

  it("falls back to the raw name when there is no interface", () => {
    const [plugin] = mapPlugins(pluginResponse({ interface: null }));
    expect(plugin.displayName).toBe("github");
    expect(plugin.description).toBeNull();
    expect(plugin.defaultPrompts).toEqual([]);
  });

  it("carries DISABLED_BY_ADMIN through as a state, not an error", () => {
    const [plugin] = mapPlugins(
      pluginResponse({ availability: "DISABLED_BY_ADMIN" }),
    );
    expect(plugin.availability).toBe("DISABLED_BY_ADMIN");
  });
});

describe("pluginConfigKey", () => {
  it("quotes the id so the dotted path does not split on @ or -", () => {
    // `plugins.github@openai-curated.enabled` would address the wrong table.
    expect(pluginConfigKey("github@openai-curated")).toBe(
      'plugins."github@openai-curated".enabled',
    );
  });
});

// --------------------------------------------------------------------- MCP

const status = (name: string, tools: string[] = []): McpServerStatus =>
  ({
    name,
    serverInfo: null,
    tools: Object.fromEntries(tools.map((t) => [t, {}])),
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
  }) as unknown as McpServerStatus;

describe("mapMcpServers", () => {
  it("reports no status when no transition has been seen", () => {
    // The trap this guards: `mcpServerStatus/list` carries no startup state
    // at all. A server that started before the window opened never sends a
    // notification, so null means "unobserved", not "stopped".
    const [server] = mapMcpServers([status("playwright", ["a", "b"])]);
    expect(server.status).toBeNull();
    expect(server.toolNames).toEqual(["a", "b"]);
  });

});

describe("mapMcpStatus", () => {
  it("keeps only renderer-safe transition fields", () => {
    const update = mapMcpStatus({
      name: "drive",
      threadId: null,
      status: "failed",
      error: "connection refused",
      failureReason: "reauthenticationRequired",
    });
    expect(update).toEqual({
      name: "drive",
      status: "failed",
      error: "connection refused",
      failureReason: "reauthenticationRequired",
    });
  });
});

// -------------------------------------------------------------- web search

describe("web search mode", () => {
  it("offers every mode when policy is unconstrained", () => {
    expect(permittedWebSearchModes(null)).toEqual([
      "disabled",
      "cached",
      "indexed",
      "live",
    ]);
  });

  it("offers only the operator's list", () => {
    // Presenting a mode an admin disabled would produce a control whose
    // write silently does nothing.
    expect(permittedWebSearchModes(["disabled", "cached"])).toEqual([
      "disabled",
      "cached",
    ]);
  });

  it("treats an empty allow-list as unconstrained", () => {
    expect(permittedWebSearchModes([])).toHaveLength(4);
  });

  it("rejects values that are not modes", () => {
    expect(isWebSearchMode("live")).toBe(true);
    expect(isWebSearchMode("everything")).toBe(false);
    expect(isWebSearchMode(undefined)).toBe(false);
  });
});
