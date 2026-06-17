import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod/v4";
import type { ErrorCode, ToolError } from "../errors.js";
import { sizeExceeded, toToolError } from "../envelopes.js";
import { planbridgeHome } from "../config.js";
import { gitCommitSha, resolveAllowedProject } from "../project-index.js";
import { readAllowedTextFile } from "../security/redaction.js";
import type { ToolContext } from "../tool-context.js";

export const REDACTION_MARKER = "[PLANBRIDGE_REDACTED]";

type OmittedReason = Extract<ErrorCode, "E_SECRET_BLOCKED" | "E_GITIGNORED"> | "budget";

export type ContextPack = {
  schema_version: "1.0";
  project: string;
  commit_sha: string;
  generated_at: string;
  prompt: string;
  constraints: string[];
  files: Array<{ path: string; sha256: string; bytes: number; truncated: boolean; content: string }>;
  budget: { used_bytes: number; max_bytes: number };
  redactions: Array<{ path: string; reason: "content-scan" }>;
  omitted: Array<{ path: string; reason: OmittedReason }>;
};

export const contextPackInputSchema = z.object({
  project: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  prompt: z.string().default(""),
  constraints: z.array(z.string()).default([]),
  maxBytesPerFile: z.number().int().positive().optional()
});

export type ContextPackOutput = ContextPack | ToolError;
type BufferedAuditEntry = Parameters<ToolContext["audit"]["append"]>[0];
type CandidateFile = ContextPack["files"][number] & { auditEntries: BufferedAuditEntry[] };

function normalizeRequestedPath(relativePath: string): string {
  return path.normalize(relativePath).split(path.sep).join("/");
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function contextPack(
  rawInput: { project: string; paths: string[]; prompt?: string; constraints?: string[]; maxBytesPerFile?: number },
  context: ToolContext
): Promise<ContextPackOutput> {
  const input = contextPackInputSchema.parse(rawInput);
  const requestedPaths = [...new Set(input.paths.map(normalizeRequestedPath))].sort(comparePath);
  if (context.session.filesRead + requestedPaths.length > context.limits.maxFilesPerSession) {
    await context.audit.append({
      event: "blocked",
      tool: "context_pack",
      blockReason: "E_SIZE_EXCEEDED",
      sessionId: context.session.id,
      filesTouched: context.session.filesRead
    });
    return sizeExceeded("context_pack exceeds maxFilesPerSession");
  }

  try {
    const project = await resolveAllowedProject(context.config, input.project, planbridgeHome({ HOME: context.home }));
    const commitSha = await gitCommitSha(project.root);
    const maxBytesPerFile = Math.min(rawInput.maxBytesPerFile ?? context.limits.maxBytesPerFile, context.limits.maxBytesPerFile);
    const maxContextBytes = context.limits.maxContextBytes;
    const candidates: CandidateFile[] = [];
    const omitted: ContextPack["omitted"] = [];

    for (const relativePath of requestedPaths) {
      const auditEntries: BufferedAuditEntry[] = [];
      const result = await readAllowedTextFile({
        project,
        relativePath,
        maxBytesPerFile,
        audit: {
          logPath: context.audit.logPath,
          async append(entry) {
            auditEntries.push(entry);
          }
        },
        sessionId: context.session.id,
        tool: "context_pack",
        filesTouched: context.session.filesRead + candidates.length + 1
      });
      if ("blocked" in result) {
        for (const entry of auditEntries) {
          await context.audit.append(entry);
        }
        omitted.push({
          path: normalizeRequestedPath(result.blocked.path),
          reason: result.blocked.reason as Extract<ErrorCode, "E_SECRET_BLOCKED" | "E_GITIGNORED">
        });
        continue;
      }

      const content = result.file.content;
      candidates.push({
        path: normalizeRequestedPath(result.file.path),
        sha256: sha256(content),
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: result.file.truncated,
        content,
        auditEntries
      });
    }

    candidates.sort((a, b) => comparePath(a.path, b.path));

    const files: ContextPack["files"] = [];
    const redactions: ContextPack["redactions"] = [];
    let usedBytes = 0;
    for (const file of candidates) {
      if (usedBytes + file.bytes <= maxContextBytes) {
        const { auditEntries, ...emittedFile } = file;
        files.push(emittedFile);
        usedBytes += file.bytes;
        const filesTouched = context.session.filesRead + 1;
        for (const entry of auditEntries) {
          await context.audit.append(entry.event === "read" ? { ...entry, filesTouched } : entry);
        }
        context.session.filesRead = filesTouched;
        if (file.content.includes(REDACTION_MARKER)) {
          redactions.push({ path: file.path, reason: "content-scan" });
        }
      } else {
        omitted.push({ path: file.path, reason: "budget" });
      }
    }
    omitted.sort((a, b) => comparePath(a.path, b.path));
    redactions.sort((a, b) => comparePath(a.path, b.path));

    return {
      schema_version: "1.0",
      project: project.name,
      commit_sha: commitSha,
      generated_at: new Date().toISOString(),
      prompt: input.prompt,
      constraints: input.constraints,
      files,
      budget: { used_bytes: usedBytes, max_bytes: maxContextBytes },
      redactions,
      omitted
    };
  } catch (error) {
    return toToolError(error);
  }
}
