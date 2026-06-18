# Contributing to PlanBridge

Thanks for your interest in PlanBridge. This guide covers how to set
up a development environment, the verification gates every change must
pass, and the design boundaries that keep the ChatGPT-facing MCP
surface safe.

PlanBridge is a local Model Context Protocol (MCP) connector that lets
ChatGPT plan over an allowlisted local dev workspace and hand the
approved plan to Codex. Because it exposes local source to an external
agent, contributions are held to a tight security bar — read the
[Design boundaries for changes](#design-boundaries-for-changes)
section before proposing tool or transport changes.

## Prerequisites

- **Node.js 22 or newer.** The package declares
  `engines.node >= 22.0.0`.
- **`ripgrep` (`rg`) on your `PATH`.** The `repo_search` tool shells
  out to `rg`, and the same dependency is installed in CI.

Verify your toolchain:

```bash
node --version   # v22.x or newer
rg --version
```

## Setup

Install dependencies from the lockfile so your tree matches CI:

```bash
npm ci
```

Use `npm ci` (not `npm install`) for a clean, reproducible install.
CI installs the same way, so it is the closest match to the
environment your change will be verified in.

## Verification gates

Every change must pass all four gates locally before you open a pull
request. Run them in this order:

```bash
npm run typecheck       # tsc --noEmit, full type check
npm run build           # tsc -p tsconfig.json, emits dist/
npm test                # vitest run, full test suite
npm run smoke:fixtures  # static fixture smoke test, no network
```

What each gate covers:

- **`npm run typecheck`** — strict type checking with no emit. Keep
  the type surface strong; do not weaken types to silence an error.
- **`npm run build`** — compiles TypeScript to `dist/`. The CLI and
  service entrypoints run from the build output.
- **`npm test`** — the full automated suite, including tool I/O,
  redaction, access control, hardening, and execution paths.
- **`npm run smoke:fixtures`** — runs the fixture smoke test against
  redacted/static fixtures. It does not need ChatGPT, a tunnel, or a
  live Codex run.

If you cannot run a gate, say so explicitly in your pull request
rather than claiming it passed.

## Continuous integration

The **Verify** workflow runs on every push and pull request to
`main`. It installs `ripgrep`, sets up Node 22, runs `npm ci`, then
runs `npm run build` followed by `npm test`. CI must stay green:
pull requests with a failing Verify run will not be merged. Run the
gates above locally first so CI does not surface failures you could
have caught.

## Design boundaries for changes

PlanBridge treats local workspace exposure as a real trust boundary.
The following provider-neutral principles are non-negotiable. A change
that crosses any of them needs a written threat model in the pull
request before it can be reviewed.

- **Read-only by default on the ChatGPT-facing MCP surface.** Tools
  exposed to the external agent default to read-only. Anything that
  mutates state is gated behind explicit approval and bounded scope.
- **No arbitrary capability tools without a threat model.** Do not add
  arbitrary shell execution, unrestricted file writes, credential
  reads, or secret-management tools to the MCP surface without a
  written threat model describing the new attack surface and its
  mitigations.
- **Runtime state stays out of the source tree.** Public URLs,
  tunnels, tokens, and other runtime state must never be committed.
  Runtime lives under `~/.planbridge` (override with the
  `PLANBRIDGE_RUNTIME_DIR` environment variable):
  - server logs and state in `~/.planbridge/server`
  - tunnel-client runtime in `~/.planbridge/tunnel-client`
    (override with `PLANBRIDGE_TUNNEL_RUNTIME`)
  - the runtime API key in
    `~/.planbridge/tunnel-client/control-plane-api-key`
  - operator config in `~/.planbridge/config.json`

  Examples and tests use generic placeholders such as
  `--projects-root ~/code`, `--allowlist my-api`, and a project name
  like `my-project`. Never hardcode a real absolute path, host, or
  token into source, examples, or tests.

- **Subscription-first Codex execution.** Codex runs against a
  subscription login. Do not add API-key model calls unless they are
  an explicitly designed, documented capability; the subscription-first
  adapter refuses API-key mode.
- **Codex execution is an explicit handoff step.** Execution is never
  implicit. A handoff carries the goal text, its constraints, and the
  verification expected of the run. Work lands in an isolated worktree
  and is never auto-merged.

For the full security model and transport hardening details, see
[docs/PLANBRIDGE-SPEC.md](docs/PLANBRIDGE-SPEC.md), the
[hardening guide](docs/hardening.md), and [SECURITY.md](SECURITY.md).

## Pull requests

- Keep changes scoped and the diff readable.
- Run all four verification gates locally and confirm the Verify
  workflow is green.
- If your change touches the MCP tool surface, transport, redaction,
  or access control, include the threat model described above.
- Report any verification you could not run, and why.

## License

By contributing, you agree that your contributions are licensed under
the [MIT License](LICENSE), consistent with the rest of the project.
