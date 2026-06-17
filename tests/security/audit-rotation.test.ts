import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAuditLogger } from "../../src/security/audit-log.js";
import { maybeRotate } from "../../src/security/audit-rotation.js";

describe("audit rotation", () => {
  it("rotates by size, caps maxFiles, prunes old rotations, and keeps fresh log mode 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "planbridge-audit-rotation-"));
    const logPath = path.join(root, "audit.log");
    const logger = createAuditLogger(logPath, { maxBytes: 80, maxFiles: 2, maxAgeDays: 90 });

    await logger.append({ event: "read", tool: "repo_read_files", sessionId: "s1", bytes: 100 });
    await logger.append({ event: "read", tool: "repo_read_files", sessionId: "s1", bytes: 100 });
    await logger.append({ event: "read", tool: "repo_read_files", sessionId: "s1", bytes: 100 });

    await expect(stat(`${logPath}.1`)).resolves.toBeDefined();
    await expect(stat(`${logPath}.3`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);

    await writeFile(`${logPath}.2`, "old\n", { mode: 0o600 });
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await utimes(`${logPath}.2`, old, old);
    await maybeRotate(logPath, { maxBytes: 1024 * 1024, maxFiles: 2, maxAgeDays: 90 });
    await expect(stat(`${logPath}.2`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not throw from append when rotation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "planbridge-audit-rotation-failure-"));
    const logPath = path.join(root, "audit.log");
    await writeFile(logPath, "x".repeat(200), { mode: 0o600 });
    await mkdir(`${logPath}.1`, { recursive: true });

    const logger = createAuditLogger(logPath, { maxBytes: 10, maxFiles: 1, maxAgeDays: 90 });
    await expect(logger.append({ event: "read", tool: "repo_read_files", sessionId: "s1" })).resolves.toBeUndefined();
    await expect(readFile(logPath, "utf8")).resolves.toContain('"tool":"repo_read_files"');
  });
});
