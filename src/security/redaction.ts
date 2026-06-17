import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ErrorCode } from "../errors.js";
import { PlanbridgeError } from "../errors.js";
import type { AuditLogger } from "./audit-log.js";
import { resolveProjectPath, type ResolvedProject } from "./paths.js";

const REDACTION_PLACEHOLDER = "[PLANBRIDGE_REDACTED]";

type BlockedPath = { blocked: true; reason: Extract<ErrorCode, "E_SECRET_BLOCKED" | "E_GITIGNORED"> };
type AllowedPath = { blocked: false };

export type ReadAllowedTextFileInput = {
  project: ResolvedProject;
  relativePath: string;
  maxBytesPerFile: number;
  audit: AuditLogger;
  sessionId: string;
  tool?: string;
  filesTouched?: number;
};

export type ReadAllowedTextFileResult =
  | {
      file: {
        path: string;
        bytes: number;
        truncated: boolean;
        content: string;
      };
    }
  | {
      blocked: {
        path: string;
        reason: ErrorCode;
      };
    };

const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env($|[./-])/,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)(\.aws|\.config\/gh|\.gnupg)(\/|$)/,
  /keychain/i,
  /browser profile/i,
  /(^|\/)(chrome|chromium|firefox|brave|edge)(\/|$)/i,
  /(^|\/)(credentials|credential|token|tokens|auth|session)(\.|\/|$)/i,
  /(^|\/)secrets?(\.|\/|$)/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /(^|\/)\.(kube|docker)(\/|$)/i,
  /\.(pem|key|p12|pfx|cer|crt)$/i,
  /(^|\/)\.planbridge(\/|$)/
];

const REDACTION_PATTERNS: RegExp[] = [
  /-----BEGIN[\s\S]*?-----END [A-Z ]+-----/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9_]{16,}/g,
  /xox[a-zA-Z]?-[A-Za-z0-9-]{8,}/g,
  /\b[A-Za-z0-9+/=_-]{32,}\b/g
];

function normalizeForMatch(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function classifyBlockedPath(relativePath: string): BlockedPath | AllowedPath {
  const normalized = normalizeForMatch(relativePath);
  if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { blocked: true, reason: "E_SECRET_BLOCKED" };
  }
  return { blocked: false };
}

async function readGitignorePatterns(projectRoot: string): Promise<string[]> {
  try {
    const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    return gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function matchesGitignorePattern(relativePath: string, pattern: string): boolean {
  const normalized = normalizeForMatch(relativePath);
  const cleanPattern = pattern.replace(/^\//, "");
  if (cleanPattern.endsWith("/")) {
    const segment = cleanPattern.slice(0, -1);
    return normalized === segment || normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`);
  }
  if (!cleanPattern.includes("*")) {
    if (cleanPattern.includes("/")) {
      // A pattern containing a slash is anchored to the .gitignore's directory.
      return normalized === cleanPattern || normalized.startsWith(`${cleanPattern}/`);
    }
    // A slashless pattern matches a file or directory of that name at any depth.
    return normalized.split("/").includes(cleanPattern);
  }

  const escaped = cleanPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`(^|/)${escaped}$`).test(normalized);
}

export async function isGitIgnored(projectRoot: string, relativePath: string): Promise<boolean> {
  const patterns = await readGitignorePatterns(projectRoot);
  return patterns.some((pattern) => matchesGitignorePattern(relativePath, pattern));
}

export async function redactContent(input: {
  content: string;
  path: string;
  audit: AuditLogger;
  sessionId: string;
  tool: string;
  project?: string;
}): Promise<{ content: string; redactions: string[] }> {
  const redactions: string[] = [];
  let content = input.content;

  for (const pattern of REDACTION_PATTERNS) {
    content = content.replace(pattern, (match) => {
      redactions.push(match);
      return REDACTION_PLACEHOLDER;
    });
  }

  for (const _redaction of redactions) {
    await input.audit.append({
      event: "redact",
      tool: input.tool,
      project: input.project,
      path: input.path,
      sessionId: input.sessionId
    });
  }

  return { content, redactions };
}

async function blockReasonForRead(
  project: ResolvedProject,
  relativePath: string
): Promise<Extract<ErrorCode, "E_SECRET_BLOCKED" | "E_GITIGNORED"> | undefined> {
  const blocked = classifyBlockedPath(relativePath);
  if (blocked.blocked) {
    return blocked.reason;
  }
  if (await isGitIgnored(project.root, relativePath)) {
    return "E_GITIGNORED";
  }
  return undefined;
}

export async function readAllowedTextFile(input: ReadAllowedTextFileInput): Promise<ReadAllowedTextFileResult> {
  const tool = input.tool ?? "repo_read_files";
  const blockEvent = async (reason: Extract<ErrorCode, "E_SECRET_BLOCKED" | "E_GITIGNORED">) => {
    await input.audit.append({
      event: "blocked",
      tool,
      project: input.project.name,
      path: input.relativePath,
      blockReason: reason,
      sessionId: input.sessionId
    });
    return { blocked: { path: input.relativePath, reason } } as const;
  };

  const blockedByName = await blockReasonForRead(input.project, input.relativePath);
  if (blockedByName) {
    return blockEvent(blockedByName);
  }

  const resolved = await resolveProjectPath(input.project, input.relativePath);

  // Re-apply the denylist and gitignore to the RESOLVED target so a benign-named
  // symlink cannot reach a secret or gitignored file inside the project root.
  const resolvedRelative = normalizeForMatch(path.relative(input.project.root, resolved.realPath));
  if (resolvedRelative !== normalizeForMatch(input.relativePath)) {
    const blockedByTarget = await blockReasonForRead(input.project, resolvedRelative);
    if (blockedByTarget) {
      return blockEvent(blockedByTarget);
    }
  }

  const fileStat = await stat(resolved.realPath);
  if (!fileStat.isFile()) {
    throw new PlanbridgeError("E_NOT_FOUND", "Path is not a file.", input.relativePath);
  }

  const bytesToRead = Math.min(fileStat.size, input.maxBytesPerFile);
  const handle = await open(resolved.realPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    const redacted = await redactContent({
      content: buffer.toString("utf8"),
      path: input.relativePath,
      audit: input.audit,
      sessionId: input.sessionId,
      tool,
      project: input.project.name
    });
    await input.audit.append({
      event: "read",
      tool,
      project: input.project.name,
      path: input.relativePath,
      bytes: bytesToRead,
      filesTouched: input.filesTouched,
      sessionId: input.sessionId
    });
    return {
      file: {
        path: input.relativePath,
        bytes: bytesToRead,
        truncated: fileStat.size >= input.maxBytesPerFile,
        content: redacted.content
      }
    };
  } finally {
    await handle.close();
  }
}
