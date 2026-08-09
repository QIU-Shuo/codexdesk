# CodexDesk privacy

CodexDesk is a local desktop client. The project does not operate a CodexDesk
cloud service, analytics endpoint, advertising system, or crash-reporting
backend.

## Data handled by Codex

CodexDesk starts the separately installed `codex app-server` process and sends
your prompts, selected workspace context, tool responses, and configuration to
that local process. Codex then handles service authentication and any data sent
to OpenAI under the terms and data controls for your Codex account.

CodexDesk does not ask for or persist an OpenAI API key. Authentication files,
conversation storage owned by Codex, and OpenAI account controls remain the
responsibility of the installed Codex CLI. See OpenAI's current
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

An installation migrated from the former Occo preview may continue using
`~/Library/Application Support/occo-desktop` so existing settings are not lost.
The separately installed Codex CLI has its own storage locations.

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

Quit CodexDesk, then remove its application-data directory to reset the app.
Delete Codex CLI data separately only if you also intend to affect other Codex
clients on the machine.

## Questions

For non-sensitive privacy or support questions, use the repository's GitHub
Issues page. Do not put private workspace content, credentials, or vulnerability
details in a public issue. Follow [SECURITY.md](SECURITY.md) for confidential
security reports.
