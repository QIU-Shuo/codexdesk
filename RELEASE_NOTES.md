# CodexDesk 0.1.0 release notes

CodexDesk 0.1.0 is the first macOS arm64 preview of the local desktop client for
the Codex app-server interface.

## Highlights

- Keep conversations organized by repository, recency, pin, archive, and
  attention state.
- Follow the full Codex trajectory: reasoning, plans, tools, edits, approvals,
  queued follow-ups, and steering appear in one compact transcript.
- Work beside a repository tree, file viewer, and conversation-scoped terminal
  without covering the chat surface.
- Choose model, reasoning effort, and approval mode directly from the composer.
- Start from a project overview, a local checkout, or an isolated Git worktree.
- Mention files with `@`, invoke supported composer actions with `/`, and keep
  drafts and layout state across restarts.
- Review the documented local-data, filesystem, terminal, and update behavior
  before using the preview with sensitive repositories.

## Requirements

- Apple-silicon Mac (`arm64`)
- A signed-in Codex account

On first launch, CodexDesk downloads its pinned Codex 0.144.4 runtime directly
from OpenAI (about 111 MB), verifies its checksum and OpenAI signature, and
keeps it separate from any system Codex installation.

## Preview limitations

- x64 and universal macOS builds are not yet tested release targets.
- CodexDesk does not bundle Codex or provide an additional sandbox. First
  launch therefore requires an internet connection for the managed-runtime
  download.
- Automatic updates begin after installing a signed release; the DMG remains
  the recommended first-install format.
- The development toolchain retains one accepted high-severity advisory chain
  rooted in an unpublished `nanoid` 3.x patch. It is excluded from production
  packages and guarded by an exact CI allow-list; production dependencies have
  no reported vulnerabilities.

CodexDesk is an independent project and is not affiliated with, endorsed by, or
sponsored by OpenAI.

See the repository's [privacy](PRIVACY.md), [support](SUPPORT.md), and
[security](SECURITY.md) documentation for
reporting and data-handling details.
