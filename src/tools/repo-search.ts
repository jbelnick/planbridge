import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { DEFAULT_LIMITS } from "../limits.js";
import type { ToolError } from "../errors.js";
import { toToolError } from "../envelopes.js";
import { planbridgeHome } from "../config.js";
import { resolveAllowedProject } from "../project-index.js";
import { classifyBlockedPath, isGitIgnored, redactContent } from "../security/redaction.js";
import type { ToolContext } from "../tool-context.js";

const execFileAsync = promisify(execFile);

export const repoSearchInputSchema = z.object({
  project: z.string().min(1),
  query: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().default(DEFAULT_LIMITS.maxSearchResults),
  maxMatchPreviewBytes: z.number().int().positive().default(DEFAULT_LIMITS.maxMatchPreviewBytes)
});

export type RepoSearchOutput =
  | {
      matches: Array<{ path: string; line: number; preview: string }>;
      truncated: boolean;
    }
  | ToolError;

function parseRgLine(projectRoot: string, line: string): { path: string; line: number; preview: string } | null {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const matchPath = match[1];
  return {
    path: path.isAbsolute(matchPath) ? path.relative(projectRoot, matchPath) : matchPath,
    line: Number.parseInt(match[2], 10),
    preview: match[3]
  };
}

async function rgOutput(args: string[], context: ToolContext, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: context.limits.toolTimeoutMs
    });
    return stdout;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stdout?: string; code?: number };
    if (nodeError.code !== 1) {
      throw error;
    }
    return nodeError.stdout ?? "";
  }
}

async function searchableFiles(projectRoot: string, glob: string | undefined, context: ToolContext): Promise<string[]> {
  const args = ["--files", "--color", "never"];
  if (glob) {
    args.push("--glob", glob);
  }
  const listed = await rgOutput(args, context, projectRoot);
  const files: string[] = [];
  for (const relativePath of listed.split(/\r?\n/).filter(Boolean)) {
    const blocked = classifyBlockedPath(relativePath);
    if (!blocked.blocked && !(await isGitIgnored(projectRoot, relativePath))) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function repoSearch(
  rawInput: { project: string; query: string; glob?: string; maxResults?: number; maxMatchPreviewBytes?: number },
  context: ToolContext
): Promise<RepoSearchOutput> {
  const input = repoSearchInputSchema.parse(rawInput);
  const maxResults = Math.min(rawInput.maxResults ?? context.limits.maxSearchResults, context.limits.maxSearchResults);
  const maxMatchPreviewBytes = Math.min(
    rawInput.maxMatchPreviewBytes ?? context.limits.maxMatchPreviewBytes,
    context.limits.maxMatchPreviewBytes
  );

  try {
    const project = await resolveAllowedProject(context.config, input.project, planbridgeHome({ HOME: context.home }));
    const candidates = await searchableFiles(project.root, input.glob, context);
    const stdout =
      candidates.length === 0
        ? ""
        : await rgOutput(["--fixed-strings", "--line-number", "--no-heading", "--color", "never", "--", input.query, ...candidates], context, project.root);

    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    let truncated = false;
    for (const line of lines) {
      const parsed = parseRgLine(project.root, line);
      if (!parsed) {
        continue;
      }
      if (matches.length >= maxResults) {
        // A valid match exists beyond the cap, so results are genuinely truncated.
        truncated = true;
        break;
      }
      const preview = Buffer.from(parsed.preview, "utf8").subarray(0, maxMatchPreviewBytes).toString("utf8");
      const redacted = await redactContent({
        content: preview,
        path: parsed.path,
        audit: context.audit,
        sessionId: context.session.id,
        tool: "repo_search",
        project: project.name
      });
      matches.push({ ...parsed, preview: redacted.content });
    }

    await context.audit.append({
      event: "search",
      tool: "repo_search",
      project: project.name,
      sessionId: context.session.id
    });

    return {
      matches,
      truncated
    };
  } catch (error) {
    return toToolError(error);
  }
}
