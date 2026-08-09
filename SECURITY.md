# Security Policy

## Supported versions

Security fixes are provided for the latest 0.1.x release and the latest `main`
branch.

## Managed Codex runtime

CodexDesk does not execute a `codex` discovered on `PATH`. It downloads one
pinned Apple-silicon standalone package over HTTPS from
`releases.openai.com`, verifies fixed package and checksum-manifest SHA-256
digests, validates the package metadata and exact version, and requires the
Codex executable and code-mode host to carry OpenAI's Developer ID signature.
Only then is the payload atomically installed in CodexDesk's application-data
directory and launched by absolute path.

Runtime version and artifact digests are release inputs. Changes to them should
be reviewed together with regenerated app-server protocol bindings.

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue.

Use the repository's **Security → Advisories → Report a vulnerability** flow:

https://github.com/QIU-Shuo/codexdesk/security/advisories/new

If the private reporting button is unavailable, open an issue containing no
vulnerability details and ask the maintainer to establish a private contact
channel.

Include affected versions, reproduction steps, impact, and any suggested
mitigation. Please allow the maintainer a reasonable opportunity to investigate
and release a fix before public disclosure.
