import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export type AuditRetention = {
  maxBytes: number;
  maxFiles: number;
  maxAgeDays: number;
};

export const DEFAULT_AUDIT_RETENTION: AuditRetention = {
  maxBytes: 8 * 1024 * 1024,
  maxFiles: 5,
  maxAgeDays: 90
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function pruneByAge(logPath: string, retention: AuditRetention): Promise<void> {
  const cutoff = Date.now() - retention.maxAgeDays * 24 * 60 * 60 * 1000;
  for (let index = 1; index <= retention.maxFiles; index += 1) {
    const rotatedPath = `${logPath}.${index}`;
    if (!(await exists(rotatedPath))) {
      continue;
    }
    const fileStat = await stat(rotatedPath);
    if (fileStat.mtimeMs < cutoff) {
      await rm(rotatedPath, { force: true });
    }
  }
}

async function rotateBySize(logPath: string, retention: AuditRetention): Promise<void> {
  if (!(await exists(logPath))) {
    return;
  }
  const fileStat = await stat(logPath);
  if (fileStat.size < retention.maxBytes) {
    return;
  }
  await rm(`${logPath}.${retention.maxFiles}`, { force: true });
  for (let index = retention.maxFiles - 1; index >= 1; index -= 1) {
    const from = `${logPath}.${index}`;
    if (await exists(from)) {
      await rename(from, `${logPath}.${index + 1}`);
    }
  }
  await rename(logPath, `${logPath}.1`);
}

export async function maybeRotate(logPath: string, retentionInput: Partial<AuditRetention> = {}): Promise<void> {
  const retention = { ...DEFAULT_AUDIT_RETENTION, ...retentionInput };
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await rotateBySize(logPath, retention);
    await pruneByAge(logPath, retention);
  } catch {
    return;
  }
}
