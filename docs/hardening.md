# Hardening Guide

This guide documents PlanBridge's network/transport hardening layer against [the product spec](PLANBRIDGE-SPEC.md). It is the operator reference for running the connector safely.

## Trust Boundary Modes

PlanBridge has three connection modes:

- `localhost`: binds to `127.0.0.1` and is intended for same-machine use.
- `secure-tunnel`: the default remote path; delegates remote access control to the Secure MCP Tunnel.
- `public-url`: fallback public-tunnel mode; may be used only with explicit access control. In this build, `--access-control network` is the only implemented public-url access-control mode.

OAuth remains a forward-compatible config enum value, but OAuth runtime support is out of scope for this build. Setup and server startup refuse `public-url` plus `auth.mode: "oauth"` with: `OAuth runtime is not implemented in this build; use --access-control network or the Secure MCP Tunnel.`

## Network Secret

`planbridge setup --access-control network` generates a 256-bit random bearer secret, prints the plaintext exactly once, and stores only a sha256 hash in `~/.planbridge/config.json`.

Operators must install the plaintext bearer secret at the tunnel or network boundary. PlanBridge never writes the plaintext secret to config or audit logs. If `secretHash` is absent in an older or hand-edited network config, runtime auth fails closed with `401`, but the self-probe treats that `401` as healthy and will not alert while the operator is locked out. Re-run setup to generate and install a fresh network secret.

## Rate Limiting

The network fallback uses an in-memory throttle keyed only by `req.ip`. Express trust proxy stays off and `X-Forwarded-For` is never trusted.

Behind some public tunnels, every client may collapse to `127.0.0.1`, so this is a GLOBAL throttle. The 15-minute lockout after repeated failures is an accepted self-denial-of-service tradeoff for the public fallback.

## Self-Probe

For `public-url` plus network access control, PlanBridge periodically sends an unauthenticated MCP `initialize` request to the configured public `/mcp` URL. A JSON-RPC result containing `protocolVersion` and `serverInfo` means the public endpoint is reachable without access control.

The self-probe requires two consecutive breaches before tripping. Once tripped, it latches, returns `503 E_SELF_PROBE_OPEN`, writes a metadata-only audit event, and emits a critical stderr line. It never auto-clears. Recovery is: remediate the tunnel or network secret, then RESTART PlanBridge.

## Audit Retention

Audit logs stay under `~/.planbridge`. PlanBridge rotates the audit log at 8 MiB, keeps up to 5 rotated files, prunes rotations older than 90 days, writes new log files with `0600`, and treats rotation failures as non-fatal.

Security audit events are metadata-only. Auth failures record `E_AUTH_FAILED` or `E_AUTH_RATE_LIMITED`; self-probe trips record `E_SELF_PROBE_OPEN`. Secrets, bearer headers, rate state, and probe response bodies are not written to the audit log.

## Residual Risk

The public-url network fallback is a last-resort mode, not a substitute for the Secure MCP Tunnel. Section 9.5 residual risks remain:

- A misconfigured tunnel can still expose PlanBridge until auth and self-probe stop serving.
- Rate limiting is process-local and resets on restart.
- The global throttle can lock out legitimate users when many clients share one source IP.
- `likely_files` remains advisory-only handoff text and is not resolved to the filesystem.
- The self-probe only probes the configured public connector URL, so it is an internal reachability check and not an SSRF primitive.
- Content redaction is best effort; repository content can still be attacker-authored.
- PlanBridge remains a single-operator tool, not a multi-tenant authorization system.
