# CodexDesk privacy

CodexDesk is a local desktop client. The project does not operate a CodexDesk
cloud service, analytics endpoint, advertising system, or crash-reporting
backend.

## Data handled by Codex

CodexDesk starts its app-managed `codex app-server` process and sends your
prompts, selected workspace context, tool responses, and configuration to that
local process. Codex then handles service authentication and any data sent to
OpenAI under the terms and data controls for your Codex account.

On first launch, and again only when you explicitly retry or reinstall it,
CodexDesk downloads a pinned Codex runtime from `releases.openai.com`. That
request exposes ordinary network metadata such as your IP address and request
time to the download host. CodexDesk verifies the downloaded checksum, package
metadata, version, and OpenAI Developer ID signature before use. It does not
search for, select, modify, or report other Codex installations on your Mac.

CodexDesk does not persist an OpenAI API key. If you choose API-key sign-in,
the value entered in CodexDesk is sent directly to the local managed runtime;
Codex owns the resulting authentication files and account controls. See
OpenAI's current
[Codex data guidance](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits)
for account-specific details.

Skills, plugins, MCP servers, web search, and other capabilities exposed by
Codex may contact additional services. Their behavior and privacy terms are
outside CodexDesk's control; review them before enabling them.

## Data stored locally by CodexDesk

CodexDesk stores interface preferences and working state such as projects,
drafts, pane geometry, window state, and conversation presentation metadata in
Electron's application-data directory. On a fresh macOS install this is:

```text
~/Library/Application Support/CodexDesk
```

An installation migrated from the former Occo build may continue using
`~/Library/Application Support/occo-desktop` so existing settings are not lost.
The managed runtime is stored below that application-data directory under
`runtime/codex/releases/<version>`. It is executable code supplied by OpenAI,
not part of the CodexDesk app bundle. Account, configuration, plugin, and
conversation data used by Codex remain in Codex's normal `~/.codex` storage so
sign-in can be shared with other Codex clients.

CodexDesk does not intentionally transmit telemetry or crash reports. Ordinary
diagnostic messages may still appear in local terminal, Electron, or macOS
system logs.

## Files, commands, and updates

- File browsing is limited to project and worktree roots registered with the
  app, plus explicitly attached image files.
- Integrated terminals and approved Codex tools can execute commands with your
  user account's permissions. A Git worktree is not a security sandbox.
- Packaged public releases may request a credential-free HTTPS update manifest.
  The update host will receive normal network metadata such as your IP address
  and request time. Development builds and private release candidates have
  automatic updates disabled; canary builds use a separate test channel.

## Deleting local data

Quit CodexDesk, then remove its application-data directory to reset the app and
delete its managed runtime. Delete `~/.codex` separately only if you also
intend to remove shared Codex account, configuration, and conversation data
used by other Codex clients on the machine.

## Questions

For non-sensitive privacy or support questions, use the repository's GitHub
Issues page. Do not put private workspace content, credentials, or vulnerability
details in a public issue. Follow [SECURITY.md](SECURITY.md) for confidential
security reports.
