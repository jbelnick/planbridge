import { describe, expect, it } from "vitest";
import { ConfigSchema, effectiveExecution } from "../../src/config.js";
import { DEFAULT_LIMITS } from "../../src/limits.js";
import { codexHandoffInputSchema } from "../../src/tools/codex-handoff.js";

const baseConfig = {
  schemaVersion: "1.0" as const,
  projectsRoot: "/tmp/projects",
  allowlist: ["alpha"],
  port: 7676,
  transport: "streamable-http" as const,
  connection: { kind: "localhost" as const },
  auth: { mode: "none" as const }
};

describe("execution config", () => {
  it("defaults to handoff-file without changing existing config fixtures", () => {
    const parsed = ConfigSchema.parse(baseConfig);

    expect(effectiveExecution(parsed)).toEqual({
      adapter: "handoff-file",
      timeoutMs: DEFAULT_LIMITS.codexExecTimeoutMs,
      branchPrefix: "planbridge/"
    });
  });

  it("activates codex-cli only through operator config, never tool input", () => {
    const parsed = ConfigSchema.parse({
      ...baseConfig,
      execution: {
        adapter: "codex-cli",
        worktreeRoot: "/tmp/planbridge-worktrees",
        timeoutMs: 1234,
        branchPrefix: "pb/"
      }
    });

    expect(effectiveExecution(parsed)).toEqual({
      adapter: "codex-cli",
      worktreeRoot: "/tmp/planbridge-worktrees",
      timeoutMs: 1234,
      branchPrefix: "pb/"
    });

    const input = codexHandoffInputSchema.parse({
      project: "alpha",
      objective: "Implement",
      context: "Context",
      constraints: "Constraints",
      non_goals: [],
      likely_files: [],
      verification: ["npm test"],
      stop_conditions: ["Stop"],
      adapter: "codex-cli"
    });
    expect(input).not.toHaveProperty("adapter");
  });
});
