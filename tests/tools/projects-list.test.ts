import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createToolContext } from "../../src/tool-context.js";
import { projectsListInputSchema, projectsList } from "../../src/tools/projects-list.js";

describe("projects_list", () => {
  it("validates empty input and lists allowlisted projects with metadata", async () => {
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

    expect(projectsListInputSchema.parse({})).toEqual({});
    await expect(projectsList({}, context)).resolves.toEqual({
      projects: [{ name: "alpha", path: fixture.projectRoot, languages: ["TypeScript"] }],
      truncated: false
    });
  });
});
