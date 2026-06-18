# PlanBridge

[![Verify](https://github.com/jbelnick/planbridge/actions/workflows/verify.yml/badge.svg)](https://github.com/jbelnick/planbridge/actions/workflows/verify.yml)

PlanBridge is a local [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) connector that lets ChatGPT plan over an allowlisted development
workspace, then hand an explicitly approved plan to Codex for isolated
implementation.

It is designed as a practical agent-control system: narrow local context,
bounded/redacted tool responses, stable plan hashes, explicit human approval,
Codex execution in a git worktree, and a review loop that returns status plus a
secret-redacted diff.

## What It Shows

- A production-shaped MCP server with profile-based tool surfaces for ChatGPT.
- Local workspace exposure that is allowlisted, bounded, audited, and
  fail-closed.
- A guided workflow facade over lower-level primitives:
  `prepare_plan -> execute_plan -> review_run`.
- Subscription-first Codex execution in isolated worktrees, with no auto-merge.
- Optional GPT-5.5 Pro browser-subscription consultation through Oracle, kept
  opt-in because it uses browser state and subscription quota.
- Offline verification: typecheck, build, fixture smoke, and 173 automated
  tests covering tool I/O, redaction, access control, hardening, execution, and
  guided workflows.

## Normal ChatGPT Flow

Start PlanBridge locally and connect it in a ChatGPT Developer Mode
conversation. Then use this flow:

```text
Use PlanBridge to prepare a Pro-backed plan for my-api.
Objective: simplify the authentication middleware and add focused tests.
Do not execute yet.
```

PlanBridge returns a stored `plan_id`, `plan_hash`, proposed Codex handoff, and
the exact next call shape. After reviewing the plan:

```text
Approved. Execute that plan.
```

After Codex finishes:

```text
Review the run and show me the diff.
```

The user should not need to know the low-level choreography (`context_pack`,
`pro_consult`, `codex_handoff`, `codex_status`, `git_diff`) for normal use.

## How It Works

```text
ChatGPT                     PlanBridge on your machine                 Codex
   |                                   |                                  |
   | prepare_plan                      |                                  |
   |---------------------------------->| bounded context + optional Pro    |
   |<----------------------------------| plan_id + sha256 plan_hash        |
   |                                   |                                  |
   | execute_plan after approval       |                                  |
   |---------------------------------->| hash/stale/duplicate gates         |
   |                                   | codex exec in isolated worktree -->|
   |                                   |                                  |
   | review_run                        |                                  |
   |---------------------------------->| codex_status + redacted git_diff   |
   |<----------------------------------| status, changed files, bounded diff|
```

The MCP server binds to `127.0.0.1`. Remote ChatGPT access requires a configured
Secure MCP Tunnel or an operator-managed HTTPS tunnel with access control.

## Tool Profiles

| Profile | Purpose | Tools |
|---|---|---|
| `guided` | Default for new setup. Best ChatGPT UX. | `projects_list`, `prepare_plan`, `execute_plan`, `review_run` |
| `advanced` | Guided workflow plus debugging and direct primitives. | Guided tools plus `project_summary`, `repo_search`, `repo_read_files`, `context_pack`, `git_status`, `pro_consult` when enabled, `codex_handoff`, `codex_status`, `git_diff` |
| `legacy` | Existing installed configs with no `tools.profile`. | Original flat tool surface, plus optional `pro_consult` |

`prepare_plan` writes a private plan artifact under the operator's PlanBridge
home and returns a stable hash. `execute_plan` refuses to run unless the approved
hash matches the stored plan, the repo base has not drifted, the plan has not
already been executed, and explicit approval text is present.

## Quick Start

Prerequisites:

- Node.js 22 or newer.
- `ripgrep` (`rg`) available on `PATH`.
- Codex subscription login if using the `codex-cli` execution adapter.
- Optional: Oracle + a logged-in Chrome profile for GPT-5.5 Pro browser
  consultation.

```bash
npm ci
npm run build
npm test
```

Create a local config with the guided tool profile:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api,my-web \
  --localhost
```

Enable Codex execution in isolated worktrees:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --tunnel-id <secure-mcp-tunnel-id> \
  --execution-adapter codex-cli
```

Expose the advanced/debug tool surface only when you want direct access to the
low-level tools:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --localhost \
  --advanced-tools
```

Run the connector and inspect readiness:

```bash
npm run serve
npm run doctor
```

`npm run doctor` prints connector checks and a copy-paste ChatGPT prompt for the
guided workflow.

## Security Model

PlanBridge treats local workspace exposure as a real trust boundary.

- Project-root allowlist. No default access to `$HOME` or arbitrary filesystem
  paths.
- Deny paths for `.git`, `.env`, SSH keys, PEM files, token files, and other
  common secret surfaces.
- `.gitignore` exclusion plus content redaction for credential prefixes and
  high-entropy strings.
- Size limits for files, search results, context bundles, diffs, and sessions.
- Fail-closed public transport: public URLs require access control, and the
  self-probe hard-alerts if a public endpoint is reachable unauthenticated.
- Metadata-only audit logs with retention/rotation.
- Codex execution refuses API-key mode for the subscription-first adapter.
- Codex work lands in an isolated worktree and is never auto-merged.

The Pro consult bridge is intentionally opt-in because it uses browser state and
subscription quota.

## Examples

- [examples/config.localhost.example.json](examples/config.localhost.example.json)
- [examples/context-pack.example.json](examples/context-pack.example.json)
- [examples/handoff.example.md](examples/handoff.example.md)

These examples are redacted/static and do not require ChatGPT, a tunnel, Oracle,
or a live Codex run.

## Status And Evidence

Implemented milestones:

- M1: read-only MCP server and core project/repo tools.
- M2: reproducible context packs and git status.
- M3: approved Codex handoff plus `handoff-file` and `codex-cli` adapters.
- M4: status and bounded, redacted diff review for Codex worktrees.
- M5: hardening, network-secret runtime, self-probe, audit retention, and threat
  matrix tests.
- Guided workflow: `prepare_plan`, `execute_plan`, `review_run`, persistent plan
  store, plan hashes, stale-plan refusal, duplicate-execution refusal, and tool
  profiles.

Verification:

```bash
npm run typecheck
npm test
npm run smoke:fixtures
npm run build
```

## License

[MIT](LICENSE) © Jason Belnick
