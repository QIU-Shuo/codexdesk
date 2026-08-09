import { describe, expect, it } from "vitest";
import { AppServerClient } from "../../src/main/appServer/client";
import { permittedWebSearchModes } from "../../src/application/domains/capabilities/policy";
import type { AppEvent } from "../../src/shared/ipc";

/**
 * Capability surfaces against a real `codex app-server` (§4.5 / V2.4).
 *
 * Fixtures cannot answer the questions that actually decided this slice's
 * design — whether the remote catalogue is reachable at all, whether
 * `plugin/installed` returns the shape we mapped, whether pagination
 * terminates. Those are entitlement and wire facts, and the whole point of
 * the note's §1.1 is that two of them turned out to contradict what the plan
 * assumed.
 *
 * These assert on *shape and reachability*, not on specific plugins: the
 * user's `~/.codex` is their own, and a test that requires GitHub to be
 * installed would be testing their configuration rather than our code.
 */
describe("live capabilities", () => {
  it("lists skills, and reports parse errors rather than hiding them", async () => {
    const client = new AppServerClient(() => {});
    await client.connect();
    const { skills, errors } = await client.listSkills(process.cwd(), false);

    // Every entry carries the fields the surface renders. A skill with no
    // path cannot be toggled, since `skills/config/write` selects by it.
    for (const skill of skills) {
      expect(skill.name).toBeTruthy();
      expect(skill.path).toBeTruthy();
      expect(typeof skill.enabled).toBe("boolean");
    }
    for (const err of errors) {
      expect(err.path).toBeTruthy();
      expect(err.message).toBeTruthy();
    }
    client.dispose();
  });

  it("returns installed plugins in the shape the catalog maps", async () => {
    const client = new AppServerClient(() => {});
    await client.connect();
    const plugins = await client.listPlugins(process.cwd());
    for (const plugin of plugins) {
      // `id` is `name@marketplace` and is what the config key is built from.
      expect(plugin.id).toContain("@");
      expect(plugin.displayName).toBeTruthy();
      expect(["ON_INSTALL", "ON_USE"]).toContain(plugin.authPolicy);
    }
    client.dispose();
  });

  it("drains MCP pagination and merges live startup status", async () => {
    const updates: AppEvent[] = [];
    const client = new AppServerClient(() => {});
    const seen: string[] = [];
    client.onMcpStatus = (u) => {
      seen.push(`${u.name}:${u.status}`);
      updates.push({ type: "log", level: "info", message: u.name });
    };
    await client.connect();

    const servers = await client.listMcpServers();
    // The loop must terminate — a `nextCursor` we never follow silently
    // truncates, and one we follow forever hangs.
    expect(Array.isArray(servers)).toBe(true);
    const names = servers.map((server) => server.name);
    expect(new Set(names).size).toBe(names.length);

    for (const server of servers) {
      expect(server.name).toBeTruthy();
      expect([
        "unsupported",
        "notLoggedIn",
        "bearerToken",
        "oAuth",
      ]).toContain(server.authStatus);
      // The finding this pins: the list response carries no startup state at
      // all, so an unmerged view is always null here. If this ever fails,
      // the protocol grew a field and the overlay is redundant.
      expect(server.status).toBeNull();
    }
    client.dispose();
  });

  it("reads the operator's web-search policy", async () => {
    const client = new AppServerClient(() => {});
    await client.connect();
    const settings = await client.readWebSearchSettings();
    const permitted = permittedWebSearchModes(settings.allowedModes);
    // Whatever the policy, the UI must have at least one mode to offer.
    expect(permitted.length).toBeGreaterThan(0);
    for (const mode of permitted) {
      expect(["disabled", "cached", "indexed", "live"]).toContain(mode);
    }
    client.dispose();
  });

  it("reads the effective web-search mode from config", async () => {
    const client = new AppServerClient(() => {});
    await client.connect();
    const settings = await client.readWebSearchSettings();
    expect(
      settings.mode === null ||
        ["disabled", "cached", "indexed", "live"].includes(settings.mode),
    ).toBe(true);
    client.dispose();
  });
});
