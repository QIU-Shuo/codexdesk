import type {
  CapabilitiesState,
  CollectionState,
  McpServerView,
  McpStatusUpdate,
  SkillErrorView,
  SkillView,
  WebSearchMode,
  WebSearchSettings,
} from "../../../contracts/views/capabilities";
import type { CapabilitiesPort } from "./ports";
import { permittedWebSearchModes } from "./policy";

type CapabilitySink = {
  publishSkills(
    state: CollectionState<SkillView>,
    errors: SkillErrorView[],
  ): void;
  publishInventory(state: CapabilitiesState): void;
  publishWebSearch(settings: WebSearchSettings): void;
};

const idle = <T>(): CollectionState<T> => ({ status: "idle", items: [] });

const loading = <T>(state: CollectionState<T>): CollectionState<T> => ({
  status: "loading",
  items: state.items,
});

const failed = <T>(
  state: CollectionState<T>,
  error: unknown,
): CollectionState<T> => ({
  status: "error",
  items: state.items,
  message: error instanceof Error ? error.message : String(error),
});

function withItems<T>(
  state: CollectionState<T>,
  items: T[],
): CollectionState<T> {
  return state.status === "error"
    ? { status: "error", items, message: state.message }
    : { status: state.status, items };
}

/**
 * Owns capability refreshes and optimistic mutations.
 *
 * The surrounding desktop runtime supplies a port and workspace. This class
 * owns race handling and state transitions; it knows nothing about Electron,
 * React, generated protocol types, or the larger thread orchestrator.
 */
export class CapabilitiesService {
  private port: CapabilitiesPort | null = null;
  private workspace: string | null = null;
  private refreshVersion = 0;
  private mcpUpdates = new Map<string, McpStatusUpdate>();

  private skills: CollectionState<SkillView> = idle();
  private skillErrors: SkillErrorView[] = [];
  private inventory: CapabilitiesState = {
    plugins: idle(),
    mcpServers: idle(),
  };
  private search: WebSearchSettings = { mode: null, allowedModes: null };

  constructor(private readonly sink: CapabilitySink) {}

  setContext(port: CapabilitiesPort | null, workspace: string | null): void {
    this.port = port;
    if (workspace !== this.workspace) {
      this.refreshVersion += 1;
      this.mcpUpdates.clear();
      this.skills = idle();
      this.skillErrors = [];
      this.inventory = { plugins: idle(), mcpServers: idle() };
      this.search = { mode: null, allowedModes: null };
      this.sink.publishSkills(this.skills, this.skillErrors);
      this.sink.publishInventory(this.inventory);
      this.sink.publishWebSearch(this.search);
    }
    this.workspace = workspace;
  }

  snapshot(): {
    skills: CollectionState<SkillView>;
    skillErrors: SkillErrorView[];
    inventory: CapabilitiesState;
    search: WebSearchSettings;
  } {
    return {
      skills: this.skills,
      skillErrors: this.skillErrors,
      inventory: this.inventory,
      search: this.search,
    };
  }

  async refreshSkills(forceReload = false): Promise<void> {
    if (!this.port || !this.workspace) return;
    this.skills = loading(this.skills);
    this.sink.publishSkills(this.skills, this.skillErrors);
    try {
      const result = await this.port.listSkills(this.workspace, forceReload);
      this.skillErrors = result.errors;
      this.skills = { status: "ready", items: result.skills };
    } catch (error) {
      this.skills = failed(this.skills, error);
    }
    this.sink.publishSkills(this.skills, this.skillErrors);
  }

  async setSkillEnabled(path: string, enabled: boolean): Promise<void> {
    if (!this.port) return;
    const previous = this.skills;
    this.skills = withItems(
      previous,
      previous.items.map((skill) =>
        skill.path === path ? { ...skill, enabled } : skill,
      ),
    );
    this.sink.publishSkills(this.skills, this.skillErrors);
    try {
      await this.port.setSkillEnabled(path, enabled);
    } catch {
      await this.refreshSkills();
    }
  }

  async refreshInventory(): Promise<void> {
    if (!this.port || !this.workspace) return;
    const version = ++this.refreshVersion;
    this.inventory = {
      plugins: loading(this.inventory.plugins),
      mcpServers: loading(this.inventory.mcpServers),
    };
    this.sink.publishInventory(this.inventory);

    const [plugins, servers] = await Promise.allSettled([
      this.port.listPlugins(this.workspace),
      this.port.listMcpServers(),
    ]);
    if (version !== this.refreshVersion) return;

    this.inventory = {
      plugins:
        plugins.status === "fulfilled"
          ? { status: "ready", items: plugins.value }
          : failed(this.inventory.plugins, plugins.reason),
      mcpServers:
        servers.status === "fulfilled"
          ? {
              status: "ready",
              items: servers.value.map((server) => this.withMcpUpdate(server)),
            }
          : failed(this.inventory.mcpServers, servers.reason),
    };
    this.sink.publishInventory(this.inventory);
  }

  applyMcpStatus(update: McpStatusUpdate): void {
    this.mcpUpdates.set(update.name, update);
    const known = this.inventory.mcpServers.items.some(
      (server) => server.name === update.name,
    );
    if (!known) {
      if (this.inventory.mcpServers.status !== "idle") {
        void this.refreshInventory();
      }
      return;
    }
    this.inventory = {
      ...this.inventory,
      mcpServers: {
        ...this.inventory.mcpServers,
        items: this.inventory.mcpServers.items.map((server) =>
          server.name === update.name ? { ...server, ...update } : server,
        ),
      },
    };
    this.sink.publishInventory(this.inventory);
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (!this.port) return;
    this.inventory = {
      ...this.inventory,
      plugins: {
        ...this.inventory.plugins,
        items: this.inventory.plugins.items.map((plugin) =>
          plugin.id === pluginId ? { ...plugin, enabled } : plugin,
        ),
      },
    };
    this.sink.publishInventory(this.inventory);
    try {
      await this.port.setPluginEnabled(pluginId, enabled);
    } catch {
      await this.refreshInventory();
    }
  }

  async reloadMcpServers(): Promise<void> {
    if (!this.port) return;
    this.mcpUpdates.clear();
    try {
      await this.port.reloadMcpServers();
    } catch {
      // The follow-up inventory read provides the visible failure state.
    }
    await this.refreshInventory();
  }

  async loadWebSearch(): Promise<void> {
    if (!this.port) return;
    try {
      this.search = await this.port.readWebSearchSettings();
      this.sink.publishWebSearch(this.search);
    } catch {
      // Preserve the last known setting. Search configuration is optional
      // product context and should not make the rest of config unavailable.
    }
  }

  async setWebSearchMode(mode: WebSearchMode): Promise<void> {
    if (!this.port) return;
    if (!permittedWebSearchModes(this.search.allowedModes).includes(mode)) {
      return;
    }
    const previous = this.search;
    this.search = { ...this.search, mode };
    this.sink.publishWebSearch(this.search);
    try {
      await this.port.setWebSearchMode(mode);
    } catch {
      this.search = previous;
      this.sink.publishWebSearch(this.search);
    }
  }

  private withMcpUpdate(server: McpServerView): McpServerView {
    const update = this.mcpUpdates.get(server.name);
    return update ? { ...server, ...update } : server;
  }
}
