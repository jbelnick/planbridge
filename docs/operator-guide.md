# Operator Guide

This is the operator reference for running PlanBridge end to end. The
product and security background lives in [the product spec](PLANBRIDGE-SPEC.md)
and [the hardening guide](hardening.md).

## Guided ChatGPT Flow

New setup writes `tools.profile: guided`, which exposes the normal operator
surface:

```text
projects_list
prepare_plan
execute_plan
review_run
```

Use this prompt in a fresh ChatGPT Developer Mode conversation with the
PlanBridge connector enabled:

```text
Use PlanBridge to prepare a Pro-backed plan for my-project.
Objective: <what you want changed>. Do not execute yet.
```

Review the returned `plan_id`, `plan_hash`, and proposed plan. If the plan is
acceptable, approve it in plain language:

```text
Approved. Execute that plan.
```

After Codex completes, ask:

```text
Review the run and show me the diff.
```

The lower-level tools remain available in `advanced` and `legacy` profiles for
debugging, but the normal user should not need to call `context_pack`,
`pro_consult`, `codex_handoff`, `codex_status`, or `git_diff` directly.

## ChatGPT Surface Boundary

OpenAI's Developer Mode guide currently describes Developer Mode MCP app
support as a ChatGPT web surface:
`https://developers.openai.com/api/docs/guides/developer-mode`. The Apps SDK
testing guide separately recommends testing iOS and Android app layouts. The
observed PlanBridge failure boundary is the selected model surface, not phone
browser versus desktop browser:

- A fresh ChatGPT web conversation using `Extra High` successfully exposed and
  called PlanBridge.
- The same conversation switched to `Pro` or `Pro Extended` reported that
  PlanBridge tools were unavailable.
- Switching that conversation back to `Extra High` did not restore tool
  access; a new `Extra High` conversation did.

Treat `Pro` and `Pro Extended` as unsupported for PlanBridge Developer Mode
MCP invocation until OpenAI documents otherwise. For phone-only operation, use
`https://chatgpt.com/` in the phone browser, start a fresh chat, select
`Extra High` before the first PlanBridge prompt, and keep that conversation off
`Pro`.

For Pro reasoning without API calls, use the opt-in `pro_consult` bridge. It is
not direct Pro-to-MCP invocation; PlanBridge packages a sanitized context
bundle and Oracle opens ChatGPT browser mode against the configured logged-in
Chrome profile. See [the Pro consult threat
model](pro-consult-threat-model.md) before enabling it.

Golden prompt for validation:

```text
Use PlanBridge projects_list. Do not answer unless you called the PlanBridge tool.
```

Expected result: ChatGPT shows a tool call and returns only `my-project` at
`~/code/my-project`.

If a chat says a path outside the allowlist is unavailable or reports an empty
workspace, it did not invoke PlanBridge. Do not diagnose the local tunnel
first; start a fresh `Extra High` chat, select PlanBridge for the
conversation, and rerun the golden prompt.

## Build

```bash
npm ci
npm run build
```

`dist/` is ignored and generated locally. Build before using the package `bin`
or the `npm run serve` script.

## Setup

Safe local/read-only handoff-file mode:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --localhost
```

This writes `tools.profile: guided`. Add `--advanced-tools` only when you want
the low-level debug/primitives exposed to ChatGPT:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --localhost \
  --advanced-tools
```

Secure MCP Tunnel with Codex execution enabled:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --tunnel-id <secure-mcp-tunnel-id> \
  --execution-adapter codex-cli
```

Secure MCP Tunnel with Codex execution and Pro consult enabled:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --tunnel-id <secure-mcp-tunnel-id> \
  --execution-adapter codex-cli \
  --enable-pro-consult \
  --pro-consult-chrome-profile Default \
  --pro-consult-cookie-wait 10s
```

Public HTTPS fallback:

```bash
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api \
  --public-base-url https://<operator-managed-origin> \
  --access-control network
```

For public fallback, copy the printed bearer secret exactly once and install
it at the tunnel or proxy boundary. ChatGPT cannot send a custom static bearer
header to PlanBridge; if the tunnel/proxy cannot inject or enforce the secret,
do not use `public-url`.

## Doctor

```bash
npm run doctor
```

Doctor checks the config file, projects root, allowlisted project directories,
`rg`, and Codex readiness when `--execution-adapter codex-cli` is configured.
If `OPENAI_API_KEY` or `CODEX_API_KEY` is set, doctor fails because the
`codex-cli` adapter refuses API-key mode. When `pro_consult` is enabled,
doctor also checks `oracle --version` without launching the browser.

Doctor prints the recommended ChatGPT prompt for the guided workflow after the
checks.

## Pro Consult

`pro_consult` is disabled by default. When enabled, `prepare_plan` can use it
in guided mode, and it appears as a direct tool only in `advanced` or `legacy`
profiles. It lets PlanBridge consult GPT-5.5 Pro through browser subscription
mode.

For advanced/debug use, call it with explicit paths:

```text
Use PlanBridge pro_consult on project my-project with paths
["README.md", "docs/operator-guide.md"] and prompt "Review the current
operator flow and identify concrete gaps."
```

The caller will see a PlanBridge tool call, not a Pro chip beside PlanBridge.
The Pro work happens in Oracle's browser automation window using the
configured Chrome profile. See [the Pro consult threat
model](pro-consult-threat-model.md) for the full risk surface.

## Serve

```bash
npm run serve
```

The server binds `127.0.0.1` and serves Streamable HTTP at:

```text
http://127.0.0.1:<port>/mcp
```

Keep runtime keys, tunnel logs, public URLs with secrets, and session state
out of this source tree.

## Durable Local Service

For connector discovery and repeated ChatGPT calls, install the user
LaunchAgent:

```bash
npm run service:install
npm run service:status
```

The LaunchAgent label is `com.planbridge.server`. It runs `dist/src/cli.js
serve` with `RunAtLoad` and `KeepAlive`; logs stay under
`~/.planbridge/server`.

Control commands:

```bash
npm run service:start
npm run service:restart
npm run service:stop
npm run service:uninstall
```

## Secure MCP Tunnel

Install the current OpenAI `tunnel-client` binary into ignored runtime
storage:

```bash
npm run tunnel:install
```

PlanBridge stores the selected Secure MCP Tunnel id, but it does not create
tunnel credentials. The tunnel id must match `tunnel_` followed by 32
lowercase hex characters. The tunnel runtime needs `CONTROL_PLANE_API_KEY` set
to a runtime key with Tunnels Read + Use for the selected tunnel id.

Create or refresh the local HTTP profile after `planbridge setup
--tunnel-id`:

```bash
npm run tunnel:init
```

With `npm run serve` running in another shell, or the LaunchAgent installed,
validate the tunnel profile:

```bash
npm run tunnel:doctor
```

When the service is installed, `npm run tunnel:doctor` checks the LaunchAgent
served endpoint through `127.0.0.1:<port>/mcp`. Then run the tunnel daemon:

```bash
npm run tunnel:run
```

Check the local tunnel admin surface:

```bash
npm run tunnel:status
```

For a durable tunnel daemon, store the runtime key in ignored runtime storage:

```text
~/.planbridge/tunnel-client/control-plane-api-key
```

The file must be readable only by the local operator (`0600`). The durable
tunnel service rewrites the tunnel profile to reference that file instead of
storing the key in launchd environment variables:

```bash
npm run tunnel:service:install
npm run tunnel:service:status
```

The durable tunnel LaunchAgent label is `com.planbridge.tunnel`, and its
runtime lives under `~/.planbridge/tunnel-client`. Control commands:

```bash
npm run tunnel:service:start
npm run tunnel:service:restart
npm run tunnel:service:stop
npm run tunnel:service:uninstall
```

Use connector-layer "No authentication" for Secure MCP Tunnel mode; the tunnel
principal is the access boundary.

OpenAI's Secure MCP Tunnel guide is the current platform source for tunnel
ids, runtime keys, and `tunnel-client` operation:
`https://developers.openai.com/api/docs/guides/secure-mcp-tunnels`.

## Runtime Layout

All PlanBridge runtime state lives under `~/.planbridge` (override with
`PLANBRIDGE_RUNTIME_DIR`):

- `~/.planbridge/config.json` — connector config.
- `~/.planbridge/server` — server logs and state.
- `~/.planbridge/tunnel-client` — tunnel-client runtime (override with
  `PLANBRIDGE_TUNNEL_RUNTIME`).
- `~/.planbridge/tunnel-client/control-plane-api-key` — runtime API key file
  (`0600`).

## Codex Handoff Flow

1. In ChatGPT, inspect context with `projects_list`, `project_summary`,
   `repo_search`, `repo_read_files`, `context_pack`, and `git_status`.
2. Have ChatGPT produce an explicit plan for user approval.
3. Invoke `codex_handoff` only after approval.
4. Use `codex_status` to watch the run.
5. Use `git_diff` to review the isolated worktree diff.
6. Start a follow-up handoff only after reviewing that diff.

`codex-cli` creates isolated worktrees and never auto-merges. The human
reviews and decides what to merge or discard.

## Live Validation Checklist

- `npm run build`
- `npm test`
- `npm run doctor`
- `npm run serve`
- ChatGPT connector lists exactly nine tools.
- `context_pack` returns a bounded, redacted bundle.
- `codex_handoff` returns a handoff handle and, in `codex-cli` mode, a run
  handle.
- `codex_status` reaches a terminal state.
- `git_diff` returns the run worktree diff without mutating the worktree.
- A follow-up `codex_handoff` can reference the reviewed diff.
