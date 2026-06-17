import { z } from "zod/v4";
import { DEFAULT_LIMITS } from "../limits.js";
import type { ErrorCode, ToolError } from "../errors.js";
import { sizeExceeded, toToolError } from "../envelopes.js";
import { resolveAllowedProject } from "../project-index.js";
import { readAllowedTextFile } from "../security/redaction.js";
import type { ToolContext } from "../tool-context.js";
import { planbridgeHome } from "../config.js";

export const repoReadFilesInputSchema = z.object({
  project: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  maxBytesPerFile: z.number().int().positive().optional()
});

export type RepoReadFilesOutput =
  | {
      files: Array<{ path: string; bytes: number; truncated: boolean; content: string }>;
      blocked: Array<{ path: string; reason: ErrorCode }>;
      truncated: boolean;
    }
  | ToolError;

export async function repoReadFiles(
  rawInput: { project: string; paths: string[]; maxBytesPerFile?: number },
  context: ToolContext
): Promise<RepoReadFilesOutput> {
  const input = repoReadFilesInputSchema.parse(rawInput);
  if (input.paths.length > context.limits.maxFilesPerRead) {
    await context.audit.append({
      event: "blocked",
      tool: "repo_read_files",
      blockReason: "E_SIZE_EXCEEDED",
      sessionId: context.session.id,
      filesTouched: context.session.filesRead
    });
    return sizeExceeded("repo_read_files exceeds maxFilesPerRead");
  }
  if (context.session.filesRead + input.paths.length > context.limits.maxFilesPerSession) {
    await context.audit.append({
      event: "blocked",
      tool: "repo_read_files",
      blockReason: "E_SIZE_EXCEEDED",
      sessionId: context.session.id,
      filesTouched: context.session.filesRead
    });
    return sizeExceeded("repo_read_files exceeds maxFilesPerSession");
  }

  try {
    const project = await resolveAllowedProject(context.config, input.project, planbridgeHome({ HOME: context.home }));
    const files: Array<{ path: string; bytes: number; truncated: boolean; content: string }> = [];
    const blocked: Array<{ path: string; reason: ErrorCode }> = [];
    const maxBytesPerFile = Math.min(rawInput.maxBytesPerFile ?? context.limits.maxBytesPerFile, context.limits.maxBytesPerFile);

    for (const relativePath of input.paths) {
      const result = await readAllowedTextFile({
        project,
        relativePath,
        maxBytesPerFile,
        audit: context.audit,
        sessionId: context.session.id,
        filesTouched: context.session.filesRead + files.length + 1
      });
      if ("file" in result) {
        files.push(result.file);
        context.session.filesRead += 1;
      } else {
        blocked.push(result.blocked);
      }
    }

    return { files, blocked, truncated: files.some((file) => file.truncated) };
  } catch (error) {
    return toToolError(error);
  }
}
