import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createToolContext } from "../../src/tool-context.js";
import { repoSearch, repoSearchInputSchema } from "../../src/tools/repo-search.js";

describe("repo_search", () => {
  it("validates input, returns bounded matches, and respects preview limits", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        limits: { maxSearchResults: 1, maxMatchPreviewBytes: 5 }
      },
      home: fixture.home
    });

    expect(repoSearchInputSchema.parse({ project: "alpha", query: "needle" })).toMatchObject({
      project: "alpha",
      query: "needle"
    });
    const result = await repoSearch({ project: "alpha", query: "needle" }, context);

    expect("error" in result).toBe(false);
    if ("error" in result) {
      throw new Error("unexpected error response");
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: "src.txt", line: 1, preview: "alpha" });
    expect(result.truncated).toBe(false);
  });

  it("returns project allowlist errors in the shared envelope", async () => {
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

    await expect(repoSearch({ project: "beta", query: "needle" }, context)).resolves.toEqual({
      error: {
        code: "E_PROJECT_NOT_ALLOWED",
        message: "Project is not in the allowlist: beta",
        path: "beta"
      }
    });
  });

  it("reports truncated from the result cap, not from filtered secret lines", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, "multi.txt"), "needle one\nneedle two\nneedle three\n");
    await writeFile(path.join(fixture.projectRoot, "credentials.txt"), "needle secret\n");
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

    const result = await repoSearch({ project: "alpha", query: "needle" }, context);
    if ("error" in result) {
      throw new Error("unexpected error response");
    }

    expect(result.matches).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("needle secret");
  });

  it("caps matches at maxResults and reports truncated", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, "multi.txt"), "needle one\nneedle two\nneedle three\n");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        limits: { maxSearchResults: 2 }
      },
      home: fixture.home
    });

    const result = await repoSearch({ project: "alpha", query: "needle" }, context);
    if ("error" in result) {
      throw new Error("unexpected error response");
    }

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("treats model-provided punctuation as a literal search query", async () => {
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

    await expect(repoSearch({ project: "alpha", query: "[" }, context)).resolves.toMatchObject({
      matches: [],
      truncated: false
    });
  });
});
