import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { readRunDiffTarget } from "../adapters/codex-cli.js";
import { planbridgeHome } from "../config.js";
import type { ErrorCode, ToolError } from "../errors.js";
import { PlanbridgeError } from "../errors.js";
import type { Bounded } from "../envelopes.js";
import { toToolError } from "../envelopes.js";
import { pathExists, resolveAllowedProject } from "../project-index.js";
import type { AuditLogger } from "../security/audit-log.js";
import { classifyBlockedPath, isGitIgnored, redactContent } from "../security/redaction.js";
import type { ToolContext } from "../tool-context.js";

const execFileAsync = promisify(execFile);
const GIT_DIFF_FAILURE = "git_diff failed while reading the run worktree.";

export const gitDiffInputSchema = z.object({
  runHandle: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  maxDiffBytes: z.number().int().positive().optional()
});

type DiffKind = "added" | "modified" | "deleted" | "renamed" | "blocked";
type BlockReason = Extract<ErrorCode, "E_SECRET_BLOCKED" | "E_GITIGNORED">;

export type DiffFile = {
  path: string;
  oldPath?: string;
  kind: DiffKind;
  untracked: boolean;
  additions: number;
  deletions: number;
  patch: string;
  patchTruncated?: true;
  blockedReason?: BlockReason;
};

export type GitDiffResult = Bounded<"files", DiffFile> & {
  base: string;
  branch: string;
  committed: boolean;
};

export type GitDiffOutput = GitDiffResult | ToolError;

type NumstatEntry = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
};

type PreparedDiffFile = DiffFile & {
  estimatedBytes: number;
};

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotRepoError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
  const text = `${nodeError.stderr ?? ""}\n${nodeError.message ?? ""}`;
  return /not a git repository/.test(text);
}

async function git(worktreePath: string, args: string[], context: ToolContext): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, ...args], {
      timeout: Math.max(1, context.limits.toolTimeoutMs - 1000),
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    });
    return stdout;
  } catch (error) {
    if (isNotRepoError(error)) {
      throw new PlanbridgeError("E_NOT_A_REPO", "git_diff requires a git worktree.");
    }
    throw new PlanbridgeError("E_WORKTREE_FAILED", GIT_DIFF_FAILURE);
  }
}

function parseCount(value: string): number {
  return value === "-" ? 0 : Number.parseInt(value, 10);
}

function parseNumstat(output: string): NumstatEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const match = field.match(/^([-\d]+)\t([-\d]+)\t(.*)$/);
    if (!match) {
      continue;
    }
    const additions = parseCount(match[1]);
    const deletions = parseCount(match[2]);
    if (match[3] === "") {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      index += 2;
      entries.push({ path: newPath, oldPath, additions, deletions });
    } else {
      entries.push({ path: match[3], additions, deletions });
    }
  }
  return entries;
}

function splitPatchBlocks(patchText: string): string[] {
  return patchText
    .split(/(?=^diff --git )/m)
    .filter((block) => block.trim().length > 0);
}

function trackedKind(entry: NumstatEntry, patch: string): DiffKind {
  if (entry.oldPath) {
    return "renamed";
  }
  if (patch.includes("\nnew file mode ")) {
    return "added";
  }
  if (patch.includes("\ndeleted file mode ")) {
    return "deleted";
  }
  return "modified";
}

function pathsForTrackedEntry(entry: NumstatEntry): string[] {
  return entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
}

async function blockedReasonForTrackedEntry(projectRoot: string, entry: NumstatEntry): Promise<BlockReason | undefined> {
  for (const candidate of pathsForTrackedEntry(entry)) {
    const blocked = classifyBlockedPath(candidate);
    if (blocked.blocked) {
      return blocked.reason;
    }
  }
  for (const candidate of pathsForTrackedEntry(entry)) {
    if (await isGitIgnored(projectRoot, candidate)) {
      return "E_GITIGNORED";
    }
  }
  return undefined;
}

async function appendBlockedAudit(input: {
  audit: AuditLogger;
  project: string;
  path: string;
  reason: BlockReason;
  sessionId: string;
}): Promise<void> {
  await input.audit.append({
    event: "blocked",
    tool: "git_diff",
    project: input.project,
    path: input.path,
    blockReason: input.reason,
    sessionId: input.sessionId
  });
}

async function statSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function lstatSize(filePath: string): Promise<number> {
  try {
    return (await lstat(filePath)).size;
  } catch {
    return 0;
  }
}

async function blockFile(input: {
  audit: AuditLogger;
  project: string;
  path: string;
  oldPath?: string;
  reason: BlockReason;
  sessionId: string;
  untracked: boolean;
  estimatedBytes: number;
}): Promise<PreparedDiffFile> {
  await appendBlockedAudit({
    audit: input.audit,
    project: input.project,
    path: input.path,
    reason: input.reason,
    sessionId: input.sessionId
  });
  return {
    path: input.path,
    ...(input.oldPath ? { oldPath: input.oldPath } : {}),
    kind: "blocked",
    untracked: input.untracked,
    additions: 0,
    deletions: 0,
    patch: "",
    blockedReason: input.reason,
    estimatedBytes: input.estimatedBytes
  };
}

async function prepareTrackedFile(input: {
  entry: NumstatEntry;
  patch: string;
  projectName: string;
  audit: AuditLogger;
  sessionId: string;
}): Promise<PreparedDiffFile> {
  const kind = trackedKind(input.entry, input.patch);
  const baseFile: DiffFile = {
    path: input.entry.path,
    ...(input.entry.oldPath ? { oldPath: input.entry.oldPath } : {}),
    kind,
    untracked: false,
    additions: input.entry.additions,
    deletions: input.entry.deletions,
    patch: input.patch
  };
  const redacted = await redactContent({
    content: input.patch,
    path: baseFile.path,
    audit: input.audit,
    sessionId: input.sessionId,
    tool: "git_diff",
    project: input.projectName
  });
  return {
    ...baseFile,
    patch: redacted.content,
    estimatedBytes: Buffer.byteLength(redacted.content, "utf8")
  };
}

function lineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return lines.length;
}

function synthesizeAddedPatch(relativePath: string, content: string): string {
  const lines = content.length === 0 ? [] : content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    ""
  ].join("\n");
}

function containsBinaryNul(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

async function prepareUntrackedFile(input: {
  worktreePath: string;
  relativePath: string;
  projectName: string;
  audit: AuditLogger;
  sessionId: string;
}): Promise<PreparedDiffFile> {
  const blocked = classifyBlockedPath(input.relativePath);
  const absolutePath = path.resolve(input.worktreePath, input.relativePath);
  const worktreeRealPath = await realpath(input.worktreePath);
  if (blocked.blocked) {
    return blockFile({
      audit: input.audit,
      project: input.projectName,
      path: input.relativePath,
      reason: blocked.reason,
      sessionId: input.sessionId,
      untracked: true,
      estimatedBytes: await lstatSize(absolutePath)
    });
  }
  const linkStat = await lstat(absolutePath);
  if (linkStat.isSymbolicLink()) {
    return blockFile({
      audit: input.audit,
      project: input.projectName,
      path: input.relativePath,
      reason: "E_SECRET_BLOCKED",
      sessionId: input.sessionId,
      untracked: true,
      estimatedBytes: linkStat.size
    });
  }
  let realPath: string;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return blockFile({
      audit: input.audit,
      project: input.projectName,
      path: input.relativePath,
      reason: "E_SECRET_BLOCKED",
      sessionId: input.sessionId,
      untracked: true,
      estimatedBytes: await lstatSize(absolutePath)
    });
  }
  if (!isInside(worktreeRealPath, realPath)) {
    return blockFile({
      audit: input.audit,
      project: input.projectName,
      path: input.relativePath,
      reason: "E_SECRET_BLOCKED",
      sessionId: input.sessionId,
      untracked: true,
      estimatedBytes: await lstatSize(absolutePath)
    });
  }

  const fileStat = await stat(realPath);
  const buffer = await readFile(realPath);
  if (containsBinaryNul(buffer)) {
    return {
      path: input.relativePath,
      kind: "added",
      untracked: true,
      additions: 0,
      deletions: 0,
      patch: `Binary file added (${fileStat.size} bytes)`,
      estimatedBytes: fileStat.size
    };
  }

  const content = buffer.toString("utf8");
  const patch = synthesizeAddedPatch(input.relativePath, content);
  const redacted = await redactContent({
    content: patch,
    path: input.relativePath,
    audit: input.audit,
    sessionId: input.sessionId,
    tool: "git_diff",
    project: input.projectName
  });
  return {
    path: input.relativePath,
    kind: "added",
    untracked: true,
    additions: lineCount(content),
    deletions: 0,
    patch: redacted.content,
    estimatedBytes: Buffer.byteLength(redacted.content, "utf8")
  };
}

function untrackedPaths(output: string): string[] {
  return output
    .split("\0")
    .filter(Boolean)
    .sort();
}

function dropPartialPemBlock(content: string): string {
  const lastBegin = content.lastIndexOf("-----BEGIN ");
  const lastEnd = content.lastIndexOf("-----END ");
  if (lastBegin > lastEnd) {
    return content.slice(0, lastBegin);
  }
  return content;
}

export function truncateOnLineBoundary(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let output = "";
  for (const line of lines) {
    if (Buffer.byteLength(output + line, "utf8") > maxBytes) {
      break;
    }
    output += line;
  }
  return dropPartialPemBlock(output);
}

function trackedPatchPathspecs(entries: NumstatEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => pathsForTrackedEntry(entry)))];
}

async function patchTextForAllowedTrackedEntries(input: {
  worktreePath: string;
  baseSha: string;
  entries: NumstatEntry[];
  context: ToolContext;
}): Promise<string> {
  const pathspecs = trackedPatchPathspecs(input.entries);
  return git(
    input.worktreePath,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      input.baseSha,
      "--",
      ...(pathspecs.length > 0 ? pathspecs : [".git/PLANBRIDGE_NO_ALLOWED_TRACKED_DIFFS"])
    ],
    input.context
  );
}

function applyBudget(
  files: PreparedDiffFile[],
  maxDiffBytes: number
): { files: DiffFile[]; truncated: boolean; totalEstimate: number; returnedBytes: number } {
  let remaining = maxDiffBytes;
  let truncated = false;
  let totalEstimate = 0;
  let returnedBytes = 0;
  const budgeted = files.map((file) => {
    if (file.kind === "blocked") {
      totalEstimate += file.estimatedBytes;
      const { estimatedBytes: _estimatedBytes, ...withoutEstimate } = file;
      return withoutEstimate;
    }

    const fullSize = Buffer.byteLength(file.patch, "utf8");
    if (fullSize <= remaining) {
      totalEstimate += file.estimatedBytes;
      returnedBytes += fullSize;
      remaining -= fullSize;
      const { estimatedBytes: _estimatedBytes, ...withoutEstimate } = file;
      return withoutEstimate;
    }

    truncated = true;
    const patch = truncateOnLineBoundary(file.patch, remaining);
    const returnedSize = Buffer.byteLength(patch, "utf8");
    totalEstimate += file.patch.startsWith("Binary file added (") ? file.estimatedBytes : returnedSize;
    returnedBytes += returnedSize;
    remaining = 0;
    const { estimatedBytes: _estimatedBytes, ...withoutEstimate } = file;
    return { ...withoutEstimate, patch, patchTruncated: true as const };
  });

  return { files: budgeted, truncated, totalEstimate, returnedBytes };
}

async function collectRunDiff(input: {
  runHandle: string;
  maxDiffBytes: number;
  context: ToolContext;
}): Promise<GitDiffResult> {
  const target = await readRunDiffTarget(input.context.home, input.runHandle);
  if (!target) {
    throw new PlanbridgeError("E_NOT_FOUND", "Codex run record was not found.");
  }
  if (!target.baseSha) {
    throw new PlanbridgeError("E_NOT_FOUND", "Codex run has no recorded base commit.");
  }
  const project = await resolveAllowedProject(input.context.config, target.project, planbridgeHome({ HOME: input.context.home }));
  if (!(await pathExists(target.worktreePath))) {
    throw new PlanbridgeError("E_NOT_FOUND", "Codex run worktree was not found.");
  }
  const head = (await git(target.worktreePath, ["rev-parse", "HEAD"], input.context)).trim();
  const numstat = await git(
    target.worktreePath,
    ["diff", "--no-color", "--no-ext-diff", "--numstat", "-z", "--find-renames", target.baseSha, "--"],
    input.context
  );
  const trackedEntries = parseNumstat(numstat);
  const trackedPlans = await Promise.all(
    trackedEntries.map(async (entry) => ({
      entry,
      blockedReason: await blockedReasonForTrackedEntry(project.root, entry)
    }))
  );
  const allowedTrackedEntries = trackedPlans.filter((plan) => !plan.blockedReason).map((plan) => plan.entry);
  const patchText = await patchTextForAllowedTrackedEntries({
    worktreePath: target.worktreePath,
    baseSha: target.baseSha,
    entries: allowedTrackedEntries,
    context: input.context
  });
  const untracked = await git(target.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], input.context);

  const patchBlocks = splitPatchBlocks(patchText);
  const trackedFiles: PreparedDiffFile[] = [];
  let allowedPatchIndex = 0;
  for (const plan of trackedPlans) {
    if (plan.blockedReason) {
      trackedFiles.push(
        await blockFile({
          audit: input.context.audit,
          project: project.name,
          path: plan.entry.path,
          oldPath: plan.entry.oldPath,
          reason: plan.blockedReason,
          sessionId: input.context.session.id,
          untracked: false,
          estimatedBytes: await statSize(path.join(target.worktreePath, plan.entry.path))
        })
      );
      continue;
    }
    trackedFiles.push(
      await prepareTrackedFile({
        entry: plan.entry,
        patch: patchBlocks[allowedPatchIndex] ?? "",
        projectName: project.name,
        audit: input.context.audit,
        sessionId: input.context.session.id
      })
    );
    allowedPatchIndex += 1;
  }
  const untrackedFiles: PreparedDiffFile[] = [];
  for (const relativePath of untrackedPaths(untracked)) {
    untrackedFiles.push(
      await prepareUntrackedFile({
        worktreePath: target.worktreePath,
        relativePath,
        projectName: project.name,
        audit: input.context.audit,
        sessionId: input.context.session.id
      })
    );
  }

  const budgeted = applyBudget([...trackedFiles, ...untrackedFiles], input.maxDiffBytes);
  await input.context.audit.append({
    event: "read",
    tool: "git_diff",
    project: project.name,
    runId: input.runHandle,
    bytes: budgeted.returnedBytes,
    filesTouched: budgeted.files.length,
    sessionId: input.context.session.id
  });

  return {
    base: target.baseSha,
    branch: target.branch,
    committed: head !== target.baseSha,
    files: budgeted.files,
    truncated: budgeted.truncated,
    total_estimate: budgeted.totalEstimate
  };
}

export async function gitDiffTool(rawInput: unknown, context: ToolContext): Promise<GitDiffOutput> {
  try {
    const parsed = gitDiffInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PlanbridgeError("E_HANDOFF_INCOMPLETE", "git_diff requires a run handle.");
    }
    const input = parsed.data;
    return await collectRunDiff({
      runHandle: input.runHandle,
      maxDiffBytes: Math.min(input.maxDiffBytes ?? context.limits.maxDiffBytes, context.limits.maxDiffBytes),
      context
    });
  } catch (error) {
    return toToolError(error);
  }
}
