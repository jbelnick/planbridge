import { describe, expect, it } from "vitest";
import { codexMode, type CodexHandoff } from "../../src/adapters/codex-adapter.js";
import { handoffMode, parseHandoffArtifact, renderHandoffArtifact } from "../../src/adapters/handoff-file.js";

function completeHandoff(overrides: Partial<CodexHandoff> = {}): CodexHandoff {
  return {
    schema_version: "1.0",
    project: "alpha",
    objective: "Implement the accepted plan",
    context: "Context body",
    constraints: "Constraint body",
    non_goals: [],
    likely_files: [],
    verification: ["npm test"],
    stop_conditions: ["Unexpected repo mutation"],
    ...overrides
  };
}

describe("handoff-file adapter helpers", () => {
  it("treats only the five canonical H2 headings as section delimiters", () => {
    const input = completeHandoff({
      objective: "Objective with an internal heading\n## Not A Canonical Heading\nstill objective",
      context: "## Leading body heading is not a delimiter\ncontext continues",
      constraints: "Fence survives:\n```md\n## Objective\nnot a section\n```"
    });

    expect(parseHandoffArtifact(renderHandoffArtifact(input))).toEqual(input);
  });

  it("uses shared codexMode for both handoff-file and codex-cli billing posture", () => {
    expect(codexMode({})).toBe("subscription");
    expect(codexMode({ OPENAI_API_KEY: "sk-test" })).toBe("api-key");
    expect(codexMode({ CODEX_API_KEY: "codex-key" })).toBe("api-key");
    expect(handoffMode({ CODEX_API_KEY: "codex-key" })).toBe("api-key");
  });
});
