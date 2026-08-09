import type {
  McpServerView,
  McpStatusUpdate,
  PluginView,
  SkillCatalog,
  SkillView,
  WebSearchMode,
  WebSearchSettings,
} from "../../../contracts/views/capabilities";
import { isWebSearchMode } from "../../../application/domains/capabilities/policy";
import type { SkillsListResponse } from "../../../protocol/generated/v2/SkillsListResponse";
import type { SkillMetadata } from "../../../protocol/generated/v2/SkillMetadata";
import type {
  PluginInstalledResponse,
} from "../../../protocol/generated/v2/PluginInstalledResponse";
import type { McpServerStatus } from "../../../protocol/generated/v2/McpServerStatus";
import type {
  McpServerStatusUpdatedNotification,
} from "../../../protocol/generated/v2/McpServerStatusUpdatedNotification";
import type { ConfigRequirements } from "../../../protocol/generated/v2/ConfigRequirements";
import type { ConfigReadResponse } from "../../../protocol/generated/v2/ConfigReadResponse";

function mapSkill(skill: SkillMetadata): SkillView {
  return {
    name: skill.name,
    description: skill.description,
    displayName: skill.interface?.displayName ?? null,
    shortDescription:
      skill.interface?.shortDescription ?? skill.shortDescription ?? null,
    defaultPrompt: skill.interface?.defaultPrompt ?? null,
    path: skill.path,
    scope: skill.scope,
    enabled: skill.enabled,
  };
}

export function mapSkillCatalog(response: SkillsListResponse): SkillCatalog {
  const skills: SkillView[] = [];
  const errors: SkillCatalog["errors"] = [];
  for (const entry of response.data) {
    skills.push(...entry.skills.map(mapSkill));
    for (const error of entry.errors ?? []) {
      errors.push({ path: error.path, message: error.message });
    }
  }
  return { skills, errors };
}

export function mapPlugins(response: PluginInstalledResponse): PluginView[] {
  const plugins: PluginView[] = [];
  for (const marketplace of response.marketplaces ?? []) {
    for (const plugin of marketplace.plugins ?? []) {
      if (!plugin.installed) continue;
      const details = plugin.interface;
      plugins.push({
        id: plugin.id,
        name: plugin.name,
        displayName: details?.displayName || plugin.name,
        description: details?.shortDescription ?? null,
        marketplace: marketplace.name,
        enabled: plugin.enabled,
        authPolicy: plugin.authPolicy === "ON_USE" ? "ON_USE" : "ON_INSTALL",
        availability:
          plugin.availability === "DISABLED_BY_ADMIN"
            ? "DISABLED_BY_ADMIN"
            : "AVAILABLE",
        skillNames: [],
        mcpServerNames: [],
        defaultPrompts: cleanPrompts(details?.defaultPrompt),
      });
    }
  }
  return plugins.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function cleanPrompts(value: string[] | null | undefined): string[] {
  return value?.filter((entry) => entry.length > 0) ?? [];
}

export function mapMcpServers(statuses: McpServerStatus[]): McpServerView[] {
  return statuses
    .map((server) => ({
      name: server.name,
      authStatus: server.authStatus,
      toolNames: Object.keys(server.tools ?? {}).sort(),
      resourceCount: (server.resources ?? []).length,
      status: null,
      error: null,
      failureReason: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function mapMcpStatus(
  update: McpServerStatusUpdatedNotification,
): McpStatusUpdate {
  return {
    name: update.name,
    status: update.status,
    error: update.error ?? null,
    failureReason:
      update.failureReason === "reauthenticationRequired"
        ? "reauthenticationRequired"
        : null,
  };
}

export function mapWebSearchSettings(
  config: ConfigReadResponse | null,
  requirements: ConfigRequirements | null,
): WebSearchSettings {
  const value = (config?.config as { web_search?: unknown } | undefined)
    ?.web_search;
  const allowed = requirements?.allowedWebSearchModes ?? null;
  return {
    mode: isWebSearchMode(value) ? value : null,
    allowedModes: allowed?.filter(
      (mode): mode is WebSearchMode => isWebSearchMode(mode),
    ) ?? null,
  };
}

export function pluginConfigKey(pluginId: string): string {
  return `plugins."${pluginId}".enabled`;
}
