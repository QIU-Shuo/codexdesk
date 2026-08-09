import { useState } from "react";
import type { LoginState } from "../../shared/ipc";

/**
 * Signing in from inside the app (plan §8.5).
 *
 * Before this, a signed-out install told the user to run `codex login` in a
 * terminal — fine on a machine where that had already happened, useless the
 * first time someone installs the app.
 *
 * Two methods ship. **ChatGPT** opens a browser and finishes asynchronously:
 * `account/login/start` only returns an `authUrl`, and the outcome arrives
 * later as `account/login/completed`. That gap is why `LoginState` has an
 * `awaitingBrowser` case — without it, clicking Sign in looks like it did
 * nothing while the browser tab sits open. **API key** succeeds or fails on
 * the spot.
 *
 * `chatgptDeviceCode` exists in the protocol and is deliberately not built:
 * neither we nor the owner can exercise it here, and an untestable path is
 * how bugs ship. `amazonBedrock` appears in the plan but is *not* in the
 * installed CLI's union at all.
 */
export function SignIn({
  login,
  requiresOpenaiAuth,
  onStart,
  onCancel,
}: {
  login: LoginState;
  requiresOpenaiAuth: boolean;
  onStart: (method: { kind: "chatgpt" } | { kind: "apiKey"; apiKey: string }) => void;
  onCancel: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState("");

  if (login.kind === "awaitingBrowser") {
    return (
      <div className="signin awaiting">
        <div className="signin-body">
          <strong>Finish signing in in your browser.</strong>
          <p className="hint">
            We opened a tab for you. If it did not open,{" "}
            <a href={login.authUrl} target="_blank" rel="noreferrer">
              use this link
            </a>
            .
          </p>
        </div>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  const busy = login.kind === "starting";

  return (
    <div className="signin">
      <div className="signin-body">
        <strong>
          {requiresOpenaiAuth ? "Sign in to use Codex" : "Not signed in"}
        </strong>
        {login.kind === "failed" && (
          <p className="signin-error">{login.message}</p>
        )}
        {showKey && (
          <div className="signin-key">
            <input
              type="password"
              value={apiKey}
              autoFocus
              placeholder="sk-…"
              aria-label="API key"
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKey.trim()) {
                  onStart({ kind: "apiKey", apiKey: apiKey.trim() });
                }
                if (e.key === "Escape") setShowKey(false);
              }}
            />
            <button
              className="primary"
              disabled={busy || !apiKey.trim()}
              onClick={() => onStart({ kind: "apiKey", apiKey: apiKey.trim() })}
            >
              Use key
            </button>
          </div>
        )}
      </div>

      <div className="signin-actions">
        {!showKey && (
          <button className="ghost" onClick={() => setShowKey(true)}>
            Use an API key
          </button>
        )}
        <button
          className="primary"
          disabled={busy}
          onClick={() => onStart({ kind: "chatgpt" })}
        >
          {busy ? "Starting…" : "Sign in with ChatGPT"}
        </button>
      </div>
    </div>
  );
}
