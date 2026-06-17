import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createToolContext, type ToolContext } from "../../src/tool-context.js";
import { gitStatusTool } from "../../src/tools/git-status.js";
import { createFixtureProject, initGitFixture, type FixtureProject } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

function makeContext(fixture: FixtureProject, allowlist = ["alpha"]): ToolContext {
  return createToolContext({
    home: fixture.home,
    config: {
      schemaVersion: "1.0",
      projectsRoot: fixture.projectsRoot,
      allowlist,
      port: 7676,
      transport: "streamable-http",
      connection: { kind: "localhost" },
      auth: { mode: "none" }
    }
  });
}

describe("git_status", () => {
  it("returns the frozen clean shape for a real git fixture without upstream", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);

    await expect(gitStatusTool({ project: "alpha" }, makeContext(fixture))).resolves.toEqual({
      branch: "main",
      detached: false,
      dirty: false,
      ahead: null,
      behind: null,
      summary: { staged: 0, modified: 0, untracked: 0 }
    });
  });

  it("counts staged, modified, and untracked changes independently", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    await writeFile(path.join(fixture.projectRoot, "staged.txt"), "staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: fixture.projectRoot });
    await writeFile(path.join(fixture.projectRoot, "README.md"), "# Alpha modified\n");
    await writeFile(path.join(fixture.projectRoot, "untracked.txt"), "untracked\n");

    await expect(gitStatusTool({ project: "alpha" }, makeContext(fixture))).resolves.toEqual({
      branch: "main",
      detached: false,
      dirty: true,
      ahead: null,
      behind: null,
      summary: { staged: 1, modified: 1, untracked: 1 }
    });
  });

  it("reports detached HEAD as short sha and ahead/behind as numbers when upstream exists", async () => {
    const detachedFixture = await createFixtureProject("alpha");
    const head = await initGitFixture(detachedFixture.projectRoot);
    await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: detachedFixture.projectRoot });

    const detached = await gitStatusTool({ project: "alpha" }, makeContext(detachedFixture));

    expect(detached).toMatchObject({
      branch: head.slice(0, 7),
      detached: true,
      dirty: false,
      summary: { staged: 0, modified: 0, untracked: 0 }
    });
    expect(JSON.stringify(detached)).not.toContain("(detached)");

    const upstreamFixture = await createFixtureProject("alpha");
    await initGitFixture(upstreamFixture.projectRoot);
    const remotePath = path.join(upstreamFixture.home, "remote.git");
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["remote", "add", "origin", remotePath], { cwd: upstreamFixture.projectRoot });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: upstreamFixture.projectRoot });
    await writeFile(path.join(upstreamFixture.projectRoot, "ahead.txt"), "ahead\n");
    await execFileAsync("git", ["add", "ahead.txt"], { cwd: upstreamFixture.projectRoot });
    await execFileAsync("git", ["commit", "-m", "ahead"], { cwd: upstreamFixture.projectRoot });

    const upstream = await gitStatusTool({ project: "alpha" }, makeContext(upstreamFixture));

    expect(upstream).toMatchObject({
      branch: "main",
      detached: false,
      ahead: 1,
      behind: 0
    });
  });

  it("returns the not-a-repo sentinel for an allowlisted non-repo directory", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(gitStatusTool({ project: "alpha" }, makeContext(fixture))).resolves.toEqual({
      branch: "",
      detached: false,
      dirty: false,
      ahead: null,
      behind: null,
      summary: { staged: 0, modified: 0, untracked: 0 }
    });
  });

  it("does not report a corrupt git repository as the clean non-repo sentinel", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    await writeFile(path.join(fixture.projectRoot, ".git", "index"), "broken");

    await expect(gitStatusTool({ project: "alpha" }, makeContext(fixture))).rejects.toThrow("index");
  });

  it("enforces the allowlist before git status can run", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(gitStatusTool({ project: "not-allowed" }, makeContext(fixture))).resolves.toEqual({
      error: {
        code: "E_PROJECT_NOT_ALLOWED",
        message: "Project is not in the allowlist: not-allowed",
        path: "not-allowed"
      }
    });
  });

  it("writes one metadata-only status audit entry", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const context = makeContext(fixture);

    await gitStatusTool({ project: "alpha" }, context);
    const entries = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toEqual([
      expect.objectContaining({
        event: "status",
        tool: "git_status",
        project: "alpha",
        sessionId: context.session.id
      })
    ]);
    expect(entries[0]).not.toHaveProperty("branch");
    expect(entries[0]).not.toHaveProperty("summary");
    expect(entries[0]).not.toHaveProperty("ahead");
    expect(entries[0]).not.toHaveProperty("behind");
  });
});
