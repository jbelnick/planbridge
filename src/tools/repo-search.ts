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
  return {
    path: path.relative(projectRoot, match[1]),
    line: Number.parseInt(match[2], 10),
    preview: match[3]
  };
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
    const args = ["--fixed-strings", "--line-number", "--no-heading", "--color", "never"];
    if (input.glob) {
      args.push("--glob", input.glob);
    }
    args.push("--", input.query, project.root);

    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("rg", args, { maxBuffer: 1024 * 1024, timeout: context.limits.toolTimeoutMs }));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException & { stdout?: string; code?: number };
      if (nodeError.code !== 1) {
        throw error;
      }
      stdout = nodeError.stdout ?? "";
    }

    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    let truncated = false;
    for (const line of lines) {
      const parsed = parseRgLine(project.root, line);
      if (!parsed) {
        continue;
      }
      const blocked = classifyBlockedPath(parsed.path);
      if (blocked.blocked || (await isGitIgnored(project.root, parsed.path))) {
        await context.audit.append({
          event: "blocked",
          tool: "repo_search",
          project: project.name,
          path: parsed.path,
          blockReason: blocked.blocked ? blocked.reason : "E_GITIGNORED",
          sessionId: context.session.id
        });
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
