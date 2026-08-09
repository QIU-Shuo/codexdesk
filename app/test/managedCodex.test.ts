import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ManagedCodexRuntime,
  type ManagedCodexDependencies,
  type RuntimeRelease,
} from "../src/main/managedCodex";

const archiveBody = "small test archive";
const archiveSha256 = sha256(archiveBody);
const archiveName = "codex-package-aarch64-apple-darwin.tar.gz";
const checksumsBody = `${archiveSha256}  ${archiveName}\n`;

const release: RuntimeRelease = {
  version: "0.144.4",
  target: "aarch64-apple-darwin",
  archiveName,
  archiveBytes: Buffer.byteLength(archiveBody),
  archiveSha256,
  checksumsName: "codex-package_SHA256SUMS",
  checksumsBytes: Buffer.byteLength(checksumsBody),
  checksumsSha256: sha256(checksumsBody),
  baseUrl: "https://releases.openai.com/codex/releases/0.144.4",
  openAiTeamId: "2DC432GLL2",
};

async function root(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "codexdesk-runtime-test-"));
}

function dependencies(
  verify = vi.fn(async () => {}),
): ManagedCodexDependencies {
  return {
    platform: "darwin",
    arch: "arm64",
    download: vi.fn(
      async (url, destination, _expectedBytes, onProgress) => {
        const body = url.endsWith(release.checksumsName)
          ? checksumsBody
          : archiveBody;
        await writeFile(destination, body);
        onProgress?.(Buffer.byteLength(body));
      },
    ),
    extract: async (_archive, destination) => {
      await mkdir(path.join(destination, "bin"), { recursive: true });
      await writeFile(path.join(destination, "bin", "codex"), "fixture");
    },
    verify,
  };
}

describe("ManagedCodexRuntime", () => {
  it("reports a missing app-private runtime without searching PATH", async () => {
    const runtime = new ManagedCodexRuntime(
      await root(),
      release,
      dependencies(),
    );

    await expect(runtime.inspect()).resolves.toEqual({
      kind: "runtimeMissing",
      version: "0.144.4",
      sizeBytes: Buffer.byteLength(archiveBody),
    });
    expect(path.isAbsolute(runtime.executable)).toBe(true);
    expect(runtime.executable).toContain("/releases/0.144.4/bin/codex");
  });

  it("installs atomically and coalesces simultaneous requests", async () => {
    const rootDir = await root();
    const deps = dependencies();
    const runtime = new ManagedCodexRuntime(rootDir, release, deps);
    const progress: string[] = [];

    const [first, second] = await Promise.all([
      runtime.install((event) => progress.push(event.stage)),
      runtime.install((event) => progress.push(event.stage)),
    ]);

    expect(first).toEqual(second);
    expect(first.executable).toBe(runtime.executable);
    expect(deps.download).toHaveBeenCalledTimes(2);
    expect(progress).toContain("checkingSource");
    expect(progress).toContain("downloading");
    expect(progress).toContain("verifying");
    expect(progress).toContain("installing");
    await expect(runtime.inspect()).resolves.toMatchObject({
      kind: "ready",
      version: "0.144.4",
    });
  });

  it("refuses an installed payload that no longer verifies", async () => {
    const rootDir = await root();
    const good = dependencies();
    const runtime = new ManagedCodexRuntime(rootDir, release, good);
    await runtime.install(() => {});

    const broken = new ManagedCodexRuntime(
      rootDir,
      release,
      dependencies(vi.fn(async () => Promise.reject(new Error("bad signature")))),
    );
    await expect(broken.inspect()).resolves.toMatchObject({
      kind: "runtimeError",
      detail: expect.stringContaining("bad signature"),
    });
  });

  it("rejects a download that does not match the pinned checksum", async () => {
    const deps = dependencies();
    deps.download = async (url, destination, _expectedBytes, onProgress) => {
      const body = url.endsWith(release.checksumsName)
        ? checksumsBody
        : "modified archive";
      await writeFile(destination, body);
      onProgress?.(Buffer.byteLength(body));
    };
    const runtime = new ManagedCodexRuntime(await root(), release, deps);

    await expect(runtime.install(() => {})).rejects.toThrow("SHA-256");
  });

  it("keeps the previous verified runtime when a reinstall is corrupt", async () => {
    const deps = dependencies();
    const runtime = new ManagedCodexRuntime(await root(), release, deps);
    await runtime.install(() => {});
    deps.download = async (url, destination, _expectedBytes, onProgress) => {
      const body = url.endsWith(release.checksumsName)
        ? checksumsBody
        : "modified archive";
      await writeFile(destination, body);
      onProgress?.(Buffer.byteLength(body));
    };

    await expect(runtime.install(() => {})).rejects.toThrow("SHA-256");
    await expect(runtime.inspect()).resolves.toMatchObject({ kind: "ready" });
  });

  it("rejects unsupported release platforms before downloading", async () => {
    const deps = { ...dependencies(), arch: "x64" };
    const runtime = new ManagedCodexRuntime(await root(), release, deps);
    await expect(runtime.inspect()).resolves.toMatchObject({
      kind: "runtimeError",
      detail: expect.stringContaining("Apple-silicon"),
    });
    await expect(runtime.install(() => {})).rejects.toThrow("Apple-silicon");
    expect(deps.download).not.toHaveBeenCalled();
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
