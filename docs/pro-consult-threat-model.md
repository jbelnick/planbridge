# Pro Consult Threat Model

This document covers the opt-in `pro_consult` bridge referenced in the
[README](../README.md). The bridge is disabled by default and is enabled
only when an operator explicitly opts in.

## Scope

`pro_consult` is an opt-in PlanBridge tool for getting GPT-5.5 Pro
analysis without OpenAI API calls. It packages selected allowlisted
project files through the existing `context_pack` boundary, writes a
redacted local bundle under `~/.planbridge/pro-consults/`, then invokes
Oracle in ChatGPT browser mode.

This is not direct Pro-to-MCP access. Observed ChatGPT behavior on the
tested account and web surface was:

- The `Extra High` reasoning setting could invoke PlanBridge tools.
- `Pro` and `Pro Extended` did not invoke PlanBridge or comparable MCP
  app tools on the tested account and web surface.
- Oracle browser mode with an already logged-in Chrome `Default` profile
  did select and verify `Pro` without API billing.

These are general findings about the current browser surface, not a
guaranteed contract; model-picker and tool-invocation behavior can change
on the ChatGPT side at any time.

## Trust Boundary

The MCP caller can trigger local browser automation when
`proConsult.enabled` is true. That is a broader boundary than the default
read-only PlanBridge tools:

- It can consume ChatGPT subscription quota and create browser
  conversation state.
- It uses the configured Chrome profile for ChatGPT cookies.
- It performs network work through ChatGPT.
- It writes local runtime artifacts outside the project tree.

For that reason the bridge is disabled by default and enabled only when
operator config opts in. In guided mode, `prepare_plan` may use it
internally; in advanced or legacy profiles, the direct `pro_consult` tool
is exposed with `readOnlyHint: false`, `destructiveHint: false`, and
`openWorldHint: true`.

## Assets

- Chrome profile cookies and ChatGPT session state.
- ChatGPT subscription quota and conversation history.
- Allowlisted project source selected by the caller.
- Secrets that may exist in project files, gitignored files, symlinks, or
  high-entropy literals.
- PlanBridge audit logs and local runtime artifacts under
  `~/.planbridge/`.

## Controls

- Operator opt-in: setup requires `--enable-pro-consult`.
- Fixed model: `gpt-5.5-pro`.
- Fixed engine: Oracle runs with `--engine browser`; no API-key model
  route is introduced.
- No arbitrary command surface: tool input cannot set shell commands,
  model name, browser flags, environment, profile, or raw file paths
  outside the allowlisted project.
- Sanitized context: selected files pass through project allowlist
  checks, path traversal checks, gitignore blocking, per-file and total
  context budgets, and content redaction before Oracle sees them.
- No raw repo uploads: Oracle receives the generated redacted bundle, not
  the original project paths.
- Environment hygiene: the Oracle child process gets a small allowlist of
  runtime variables and excludes API keys and service tokens.
- Concurrency guard: only one active consult may use the configured
  Chrome profile at a time.
- Metadata-only audit: audit records tool, project, bundle path, answer
  byte count, session, and run id; it does not log prompts, file
  contents, cookies, stdout, stderr, or model output.
- Response path hygiene: routine `pro_consult` responses return stable
  handles and metadata without local artifact paths. Operators can
  request `includeInternalPaths: true` for local debugging.
- Doctor check: `planbridge doctor` verifies Oracle availability when the
  bridge is enabled without launching ChatGPT.

## Residual Risks

- Chrome profile exposure: Oracle still reads the configured Chrome
  profile's ChatGPT cookies. Prefer a dedicated Chrome profile if the
  operator wants stronger separation.
- Browser state: ChatGPT may retain the consult conversation unless the
  operator archives or deletes it manually.
- Prompt injection: allowed project files can contain hostile
  instructions. The generated bundle tells Pro to treat file contents as
  untrusted, but model compliance is not a hard security boundary.
- Quota abuse: an authorized MCP caller can spend subscription time by
  invoking `pro_consult`. Keep tunnel and connector access restricted.
- GUI/profile failures: locked cookies, keychain prompts, ChatGPT UI
  changes, or model-picker changes can fail the consult even when
  PlanBridge itself is healthy.

## Verification Requirements

- Unit tests prove fixed Oracle argv, environment allowlisting, opt-in
  config, sanitized context bundle generation, closed read-boundary
  errors, and fake server injection.
- Integration tests prove legacy registry compatibility, guided profile
  registration, and opt-in direct `pro_consult` exposure in the profile
  where it is visible.
- A live operator smoke must run one `pro_consult` call against the
  configured Chrome profile and confirm the answer returns from
  `gpt-5.5-pro` browser mode without `OPENAI_API_KEY` or `CODEX_API_KEY`.

See the [PlanBridge spec](PLANBRIDGE-SPEC.md) for the full tool surface
and the [hardening guide](hardening.md) for the network/transport
boundary that this consult path runs behind.
