import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FixtureProject = {
  home: string;
  projectsRoot: string;
  projectRoot: string;
};

export async function createFixtureProject(name = "alpha"): Promise<FixtureProject> {
  const home = await mkdtemp(path.join(os.tmpdir(), "planbridge-home-"));
  const projectsRoot = path.join(home, "projects");
  const projectRoot = path.join(projectsRoot, name);

  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), "# Alpha\n");
  await writeFile(path.join(projectRoot, "AGENTS.md"), "# Agent Policy\n");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    scripts: {
      test: "vitest run",
      lint: "eslint .",
      build: "tsc"
    },
    dependencies: {}
  }, null, 2));
  await writeFile(path.join(projectRoot, "src.txt"), "alpha needle\nsecond line\n");
  await writeFile(path.join(projectRoot, ".gitignore"), "ignored.txt\nbuild/\n");
  await writeFile(path.join(projectRoot, "ignored.txt"), "ignored content\n");
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await writeFile(path.join(projectRoot, ".git", "config"), "secret history\n");
  await writeFile(path.join(projectRoot, ".env"), "TOKEN=sk-test\n");

  const outside = path.join(home, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(projectRoot, "outside-link.txt"));

  return { home, projectsRoot, projectRoot };
}

export async function initGitFixture(projectRoot: string): Promise<string> {
  await rm(path.join(projectRoot, ".git"), { recursive: true, force: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.email", "planbridge@example.test"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.name", "PlanBridge Test"], { cwd: projectRoot });
  await execFileAsync("git", ["add", "."], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: projectRoot });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
  return stdout.trim();
}
