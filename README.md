# CodexDesk

An independent desktop client for the Codex app-server interface. It keeps
projects, conversations, files, terminals, approvals, and Codex capabilities
in one local Electron workspace.

![CodexDesk new chat screen](assets/codexdesk.png)

> [!IMPORTANT]
> CodexDesk is an early preview. It currently expects an existing Codex CLI
> installation and the packaged release configuration is macOS-first.

## Highlights

- Organize Codex conversations by project, with pinning, archiving, search,
  multiple windows, and a global quick-chat shortcut.
- Start work locally or in an isolated Git worktree, optionally from a chosen
  branch.
- Follow streaming Markdown, tool activity, plans, approval requests, and
  attached images in a native desktop conversation view.
- Browse workspace files, open file references, and keep terminals attached to
  their conversations.
- Inspect and configure skills, plugins, MCP servers, and web-search behavior
  exposed by Codex.
- Keep privileged operations in Electron's main process behind a narrow preload
  API; the renderer has no direct Node.js access.

## Requirements

- macOS for the currently configured packaged build. Development on Windows and
  Linux is welcome but is not yet part of the release matrix.
- Node.js 22.12 or newer and npm.
- Git.
- [Codex CLI](https://developers.openai.com/codex/cli) 0.144.4 or newer,
  available as `codex` on `PATH` and signed in.

Check the CLI before starting:

```sh
codex --version
codex login
```

The app does not bundle Codex. It launches `codex app-server` locally and uses
its stdio JSON-RPC transport.

See [Privacy](PRIVACY.md), [Support](SUPPORT.md), and the
[Security policy](SECURITY.md) before using the preview with sensitive source
code.

## Run from source

```sh
git clone https://github.com/QIU-Shuo/codexdesk.git
cd codexdesk/app
npm install
npm start
```

The first launch asks you to choose a project folder. Authentication and model
access come from the installed Codex CLI.

## Development

The application lives in `app/` and uses Electron Forge, Vite, React, and
TypeScript.

```sh
cd app
npm run verify   # architecture checks, typechecks, and unit tests
npm run package  # build an unpacked application bundle
npm run make     # create the configured distributable
```

Changes in the first preview are summarized in the
[CodexDesk 0.1.0 release notes](RELEASE_NOTES.md).

The committed protocol bindings were generated with Codex CLI 0.144.4. When
updating the app-server protocol, use the matching CLI and update the version
constants in `app/src/main/preflight.ts` in the same change:

```sh
cd app
npm run protocol:generate
```

## Security and trust model

CodexDesk is a local client, but it is not a sandbox by itself:

- Codex tools and the integrated terminal can execute commands on your machine.
  Review approval requests and use an appropriate Codex permission profile.
- Git worktrees reduce interference between tasks; they are not a security
  boundary.
- Authentication is owned by Codex. CodexDesk does not ask for or persist an
  OpenAI API key itself.
- Filesystem and process access stay in Electron's main process. The renderer
  uses context isolation, no Node integration, a restrictive Content Security
  Policy, and explicit IPC operations.
- Project file reads are confined to registered workspace and worktree roots;
  attachment image reads use a separate narrow allow-list.

Please report suspected vulnerabilities privately to the maintainer instead of
opening a public exploit report.

## Project status

CodexDesk has a permanent macOS bundle identifier, Developer ID signing and
notarization tooling, and a draft-only release workflow. The initial preview
target is macOS arm64. Binary releases remain explicit maintainer-controlled
actions; source builds and packaged development builds are also supported.

## Independence from OpenAI

CodexDesk is not affiliated with, endorsed by, or sponsored by OpenAI.
Codex and OpenAI are trademarks of their respective owner. References to them
describe compatibility with the public Codex app-server interface.

## License

Original CodexDesk code is licensed under the [MIT License](LICENSE).
Generated TypeScript protocol definitions under `app/src/protocol/generated/`
remain under Apache License 2.0; see [NOTICE](NOTICE) and
[THIRD_PARTY_LICENSES/Apache-2.0.txt](THIRD_PARTY_LICENSES/Apache-2.0.txt).
React Symbols file and folder icons remain under the MIT License; see
[THIRD_PARTY_LICENSES/React-Symbols-MIT.txt](THIRD_PARTY_LICENSES/React-Symbols-MIT.txt).
Complete production npm dependency notices are generated at
[THIRD_PARTY_LICENSES/npm-production-notices.txt](THIRD_PARTY_LICENSES/npm-production-notices.txt),
and packaged Electron builds include Chromium's full notices.
