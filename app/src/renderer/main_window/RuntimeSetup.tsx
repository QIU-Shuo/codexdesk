import { useState } from "react";
import type { PreflightState, RuntimeInstallStage } from "../../shared/ipc";

const STAGE_LABELS: Record<RuntimeInstallStage, string> = {
  checkingSource: "Checking the official OpenAI release…",
  downloading: "Downloading Codex…",
  verifying: "Verifying checksum and OpenAI signature…",
  installing: "Finishing installation…",
};

export function RuntimeSetup({ state }: { state: PreflightState }) {
  const [requesting, setRequesting] = useState(false);
  const installing = state.kind === "runtimeInstalling";
  const canInstall =
    state.kind === "runtimeMissing" || state.kind === "runtimeError";
  const version = "version" in state ? state.version : null;
  const totalBytes =
    state.kind === "runtimeMissing"
      ? state.sizeBytes
      : installing
        ? state.totalBytes
        : 0;
  const downloadedBytes = installing ? state.downloadedBytes : 0;
  const progress =
    installing && state.stage !== "checkingSource" && totalBytes > 0
      ? Math.min(100, (downloadedBytes / totalBytes) * 100)
      : 0;

  const install = async () => {
    setRequesting(true);
    try {
      await window.codexDesk.installRuntime();
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="runtime-setup" aria-live="polite">
      <div className="runtime-setup-card">
        <div className="runtime-mark" aria-hidden="true">
          <span />
        </div>
        <p className="runtime-eyebrow">One-time setup</p>
        <h1>Install Codex for CodexDesk</h1>
        <p className="runtime-intro">
          CodexDesk uses its own verified Codex runtime. It won&apos;t use or
          change any Codex CLI already installed on this Mac.
        </p>

        <div className="runtime-facts">
          <div>
            <span>Source</span>
            <strong>Official OpenAI release</strong>
          </div>
          <div>
            <span>Version</span>
            <strong>{version ?? "Checking…"}</strong>
          </div>
          <div>
            <span>Download</span>
            <strong>{formatBytes(totalBytes)}</strong>
          </div>
        </div>

        {state.kind === "checking" && (
          <div className="runtime-status">
            <span className="runtime-spinner" aria-hidden="true" />
            Checking the managed runtime…
          </div>
        )}

        {installing && (
          <div className="runtime-progress-wrap">
            <div className="runtime-status">
              <span className="runtime-spinner" aria-hidden="true" />
              <span>{STAGE_LABELS[state.stage]}</span>
              {state.stage === "downloading" && (
                <span className="runtime-progress-copy">
                  {formatBytes(downloadedBytes)} of {formatBytes(totalBytes)}
                </span>
              )}
            </div>
            <div
              className={`runtime-progress${
                state.stage === "checkingSource" ? " indeterminate" : ""
              }`}
              role="progressbar"
              aria-label="Codex runtime installation"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {state.kind === "runtimeError" && (
          <div className="runtime-error" role="alert">
            <strong>Installation needs attention</strong>
            <span>{state.detail}</span>
          </div>
        )}

        {canInstall && (
          <button
            type="button"
            className="primary runtime-install"
            disabled={requesting}
            onClick={() => void install()}
          >
            {requesting
              ? "Starting…"
              : state.kind === "runtimeError"
                ? "Retry installation"
                : "Install Codex runtime"}
          </button>
        )}

        <p className="runtime-footnote">
          The download is checksum-verified, checked for OpenAI&apos;s Developer
          ID signature, and stored only in CodexDesk&apos;s application data. You
          sign in with your own account next.
        </p>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const mib = bytes / 1024 / 1024;
  return `${mib >= 100 ? Math.round(mib) : mib.toFixed(1)} MB`;
}
