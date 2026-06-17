import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanbridgeConfig } from "./config.js";
import type { ResolvedProject } from "./security/paths.js";
import { resolveProject } from "./security/paths.js";

const execFileAsync = promisify(execFile);

export type ProjectMetadata = {
  name: string;
  path: string;
  languages: string[];
};

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAllowedProject(config: PlanbridgeConfig, project: string, planbridgeHome?: string): Promise<ResolvedProject> {
  return resolveProject({
    projectsRoot: config.projectsRoot,
    allowlist: config.allowlist,
    project,
    planbridgeHome
  });
}

export async function listProjects(config: PlanbridgeConfig): Promise<ProjectMetadata[]> {
  const projects: ProjectMetadata[] = [];
  for (const name of config.allowlist) {
    const project = await resolveAllowedProject(config, name);
    projects.push({
      name,
      path: path.join(config.projectsRoot, name),
      languages: await detectLanguages(project.root)
    });
  }
  return projects;
}

export async function detectLanguages(projectRoot: string): Promise<string[]> {
  const languages = new Set<string>();
  if (await pathExists(path.join(projectRoot, "package.json"))) {
    languages.add("TypeScript");
  }
  if (await pathExists(path.join(projectRoot, "pyproject.toml"))) {
    languages.add("Python");
  }
  if (await pathExists(path.join(projectRoot, "Cargo.toml"))) {
    languages.add("Rust");
  }
  if (await pathExists(path.join(projectRoot, "go.mod"))) {
    languages.add("Go");
  }
  return [...languages].sort();
}

export async function repoType(projectRoot: string): Promise<string> {
  if (await pathExists(path.join(projectRoot, "package.json"))) {
    return "node";
  }
  if (await pathExists(path.join(projectRoot, "pyproject.toml"))) {
    return "python";
  }
  if (await pathExists(path.join(projectRoot, "Cargo.toml"))) {
    return "rust";
  }
  if (await pathExists(path.join(projectRoot, "go.mod"))) {
    return "go";
  }
  return "unknown";
}

export async function keyDocs(projectRoot: string): Promise<string[]> {
  const docs = ["README.md", "AGENTS.md", "CLAUDE.md"];
  const present: string[] = [];
  for (const doc of docs) {
    if (await pathExists(path.join(projectRoot, doc))) {
      present.push(doc);
    }
  }
  return present;
}

export async function testCommands(projectRoot: string): Promise<string[] | null> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = Object.keys(packageJson.scripts ?? {})
    .filter((script) => /^(test|check|lint)/.test(script));
  return scripts.length > 0 ? scripts.map((script) => `npm run ${script}`) : null;
}

export async function recentStatus(projectRoot: string): Promise<string> {
  try {
    const [{ stdout: log }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["-C", projectRoot, "log", "-1", "--format=%h %s"]),
      execFileAsync("git", ["-C", projectRoot, "status", "--porcelain"])
    ]);
    return `${log.trim() || "no commits"}; ${status.trim() ? "dirty" : "clean"}`;
  } catch {
    return "git unavailable";
  }
}

export async function gitCommitSha(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    return /^[a-f0-9]{40}$/i.test(sha) ? sha : "UNVERSIONED";
  } catch {
    return "UNVERSIONED";
  }
}

export type GitStatusSummary = {
  staged: number;
  modified: number;
  untracked: number;
};

export type GitStatusResult = {
  branch: string;
  detached: boolean;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  summary: GitStatusSummary;
};

const NOT_A_REPO_STATUS: GitStatusResult = {
  branch: "",
  detached: false,
  dirty: false,
  ahead: null,
  behind: null,
  summary: { staged: 0, modified: 0, untracked: 0 }
};

function isNotRepositoryError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
  const text = `${nodeError.stderr ?? ""}\n${nodeError.message ?? ""}`;
  return /not a git repository/.test(text);
}

function countPorcelainLine(line: string, summary: GitStatusSummary): void {
  if (line.startsWith("? ")) {
    summary.untracked += 1;
    return;
  }
  if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
    const status = line.slice(2, 4);
    if (status[0] && status[0] !== ".") {
      summary.staged += 1;
    }
    if (status[1] && status[1] !== ".") {
      summary.modified += 1;
    }
  }
}

export async function gitStatus(projectRoot: string, timeoutMs: number): Promise<GitStatusResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", projectRoot, "status", "--porcelain=v2", "--branch"], {
      timeout: timeoutMs,
      // Force a stable locale so the not-a-repo discriminator below is not defeated
      // by a translated "fatal: not a git repository" message under a non-English git.
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    }));
  } catch (error) {
    if (isNotRepositoryError(error)) {
      return NOT_A_REPO_STATUS;
    }
    throw error;
  }

  const summary: GitStatusSummary = { staged: 0, modified: 0, untracked: 0 };
  let branchHead = "";
  let branchOid = "";
  let ahead: number | null = null;
  let behind: number | null = null;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("# branch.head ")) {
      branchHead = line.slice("# branch.head ".length);
      continue;
    }
    if (line.startsWith("# branch.oid ")) {
      branchOid = line.slice("# branch.oid ".length);
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^\# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
      continue;
    }
    if (!line.startsWith("#")) {
      countPorcelainLine(line, summary);
    }
  }

  const detached = branchHead === "(detached)";
  const branch = detached ? branchOid.slice(0, 7) : branchHead;
  const dirty = summary.staged + summary.modified + summary.untracked > 0;
  return { branch, detached, dirty, ahead, behind, summary };
}

export async function relativeFiles(projectRoot: string): Promise<string[]> {
  const entries = await readdir(projectRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(projectRoot, path.join(entry.parentPath, entry.name)))
    .sort();
}
