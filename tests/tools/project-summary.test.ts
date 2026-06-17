import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createToolContext } from "../../src/tool-context.js";
import { projectSummary, projectSummaryInputSchema } from "../../src/tools/project-summary.js";

describe("project_summary", () => {
  it("returns repo type, key docs, test commands, and recent status", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    expect(projectSummaryInputSchema.parse({ project: "alpha" })).toEqual({ project: "alpha" });
    const summary = await projectSummary({ project: "alpha" }, context);

    expect("error" in summary).toBe(false);
    if ("error" in summary) {
      throw new Error("unexpected error response");
    }
    expect(summary).toMatchObject({
      name: "alpha",
      repoType: "node",
      keyDocs: ["README.md", "AGENTS.md"],
      testCommands: ["npm run test", "npm run lint"]
    });
    expect(summary.recentStatus).toEqual(expect.any(String));
  });
});
