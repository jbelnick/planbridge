import path from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { resolveProject, resolveProjectPath } from "../../src/security/paths.js";

describe("security/paths", () => {
  it("resolves allowlisted project roots", async () => {
    const fixture = await createFixtureProject("alpha");

    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha"
    });

    await expect(realpath(fixture.projectRoot)).resolves.toBe(project.root);
  });

  it("blocks projects outside the allowlist", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      resolveProject({
        projectsRoot: fixture.projectsRoot,
        allowlist: ["beta"],
        project: "alpha"
      })
    ).rejects.toMatchObject({ code: "E_PROJECT_NOT_ALLOWED" });
  });

  it("blocks traversal and absolute paths", async () => {
    const fixture = await createFixtureProject("alpha");
    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha"
    });

    await expect(resolveProjectPath(project, "../outside.txt")).rejects.toMatchObject({
      code: "E_PATH_TRAVERSAL"
    });
    await expect(resolveProjectPath(project, path.join(fixture.home, "outside.txt"))).rejects.toMatchObject({
      code: "E_PATH_TRAVERSAL"
    });
  });

  it("blocks symlink escapes", async () => {
    const fixture = await createFixtureProject("alpha");
    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha"
    });

    await expect(resolveProjectPath(project, "outside-link.txt")).rejects.toMatchObject({
      code: "E_PATH_TRAVERSAL"
    });
  });

  it("blocks planbridge home even if reached from a project symlink", async () => {
    const fixture = await createFixtureProject("alpha");
    const planbridgeHome = path.join(fixture.home, ".planbridge");
    await mkdir(planbridgeHome, { recursive: true });
    await writeFile(path.join(planbridgeHome, "config.json"), "{}\n");

    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha",
      planbridgeHome
    });

    await expect(resolveProjectPath(project, path.relative(fixture.projectRoot, planbridgeHome))).rejects.toMatchObject({
      code: "E_PATH_TRAVERSAL"
    });
  });
});
