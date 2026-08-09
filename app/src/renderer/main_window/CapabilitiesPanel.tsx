import { useEffect, useMemo, useState } from "react";
import type {
  AuthState,
  CapabilitiesState,
  CollectionState,
  ConfigState,
  McpServerView,
  NotifyMode,
  PluginView,
  SkillView,
  WebSearchMode,
} from "../../shared/ipc";

/**
 * Workspace tools and agent settings presented in one focused dialog.
 * Inventory, loading, and failure are separate states so an unavailable
 * service is never presented as an empty configuration.
 */
export type CapabilityTab = "general" | "skills" | "plugins" | "mcp" | "search";

const TABS: { id: CapabilityTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
  { id: "mcp", label: "MCP servers" },
  { id: "search", label: "Web search" },
];

export function CapabilitiesPanel({
  tab,
  onTab,
  config,
  capabilities,
  auth,
  notifyMode,
  codexVersion,
  runtimePath,
  onReinstallRuntime,
  onNotifyMode,
  onSignOut,
  onClose,
}: {
  tab: CapabilityTab;
  onTab: (tab: CapabilityTab) => void;
  config: ConfigState;
  capabilities: CapabilitiesState;
  auth: AuthState;
  notifyMode: NotifyMode;
  codexVersion: string | null;
  runtimePath: string | null;
  onReinstallRuntime: () => Promise<{ ok: boolean; error?: string }>;
  onNotifyMode: (mode: NotifyMode) => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Plugin and MCP configuration can change outside this process, and there
   * is no `plugins/changed` notification. Refresh whenever the panel opens.
   */
  useEffect(() => {
    void window.codexDesk.refreshCapabilities();
  }, []);

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="capabilities-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <aside className="capabilities-nav">
          <h2>Settings</h2>
          <div className="capabilities-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={t.id === tab}
                className={t.id === tab ? "active" : ""}
                onClick={() => onTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="capabilities-version">
            {codexVersion && <span>codex {codexVersion}</span>}
            <span>CodexDesk 0.1.0</span>
          </div>
        </aside>

        <main className="capabilities-content">
          <header className="capabilities-head">
            <div>
              <h1>{PAGE_COPY[tab].title}</h1>
              <p>{PAGE_COPY[tab].detail}</p>
            </div>
            <button
              className="ghost"
              onClick={onClose}
              aria-label="Close settings"
            >
              Close
            </button>
          </header>

          <div className="capabilities-body">
            {tab === "general" && (
              <GeneralPage
                auth={auth}
                notifyMode={notifyMode}
                onNotifyMode={onNotifyMode}
                onSignOut={onSignOut}
                codexVersion={codexVersion}
                runtimePath={runtimePath}
                onReinstallRuntime={onReinstallRuntime}
              />
            )}
            {tab === "skills" && (
              <SkillsPage state={config.skills} errors={config.skillErrors} />
            )}
            {tab === "plugins" && <PluginsPage capabilities={capabilities} />}
            {tab === "mcp" && <McpPage capabilities={capabilities} />}
            {tab === "search" && <WebSearchPage config={config} />}
          </div>
        </main>
      </div>
    </div>
  );
}

const PAGE_COPY: Record<CapabilityTab, { title: string; detail: string }> = {
  general: {
    title: "General",
    detail: "How CodexDesk starts a thread, and what it does with your checkout.",
  },
  skills: {
    title: "Skills",
    detail: "Reusable instructions available to Codex in this workspace.",
  },
  plugins: {
    title: "Plugins",
    detail: "Extend Codex with packaged skills, apps, and tools.",
  },
  mcp: {
    title: "MCP servers",
    detail: "Tools and data made available by configured MCP servers.",
  },
  search: {
    title: "Web search",
    detail: "Choose whether and how Codex can search the web.",
  },
};

function GeneralPage({
  auth,
  notifyMode,
  onNotifyMode,
  onSignOut,
  codexVersion,
  runtimePath,
  onReinstallRuntime,
}: {
  auth: AuthState;
  notifyMode: NotifyMode;
  onNotifyMode: (mode: NotifyMode) => void;
  onSignOut: () => void;
  codexVersion: string | null;
  runtimePath: string | null;
  onReinstallRuntime: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const signedIn = auth.kind === "signedIn" || auth.kind === "authenticated";
  let accountTitle = "Not signed in";
  let accountDetail = "Sign in from the main window to use Codex.";
  if (auth.kind === "authenticated") {
    accountTitle = "Signed in with Codex";
    accountDetail = "Authenticated session";
  } else if (auth.kind === "signedIn") {
    if (auth.account.type === "chatgpt") {
      accountTitle = "Signed in with ChatGPT";
      accountDetail = [auth.account.email, auth.account.planType]
        .filter(Boolean)
        .join(" · ");
    } else if (auth.account.type === "apiKey") {
      accountTitle = "Signed in with an API key";
      accountDetail = "OpenAI API account";
    } else {
      accountTitle = "Signed in with Amazon Bedrock";
      accountDetail = "Managed credentials";
    }
  }

  const modes: { id: NotifyMode; label: string }[] = [
    { id: "off", label: "Off" },
    { id: "unfocused", label: "Unfocused" },
    { id: "always", label: "Always" },
  ];

  return (
    <>
      <section className="settings-section">
        <h2>Account</h2>
        <div className="settings-account-card">
          <div>
            <strong>{accountTitle}</strong>
            <span>{accountDetail}</span>
          </div>
          {signedIn && (
            <button className="ghost" type="button" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2>Codex runtime</h2>
        <div className="settings-control-row">
          <div>
            <strong>
              Managed by CodexDesk{codexVersion ? ` · ${codexVersion}` : ""}
            </strong>
            <span title={runtimePath ?? undefined}>
              {runtimePath ?? "Runtime location unavailable"}
            </span>
          </div>
          <button
            className="ghost"
            type="button"
            disabled={runtimeBusy}
            onClick={() => {
              setRuntimeBusy(true);
              setRuntimeError(null);
              void onReinstallRuntime()
                .then((result) => {
                  if (!result.ok) {
                    setRuntimeError(result.error ?? "Installation failed.");
                  }
                })
                .finally(() => setRuntimeBusy(false));
            }}
          >
            {runtimeBusy ? "Reinstalling…" : "Reinstall"}
          </button>
        </div>
        {runtimeError && (
          <p className="settings-runtime-error" role="alert">
            {runtimeError}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>Notifications</h2>
        <div className="settings-control-row">
          <div>
            <strong>Notify when a turn finishes</strong>
            <span>Native notification</span>
          </div>
          <div
            className="settings-segmented"
            role="radiogroup"
            aria-label="Turn notifications"
          >
            {modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={notifyMode === mode.id}
                className={notifyMode === mode.id ? "active" : ""}
                onClick={() => onNotifyMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <p className="settings-config-note">
        Advanced defaults are read from <code>~/.codex/config.toml</code>.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ skills

const SCOPE_LABELS: Record<string, string> = {
  user: "Personal",
  repo: "This repository",
  system: "System",
  admin: "Administrator",
};

function SkillsPage({
  state,
  errors,
}: {
  state: CollectionState<SkillView>;
  errors: { path: string; message: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const skills = state.items;
  const grouped = useMemo(() => {
    const map = new Map<string, SkillView[]>();
    for (const skill of skills) {
      const key = skill.scope ?? "user";
      const list = map.get(key) ?? [];
      list.push(skill);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [skills]);

  return (
    <>
      <div className="capabilities-actions">
        <p className="hint">
          Skills are reusable instructions the agent can follow. They come from
          this repository, your Codex home, or an installed plugin.
        </p>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.codexDesk.refreshSkills().finally(() => setBusy(false));
          }}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {state.status === "loading" && <p className="hint">Reading skills…</p>}
      {state.status === "error" && (
        <p className="capability-errors">{state.message}</p>
      )}

      {errors.length > 0 && (
        <div className="capability-errors">
          <strong>{errors.length} skill(s) failed to load</strong>
          {errors.map((err) => (
            <div className="capability-error" key={err.path}>
              <code>{err.path}</code>
              <span>{err.message}</span>
            </div>
          ))}
        </div>
      )}

      {state.status === "ready" &&
        skills.length === 0 &&
        errors.length === 0 && (
          <p className="hint">
            No skills found for this workspace. Add a <code>SKILL.md</code>{" "}
            under <code>.agents/skills/</code>, or install a plugin that
            provides one.
          </p>
        )}

      {grouped.map(([scope, list]) => (
        <section className="capability-group" key={scope}>
          <h3>{SCOPE_LABELS[scope] ?? scope}</h3>
          {list.map((skill) => (
            <SkillRow key={skill.path} skill={skill} />
          ))}
        </section>
      ))}
    </>
  );
}

function SkillRow({ skill }: { skill: SkillView }) {
  const label = skill.displayName || skill.name;
  const description = skill.shortDescription || skill.description;
  return (
    <div className={`capability-row${skill.enabled ? "" : " disabled"}`}>
      <div className="capability-main">
        <div className="capability-title">
          <span className="capability-name">{label}</span>
          {label !== skill.name && (
            <code className="capability-id">{skill.name}</code>
          )}
        </div>
        {description && <p className="capability-desc">{description}</p>}
        <code className="capability-path" title={skill.path}>
          {skill.path}
        </code>
      </div>
      <label className="capability-toggle">
        <input
          type="checkbox"
          checked={skill.enabled}
          aria-label={`Enable ${label}`}
          onChange={(e) =>
            void window.codexDesk.setSkillEnabled(skill.path, e.target.checked)
          }
        />
        <span>{skill.enabled ? "Enabled" : "Disabled"}</span>
      </label>
    </div>
  );
}

// ----------------------------------------------------------------- plugins

function PluginsPage({ capabilities }: { capabilities: CapabilitiesState }) {
  return (
    <>
      {capabilities.plugins.status === "loading" && (
        <p className="hint">Reading plugins…</p>
      )}

      {capabilities.plugins.status === "error" && (
        <p className="capability-errors">{capabilities.plugins.message}</p>
      )}

      {capabilities.plugins.status === "ready" &&
        capabilities.plugins.items.length === 0 && (
          <p className="hint">No plugins are available.</p>
        )}

      {capabilities.plugins.items.map((plugin) => (
        <PluginRow key={plugin.id} plugin={plugin} />
      ))}
    </>
  );
}

function PluginRow({ plugin }: { plugin: PluginView }) {
  const managed = plugin.availability === "DISABLED_BY_ADMIN";
  return (
    <div className={`capability-row${plugin.enabled ? "" : " disabled"}`}>
      <div className="capability-main">
        <div className="capability-title">
          <span className="capability-name">{plugin.displayName}</span>
          <code className="capability-id">{plugin.marketplace}</code>
        </div>
        {plugin.description && (
          <p className="capability-desc">{plugin.description}</p>
        )}
        {/*
          `ON_USE` installs cleanly and then demands sign-in partway through a
          turn. Saying so here is the difference between "this plugin is
          broken" and "this plugin needs sign-in when first used".
        */}
        {plugin.authPolicy === "ON_USE" && (
          <span className="capability-badge">Signs in when first used</span>
        )}
        {managed && (
          <span className="capability-badge managed">
            Disabled by your administrator
          </span>
        )}
      </div>
      <label className="capability-toggle">
        <input
          type="checkbox"
          checked={plugin.enabled}
          disabled={managed}
          aria-label={`Enable ${plugin.displayName}`}
          onChange={(e) =>
            void window.codexDesk.setPluginEnabled(plugin.id, e.target.checked)
          }
        />
        <span>{plugin.enabled ? "Enabled" : "Disabled"}</span>
      </label>
    </div>
  );
}

// --------------------------------------------------------------------- MCP

const AUTH_LABELS: Record<McpServerView["authStatus"], string> = {
  unsupported: "No sign-in required",
  notLoggedIn: "Not signed in",
  bearerToken: "Signed in",
  oAuth: "Signed in with OAuth",
};

function McpPage({ capabilities }: { capabilities: CapabilitiesState }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="capabilities-actions">
        <p className="hint">
          MCP servers give the agent tools and data from outside this workspace.
          They are configured in <code>config.toml</code>.
        </p>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.codexDesk.reloadMcpServers().finally(() => setBusy(false));
          }}
        >
          {busy ? "Reloading…" : "Reload"}
        </button>
      </div>

      {capabilities.mcpServers.status === "loading" && (
        <p className="hint">Reading servers…</p>
      )}

      {capabilities.mcpServers.status === "error" && (
        <p className="capability-errors">{capabilities.mcpServers.message}</p>
      )}

      {capabilities.mcpServers.status === "ready" &&
        capabilities.mcpServers.items.length === 0 && (
          <p className="hint">
            No MCP servers configured. Add one under <code>[mcp_servers]</code>{" "}
            in <code>~/.codex/config.toml</code>.
          </p>
        )}

      {capabilities.mcpServers.items.map((server) => (
        <McpRow key={server.name} server={server} />
      ))}
    </>
  );
}

function McpRow({ server }: { server: McpServerView }) {
  const failed = server.status === "failed";
  return (
    <div className={`capability-row${failed ? " failed" : ""}`}>
      <div className="capability-main">
        <div className="capability-title">
          <span className="capability-name">{server.name}</span>
          {/*
            Null means no startup transition was observed — the server may
            have started before this window opened. That is not the same as
            "not running", so it says nothing rather than guessing.
          */}
          {server.status && (
            <span className={`capability-status ${server.status}`}>
              {server.status}
            </span>
          )}
        </div>
        <p className="capability-desc">
          {server.toolNames.length} tool
          {server.toolNames.length === 1 ? "" : "s"}
          {server.resourceCount > 0 && `, ${server.resourceCount} resources`}
          {" · "}
          {AUTH_LABELS[server.authStatus]}
        </p>
        {server.toolNames.length > 0 && (
          <code className="capability-path" title={server.toolNames.join(", ")}>
            {server.toolNames.slice(0, 8).join(", ")}
            {server.toolNames.length > 8 &&
              ` +${server.toolNames.length - 8} more`}
          </code>
        )}
        {/*
          The only enumerated failure reason, and it is recoverable — it gets
          its own explanation rather than being flattened into the error text.
        */}
        {server.failureReason === "reauthenticationRequired" && (
          <span className="capability-badge">
            Needs to be signed in again. Reload after updating credentials.
          </span>
        )}
        {server.error && <p className="capability-errors">{server.error}</p>}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- web search

const MODE_LABELS: Record<WebSearchMode, { title: string; detail: string }> = {
  disabled: {
    title: "Off",
    detail: "The agent cannot search the web.",
  },
  cached: {
    title: "Cached",
    detail: "Results come from a cache. No live requests are made.",
  },
  indexed: {
    title: "Indexed",
    detail: "Search an index rather than fetching pages live.",
  },
  live: {
    title: "Live",
    detail: "Fetch current pages from the web.",
  },
};

const ALL_MODES: WebSearchMode[] = ["disabled", "cached", "indexed", "live"];

function WebSearchPage({ config }: { config: ConfigState }) {
  /**
   * `allowedWebSearchModes` is operator policy from
   * `configRequirements/read`. Null means unconstrained; a list means only
   * those. Offering a mode outside it would present a control an admin has
   * disabled.
   */
  const allowed = config.allowedWebSearchModes;
  const permitted =
    allowed && allowed.length > 0
      ? ALL_MODES.filter((m) => allowed.includes(m))
      : ALL_MODES;
  const current = config.webSearchMode;

  return (
    <>
      <p className="hint">
        Whether the agent can search the web, and how. This writes{" "}
        <code>web_search</code> in <code>config.toml</code> and applies to
        threads started afterwards.
      </p>

      {permitted.length < ALL_MODES.length && (
        <p className="hint">
          Some modes are unavailable because of your organization's policy.
        </p>
      )}

      <div className="capability-modes" role="radiogroup">
        {permitted.map((mode) => (
          <label
            className={`capability-mode${current === mode ? " active" : ""}`}
            key={mode}
          >
            <input
              type="radio"
              name="web-search-mode"
              checked={current === mode}
              onChange={() => void window.codexDesk.setWebSearchMode(mode)}
            />
            <span className="capability-name">{MODE_LABELS[mode].title}</span>
            <span className="capability-desc">{MODE_LABELS[mode].detail}</span>
          </label>
        ))}
      </div>

      {current === null && (
        <p className="hint">
          No mode is set, so the app-server default applies.
        </p>
      )}
    </>
  );
}
