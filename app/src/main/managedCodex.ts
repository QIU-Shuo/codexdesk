import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PreflightState, RuntimeInstallStage } from "../shared/ipc";

const run = promisify(execFile);

const EXPECTED_ARCHIVE_ENTRIES = new Set([
  "bin/",
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-package.json",
  "codex-path/",
  "codex-path/rg",
  "codex-resources/",
  "codex-resources/zsh/",
  "codex-resources/zsh/bin/",
  "codex-resources/zsh/bin/zsh",
]);

/**
 * Runtime and protocol bindings move together. A CodexDesk release always
 * downloads this exact OpenAI artifact; it never discovers or launches a
 * user-installed `codex` from PATH.
 */
export type RuntimeRelease = {
  version: string;
  target: string;
  archiveName: string;
  archiveBytes: number;
  archiveSha256: string;
  checksumsName: string;
  checksumsBytes: number;
  checksumsSha256: string;
  baseUrl: string;
  openAiTeamId: string;
};

export const MANAGED_CODEX_RELEASE = {
  version: "0.144.4",
  target: "aarch64-apple-darwin",
  archiveName: "codex-package-aarch64-apple-darwin.tar.gz",
  archiveBytes: 116_111_014,
  archiveSha256:
    "312e6fa2826596fb23cc1193c30d51902b6522c36ccc43b36417590e0ebd533d",
  checksumsName: "codex-package_SHA256SUMS",
  checksumsBytes: 1_392,
  checksumsSha256:
    "09e949a00cbcbd95d5a3d3bd6c7647e38965e944a3f7d2eb148781d3a488414a",
  baseUrl: "https://releases.openai.com/codex/releases/0.144.4",
  openAiTeamId: "2DC432GLL2",
} as const satisfies RuntimeRelease;

export type RuntimeProgress = {
  stage: RuntimeInstallStage;
  downloadedBytes: number;
  totalBytes: number;
};

export type ManagedCodexDependencies = {
  platform: NodeJS.Platform;
  arch: string;
  download: typeof downloadFile;
  extract: typeof extractArchive;
  verify: typeof verifyPayload;
};

const DEFAULT_DEPENDENCIES: ManagedCodexDependencies = {
  platform: process.platform,
  arch: process.arch,
  download: downloadFile,
  extract: extractArchive,
  verify: verifyPayload,
};

/** A verified, app-private Codex installation. */
export type ManagedCodexReady = {
  version: string;
  executable: string;
};

export class ManagedCodexRuntime {
  private installPromise: Promise<ManagedCodexReady> | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly release: RuntimeRelease = MANAGED_CODEX_RELEASE,
    private readonly dependencies: ManagedCodexDependencies =
      DEFAULT_DEPENDENCIES,
  ) {}

  get executable(): string {
    return path.join(this.releaseDir, "bin", "codex");
  }

  get releaseDir(): string {
    return path.join(this.rootDir, "releases", this.release.version);
  }

  get displayPath(): string {
    return this.releaseDir;
  }

  async inspect(): Promise<PreflightState> {
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      return {
        kind: "runtimeError",
        version: this.release.version,
        detail: unsupported,
      };
    }

    try {
      await access(this.executable);
    } catch {
      return {
        kind: "runtimeMissing",
        version: this.release.version,
        sizeBytes: this.release.archiveBytes,
      };
    }

    try {
      await this.dependencies.verify(this.releaseDir, this.release);
      return {
        kind: "ready",
        version: this.release.version,
        warning: null,
        runtimePath: this.displayPath,
      };
    } catch (error) {
      return {
        kind: "runtimeError",
        version: this.release.version,
        detail: `The managed Codex runtime could not be verified. ${messageOf(error)}`,
      };
    }
  }

  install(onProgress: (progress: RuntimeProgress) => void): Promise<ManagedCodexReady> {
    if (!this.installPromise) {
      this.installPromise = this.performInstall(onProgress).finally(() => {
        this.installPromise = null;
      });
    }
    return this.installPromise;
  }

  private readyState(): ManagedCodexReady {
    return { version: this.release.version, executable: this.executable };
  }

  private unsupportedReason(): string | null {
    if (this.dependencies.platform !== "darwin") {
      return "This CodexDesk preview currently supports macOS only.";
    }
    if (this.dependencies.arch !== "arm64") {
      return "This CodexDesk preview currently supports Apple-silicon Macs only.";
    }
    return null;
  }

  private async performInstall(
    onProgress: (progress: RuntimeProgress) => void,
  ): Promise<ManagedCodexReady> {
    const unsupported = this.unsupportedReason();
    if (unsupported) throw new Error(unsupported);

    await mkdir(path.join(this.rootDir, "releases"), { recursive: true });
    const temporary = await mkdtemp(path.join(this.rootDir, ".install-"));
    const archive = path.join(temporary, this.release.archiveName);
    const checksums = path.join(temporary, this.release.checksumsName);
    const payload = path.join(temporary, "payload");
    const backup = path.join(
      this.rootDir,
      `.previous-${this.release.version}-${Date.now()}`,
    );

    try {
      onProgress({
        stage: "checkingSource",
        downloadedBytes: 0,
        totalBytes: this.release.archiveBytes,
      });
      await this.dependencies.download(
        `${this.release.baseUrl}/${this.release.checksumsName}`,
        checksums,
        this.release.checksumsBytes,
      );
      await assertSha256(checksums, this.release.checksumsSha256);
      await assertChecksumManifest(checksums, this.release);

      await this.dependencies.download(
        `${this.release.baseUrl}/${this.release.archiveName}`,
        archive,
        this.release.archiveBytes,
        (downloadedBytes) =>
          onProgress({
            stage: "downloading",
            downloadedBytes,
            totalBytes: this.release.archiveBytes,
          }),
      );

      onProgress({
        stage: "verifying",
        downloadedBytes: this.release.archiveBytes,
        totalBytes: this.release.archiveBytes,
      });
      await assertSha256(archive, this.release.archiveSha256);
      await mkdir(payload);
      await this.dependencies.extract(archive, payload);
      await this.dependencies.verify(payload, this.release);

      onProgress({
        stage: "installing",
        downloadedBytes: this.release.archiveBytes,
        totalBytes: this.release.archiveBytes,
      });
      let movedPrevious = false;
      try {
        await rename(this.releaseDir, backup);
        movedPrevious = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      try {
        await rename(payload, this.releaseDir);
      } catch (error) {
        if (movedPrevious) await rename(backup, this.releaseDir);
        throw error;
      }
      if (movedPrevious) {
        await rm(backup, { recursive: true, force: true }).catch(() => {});
      }

      return this.readyState();
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function downloadFile(
  url: string,
  destination: string,
  expectedBytes?: number,
  onProgress?: (downloadedBytes: number) => void,
): Promise<void> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "releases.openai.com"
  ) {
    throw new Error("Refusing a runtime download outside releases.openai.com.");
  }

  let response: Response;
  try {
    response = await fetch(url, { redirect: "error" });
  } catch (error) {
    throw new Error(
      `Could not reach releases.openai.com. Check your internet connection and try again. (${messageOf(error)})`,
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(`OpenAI download failed with HTTP ${response.status}.`);
  }
  const contentLength = response.headers.get("content-length");
  const responseBytes = contentLength === null ? null : Number(contentLength);
  if (
    expectedBytes !== undefined &&
    responseBytes !== null &&
    Number.isFinite(responseBytes) &&
    responseBytes !== expectedBytes
  ) {
    throw new Error(
      `OpenAI download size changed (expected ${expectedBytes}, received ${responseBytes}).`,
    );
  }

  const file = await open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  let downloadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloadedBytes += value.byteLength;
      if (expectedBytes !== undefined && downloadedBytes > expectedBytes) {
        throw new Error("OpenAI download exceeded its pinned size.");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten === 0) throw new Error("The runtime download stalled.");
        offset += bytesWritten;
      }
      onProgress?.(downloadedBytes);
    }
  } finally {
    await file.close();
  }

  if (expectedBytes !== undefined && downloadedBytes !== expectedBytes) {
    throw new Error(
      `OpenAI download was incomplete (${downloadedBytes} of ${expectedBytes} bytes).`,
    );
  }
}

async function assertSha256(file: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`SHA-256 verification failed for ${path.basename(file)}.`);
  }
}

async function assertChecksumManifest(
  file: string,
  release: RuntimeRelease,
): Promise<void> {
  const text = await readFile(file, "utf8");
  const entry = text
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(`  ${release.archiveName}`));
  if (!entry || entry.trim().split(/\s+/)[0] !== release.archiveSha256) {
    throw new Error("OpenAI's checksum manifest does not match the pinned runtime.");
  }
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  const { stdout } = await run("/usr/bin/tar", ["-tzf", archive]);
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error("The runtime archive is empty.");
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (
      path.posix.isAbsolute(entry) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error("The runtime archive contains an unsafe path.");
    }
  }
  if (
    entries.length !== EXPECTED_ARCHIVE_ENTRIES.size ||
    entries.some((entry) => !EXPECTED_ARCHIVE_ENTRIES.has(entry))
  ) {
    throw new Error("The runtime archive layout does not match the pinned release.");
  }
  await run("/usr/bin/tar", ["-xzf", archive, "-C", destination]);
}

async function verifyPayload(
  payload: string,
  release: RuntimeRelease,
): Promise<void> {
  const packageFile = path.join(payload, "codex-package.json");
  const metadata = JSON.parse(await readFile(packageFile, "utf8")) as {
    layoutVersion?: number;
    version?: string;
    target?: string;
    entrypoint?: string;
    variant?: string;
    resourcesDir?: string;
    pathDir?: string;
  };
  if (
    metadata.layoutVersion !== 1 ||
    metadata.version !== release.version ||
    metadata.target !== release.target ||
    metadata.entrypoint !== "bin/codex" ||
    metadata.variant !== "codex" ||
    metadata.resourcesDir !== "codex-resources" ||
    metadata.pathDir !== "codex-path"
  ) {
    throw new Error("The runtime package metadata does not match this release.");
  }

  const executable = path.join(payload, "bin", "codex");
  const codeModeHost = path.join(payload, "bin", "codex-code-mode-host");
  for (const expectedFile of [
    executable,
    codeModeHost,
    path.join(payload, "codex-path", "rg"),
    path.join(payload, "codex-resources", "zsh", "bin", "zsh"),
  ]) {
    if ((await lstat(expectedFile)).isSymbolicLink()) {
      throw new Error("The runtime package contains an unexpected symbolic link.");
    }
  }
  await chmod(executable, 0o755);
  const { stdout } = await run(executable, ["--version"]);
  const reportedVersion = stdout.trim().match(/^codex-cli\s+(\S+)$/)?.[1];
  if (reportedVersion !== release.version) {
    throw new Error(`The runtime reported an unexpected version: ${stdout.trim()}`);
  }

  await verifyOpenAiSignature(executable, release.openAiTeamId);
  await verifyOpenAiSignature(codeModeHost, release.openAiTeamId);
}

async function verifyOpenAiSignature(
  executable: string,
  teamId: string,
): Promise<void> {
  await run("/usr/bin/codesign", ["--verify", "--strict", executable]);
  const signature = await run("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    executable,
  ]);
  if (!signature.stderr.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error("The runtime is not signed by the expected OpenAI team.");
  }
  if (!signature.stderr.includes("Authority=Developer ID Application: OpenAI")) {
    throw new Error("The runtime Developer ID authority is not OpenAI.");
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
