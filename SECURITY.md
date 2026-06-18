# Security Policy

## Security model

PlanBridge is a local tool that exposes a single allowlisted
development workspace to a remote MCP surface. That exposure is the
trust boundary the design takes seriously. The connector binds to
`127.0.0.1`; remote access goes through the Secure MCP Tunnel or an
operator-managed HTTPS tunnel with access control, never a raw open
port. Tools are read-only by default, and responses are bounded and
redacted: project-root allowlisting, deny paths for `.git`, `.env`,
SSH keys, PEM and token files, `.gitignore` exclusion, credential and
high-entropy redaction, and size caps on files, search results,
context bundles, diffs, and sessions. Public transport fails closed —
a public URL requires access control, and a self-probe hard-alerts and
latches if a public endpoint is ever reachable unauthenticated. Codex
execution is subscription-first and runs in an isolated git worktree;
its output is reviewed as a status plus a secret-redacted diff and is
never auto-merged.

For the transport, network-secret, self-probe, audit-retention, and
residual-risk detail, see [docs/hardening.md](docs/hardening.md). For
the consultation bridge trust analysis, see
[docs/pro-consult-threat-model.md](docs/pro-consult-threat-model.md).

## Reporting a vulnerability

Please report security issues privately through GitHub private
security advisories:

  https://github.com/jbelnick/planbridge/security/advisories/new

Do not open a public issue for a sensitive report. Use the private
advisory flow so the problem can be triaged and fixed before any
public discussion. A short description, affected version or commit,
and steps to reproduce are enough to get started.

## Supported versions

PlanBridge is a single-operator tool, not a multi-tenant service. It
tracks `main`, and fixes land there. There are no separately
maintained release branches; run a current `main` checkout to get the
latest security fixes.
