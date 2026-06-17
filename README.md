# PlanBridge

**A local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector that lets ChatGPT plan over an allowlisted local dev workspace — then hand the approved plan to Codex to build.**

PlanBridge gives a hosted planner (ChatGPT / GPT‑class models) a *narrow, read‑only, inspectable* window into your real codebase so it can produce a high‑quality plan, then packages that plan into a frozen handoff and drives an isolated Codex execution. The connector is read‑only by default, fails closed without access control, and prefers subscription‑mode execution over API‑billed calls.

> Status: **feature‑complete** (M1–M5). TypeScript/Node, the official MCP SDK, Streamable HTTP. **135 automated tests, all offline** — no live model or tunnel required to run the suite.

---

## Why

Complex coding tasks fail when the planner never saw the relevant files, constraints, tests, or local conventions — and a weak handoff to an execution agent wastes time and creates review churn. PlanBridge closes that gap without handing a hosted model the keys to your machine:

- **Plan with real context.** ChatGPT inspects an *allowlisted* set of projects through bounded, redacting tools and assembles a reproducible context bundle.
- **Hand off deliberately.** The plan becomes a schema‑validated handoff whose exact bytes you approve before anything runs.
- **Execute in isolation.** Codex runs the approved handoff in a dedicated git worktree on a throwaway branch — never your live tree, never auto‑merged.
- **Review the result.** A bounded, secret‑redacted diff comes back for review, and you can request a follow‑up handoff.

## How it works

```
ChatGPT (planner)                          your machine                     Codex (engineer)
      │                                                                            
      │  projects_list / project_summary / repo_search / repo_read_files            
      ├──────────────────────────────►  read‑only, allowlisted, redacting           
      │  context_pack (reproducible bundle) + git_status                            
      │                                                                            
      │  codex_handoff  ── you approve the exact bytes ──►  isolated git worktree ──► codex exec
      │  codex_status  ◄── running / completed / failed ──                          
      │  git_diff      ◄── bounded, secret‑redacted diff ──                         
      │                                                                            
      └──────────────────────────────►  request a follow‑up handoff …               
```

The MCP server binds to `127.0.0.1` and is reached only through a connection you configure (a Secure MCP Tunnel by default, or localhost for same‑machine testing).

## Tool surface

Nine MCP tools — eight read‑only, plus one explicit action. ChatGPT can never write to your tree except through the approved `codex_handoff`, and even that writes only inside an isolated worktree.

| Tool | Mode | Purpose |
|---|---|---|
| `projects_list` | read‑only | List allowlisted projects and basic metadata. |
| `project_summary` | read‑only | Repo type, key docs, test commands, recent status. |
| `repo_search` | read‑only | Bounded ripgrep‑style search over allowed files. |
| `repo_read_files` | read‑only | Read allowed files with size limits + secret filtering. |
| `context_pack` | read‑only | Package files + prompt + constraints into a **reproducible** planning bundle (pinned to a commit, per‑file `sha256`). |
| `git_status` | read‑only | Branch and dirty‑state summary. |
| `git_diff` | read‑only | Bounded, secret‑redacted diff of a Codex run's worktree. |
| `codex_status` | read‑only | Report a handoff's `running` / `completed` / `failed` state. |
| `codex_handoff` | **action** | Start an isolated, subscription‑mode Codex execution from the approved plan. |

## Security model

PlanBridge treats exposing local context to a hosted model as a real risk and keeps the boundary narrow and auditable:

- **Project‑root allowlist.** No default access to `$HOME` or the wider filesystem; the connector's own config dir is itself on the deny path.
- **Layered secret protection.** Deny `.git/` by default, a path denylist (`.env`, keys, tokens, SSH/keychain material), `.gitignore` exclusion, and a content‑scan redaction pass over every returned byte (high‑entropy strings and known credential prefixes).
- **Bounded everything.** Per‑file, per‑call, and per‑session size/budget caps; structured error codes (never silent truncation).
- **Fail‑closed transport.** The public path refuses to start without configured access control; a continuous self‑probe hard‑alerts (and refuses to serve) if the public endpoint is ever reachable unauthenticated.
- **Network‑secret runtime.** 256‑bit CSPRNG bearer secret, stored only as a sha256 hash, constant‑time compared; `Authorization` is redacted from logs; rate‑limit + lockout on auth failures.
- **Subscription‑first execution.** The Codex adapter refuses API‑key mode by default and runs every handoff in a worktree‑isolated, never‑auto‑merged branch.
- **Metadata‑only audit log** with size/age rotation. Secrets and file contents are never written.

The operator hardening guide is in [`docs/hardening.md`](docs/hardening.md); the full product + threat model spec is in [`docs/PLANBRIDGE-SPEC.md`](docs/PLANBRIDGE-SPEC.md).

## Quickstart

Requires Node ≥ 22.

```bash
npm install
npm run build
npm test          # 135 offline tests

# Configure a localhost connector over two allowlisted projects.
# Writes ~/.planbridge/config.json (outside any project tree).
node dist/src/cli.js setup \
  --projects-root ~/code \
  --allowlist my-api,my-web \
  --localhost \
  --port 7676

# Start the MCP server (binds 127.0.0.1)
node dist/src/server.js
```

For remote use, configure a Secure MCP Tunnel (`--tunnel-id <id>`) or, as a fallback, a public HTTPS URL with network access control (`--public-base-url <https url> --access-control network`). See [`docs/hardening.md`](docs/hardening.md).

## How it was built

PlanBridge was built with a deliberate **two‑agent loop — an architect that plans and an engineer that builds — with adversarial review at every gate**:

1. **Architect (design).** Each milestone began as a written contract: a design fanned out to several independent design agents, a judge synthesized the strongest one, and an adversarial panel pressure‑tested it. The output was a frozen, file‑by‑file handoff plus a set of **independently testable acceptance criteria**.
2. **Engineer (build).** A separate build agent implemented strictly against the frozen acceptance criteria in an isolated git worktree — graded only against that contract.
3. **Adversarial acceptance review.** Before anything merged, a multi‑auditor review re‑ran the gate and tried to break the result — verifying citations, re‑attacking the security surface, and hunting for vacuous tests. Real findings (e.g. a symlink‑exfiltration hole in the diff tool, a redaction ordering bug, a flaky crypto test) were fixed before integration.
4. **Fast‑forward integration.** Each verified slice was clean‑room rebuilt and fast‑forward merged, one milestone at a time.

The result is five milestones (read‑only tools → context packer → Codex handoff → diff review → hardening) shipped behind frozen contracts, with the security‑sensitive paths (worktree‑isolated execution, secret redaction, fail‑closed transport) reviewed adversarially rather than trusted.

## Tech stack

TypeScript · Node ≥ 22 · official MCP SDK (Streamable HTTP) · Express · Zod (all tool I/O + config schemas) · Vitest · ripgrep (runtime dependency for search).

## Status & scope

This is a working connector and a design study, not a hosted service. It assumes a single trusted operator on one machine and makes its residual risks explicit (see the spec's threat model and `docs/hardening.md`). It does **not** guarantee that no sensitive data reaches a hosted model — redaction is best‑effort and allowlisted content is, by design, visible to the planner.

## License

[MIT](LICENSE) © Jason Belnick
