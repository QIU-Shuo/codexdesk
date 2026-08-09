import type {
  McpServerView,
  PluginView,
  SkillCatalog,
  WebSearchMode,
  WebSearchSettings,
} from "../../../contracts/views/capabilities";

/**
 * Everything the capabilities domain needs from the app-server boundary.
 * Production implementations provide every operation; test fakes may use the
 * small builder exported by their own test module rather than weakening this
 * interface with optional methods.
 */
export type CapabilitiesPort = {
  listSkills(cwd: string, forceReload: boolean): Promise<SkillCatalog>;
  setSkillEnabled(path: string, enabled: boolean): Promise<void>;
  listPlugins(cwd: string): Promise<PluginView[]>;
  listMcpServers(): Promise<McpServerView[]>;
  reloadMcpServers(): Promise<void>;
  readWebSearchSettings(): Promise<WebSearchSettings>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  setWebSearchMode(mode: WebSearchMode): Promise<void>;
};

