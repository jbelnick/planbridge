import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createToolContext } from "../../src/tool-context.js";
import { parseHandoffArtifact } from "../../src/adapters/handoff-file.js";
import { codexHandoff } from "../../src/tools/codex-handoff.js";
import { contextPack, type ContextPack } from "../../src/tools/context-pack.js";
import { projectsList } from "../../src/tools/projects-list.js";
import { repoReadFiles } from "../../src/tools/repo-read-files.js";

function withoutGeneratedAt(pack: ContextPack): Omit<ContextPack, "generated_at"> {
  const { generated_at: _generatedAt, ...rest } = pack;
  return rest;
}

describe("fixture repo smoke", () => {
  it("lists projects, reads an allowed file, and denies a denylisted file", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = createToolContext({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      }
    });

    await expect(projectsList({}, context)).resolves.toMatchObject({
      projects: [{ name: "alpha" }]
    });
    await expect(repoReadFiles({ project: "alpha", paths: ["README.md", ".env"] }, context)).resolves.toMatchObject({
      files: [{ path: "README.md" }],
      blocked: [{ path: ".env", reason: "E_SECRET_BLOCKED" }]
    });

    const first = await contextPack({ project: "alpha", paths: ["README.md", ".env", "src.txt"] }, context);
    const second = await contextPack({ project: "alpha", paths: ["src.txt", ".env", "README.md"] }, context);
    if ("error" in first || "error" in second) {
      throw new Error("unexpected context_pack error");
    }

    expect(first.omitted).toContainEqual({ path: ".env", reason: "E_SECRET_BLOCKED" });
    expect(first.files.map((file) => file.path)).not.toContain(".env");
    expect(JSON.stringify(first)).not.toContain("sk-test");
    expect(JSON.stringify(withoutGeneratedAt(first))).toBe(JSON.stringify(withoutGeneratedAt(second)));

    const handoff = await codexHandoff(
      {
        project: "alpha",
        objective: "Implement the smoke handoff",
        context: "Smoke context",
        constraints: "No repo mutation",
        non_goals: [],
        likely_files: ["README.md"],
        verification: ["npm test"],
        stop_conditions: ["Unexpected failure"]
      },
      context
    );
    if ("error" in handoff) {
      throw new Error("unexpected codex_handoff error");
    }
    expect(parseHandoffArtifact(await readFile(handoff.handle, "utf8"))).toMatchObject({
      objective: "Implement the smoke handoff",
      project: "alpha"
    });
  });
});
