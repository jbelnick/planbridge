import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ErrorCode } from "../errors.js";
import { maybeRotate, type AuditRetention } from "./audit-rotation.js";

export type AuditEvent = "read" | "search" | "blocked" | "redact" | "handoff" | "status" | "exec" | "security";
export type AuditOutcome = "authfail" | "reachable-unauthenticated";

export type AuditEntry = {
  ts: string;
  event: AuditEvent;
  outcome?: AuditOutcome;
  tool: string;
  project?: string;
  path?: string;
  blockReason?: ErrorCode;
  sessionId: string;
  bytes?: number;
  filesTouched?: number;
  runId?: string;
};

export type AuditLogger = {
  readonly logPath: string;
  append(entry: Omit<AuditEntry, "ts">): Promise<void>;
};

export function createAuditLogger(logPath: string, retention?: Partial<AuditRetention>): AuditLogger {
  return {
    logPath,
    async append(entry) {
      await mkdir(path.dirname(logPath), { recursive: true });
      await maybeRotate(logPath, retention);
      const safeEntry: AuditEntry = {
        ...entry,
        ts: new Date().toISOString()
      };
      await appendFile(logPath, `${JSON.stringify(safeEntry)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  };
}
