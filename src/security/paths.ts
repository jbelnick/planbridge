import { realpath } from "node:fs/promises";
import path from "node:path";
import { PlanbridgeError } from "../errors.js";

export type ResolveProjectInput = {
  projectsRoot: string;
  allowlist: string[];
  project: string;
  planbridgeHome?: string;
};

export type ResolvedProject = {
  name: string;
  root: string;
  projectsRoot: string;
  planbridgeHome?: string;
};

export type ResolvedPath = {
  relativePath: string;
  absolutePath: string;
  realPath: string;
};

async function realpathIfExists(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return path.resolve(filePath);
    }
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rejectTraversal(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PlanbridgeError("E_PATH_TRAVERSAL", "Absolute paths are not allowed.", relativePath);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new PlanbridgeError("E_PATH_TRAVERSAL", "Path escapes the project root.", relativePath);
  }
  return normalized === "." ? "" : normalized;
}

export async function resolveProject(input: ResolveProjectInput): Promise<ResolvedProject> {
  if (!input.allowlist.includes(input.project)) {
    throw new PlanbridgeError(
      "E_PROJECT_NOT_ALLOWED",
      `Project is not in the allowlist: ${input.project}`,
      input.project
    );
  }
  const normalizedProject = rejectTraversal(input.project);
  if (normalizedProject.includes(path.sep)) {
    throw new PlanbridgeError("E_PROJECT_NOT_ALLOWED", "Project names must be allowlisted directory names.", input.project);
  }

  const projectsRoot = await realpath(input.projectsRoot);
  const root = await realpath(path.join(projectsRoot, normalizedProject));
  if (!isInside(projectsRoot, root)) {
    throw new PlanbridgeError("E_PATH_TRAVERSAL", "Project root escapes projectsRoot.", input.project);
  }

  return {
    name: input.project,
    root,
    projectsRoot,
    planbridgeHome: input.planbridgeHome ? await realpathIfExists(input.planbridgeHome) : undefined
  };
}

export async function resolveProjectPath(project: ResolvedProject, relativePath: string): Promise<ResolvedPath> {
  const normalized = rejectTraversal(relativePath);
  const absolutePath = path.resolve(project.root, normalized);
  if (!isInside(project.root, absolutePath)) {
    throw new PlanbridgeError("E_PATH_TRAVERSAL", "Path escapes the project root.", relativePath);
  }

  let realPath: string;
  try {
    realPath = await realpath(absolutePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new PlanbridgeError("E_NOT_FOUND", "Path does not exist.", relativePath);
    }
    throw error;
  }

  if (!isInside(project.root, realPath)) {
    throw new PlanbridgeError("E_PATH_TRAVERSAL", "Resolved path escapes the project root.", relativePath);
  }
  if (project.planbridgeHome && isInside(project.planbridgeHome, realPath)) {
    throw new PlanbridgeError("E_SECRET_BLOCKED", "PlanBridge home is not readable through project tools.", relativePath);
  }

  return { relativePath: normalized, absolutePath, realPath };
}
