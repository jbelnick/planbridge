import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditLogger } from "../../src/security/audit-log.js";
import { generateAccessSecret, hashAccessSecret, verifyAccessSecret } from "../../src/security/access-secret.js";
import { createNetworkAuthMiddleware } from "../../src/security/auth-middleware.js";
import { createRateLimiter } from "../../src/security/rate-limit.js";
import { createSelfProbe } from "../../src/security/self-probe.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  servers.length = 0;
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function auditEntries(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(logPath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("network access secret", () => {
  it("generates 256-bit hex secrets and verifies via sha256 fixed-width timingSafeEqual", () => {
    const secret = generateAccessSecret();
    const hash = hashAccessSecret(secret);

    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(secret);
    expect(verifyAccessSecret(secret, hash)).toBe(true);
    // Flip the last hex char to a guaranteed-different value (avoids reproducing
    // `secret` when it already ends in "0", which made this fixture flaky ~6%).
    const tampered = `${secret.slice(0, -1)}${secret.slice(-1) === "0" ? "1" : "0"}`;
    expect(verifyAccessSecret(tampered, hash)).toBe(false);
    expect(verifyAccessSecret("", hash)).toBe(false);
    expect(verifyAccessSecret(secret, "")).toBe(false);
  });
});

describe("network auth middleware", () => {
  it("redacts Authorization before downstream handlers and returns the same generic 401 for missing, malformed, and wrong headers", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-auth-"));
    const logPath = path.join(tmp, "audit.log");
    const secret = generateAccessSecret();
    const app = express();
    const downstreamHeaders: Array<string | undefined> = [];
    app.use(
      createNetworkAuthMiddleware({
        secretHash: hashAccessSecret(secret),
        limiter: createRateLimiter({
          windowMs: 60_000,
          maxFailures: 5,
          lockoutThreshold: 10,
          lockoutMs: 900_000,
          backoffBaseMs: 1_000
        }),
        audit: createAuditLogger(logPath)
      })
    );
    app.post("/mcp", (req, res) => {
      downstreamHeaders.push(req.headers.authorization);
      res.json({ ok: true });
    });
    const url = await listen(app);

    const missing = await fetch(`${url}/mcp`, { method: "POST" });
    const malformed = await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: "Basic nope" } });
    const wrong = await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong" } });
    const valid = await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });

    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "E_AUTH_FAILED" });
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toEqual({ error: "E_AUTH_FAILED" });
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "E_AUTH_FAILED" });
    expect(valid.status).toBe(200);
    expect(downstreamHeaders).toEqual([undefined]);

    const audit = await readFile(logPath, "utf8");
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain("Authorization");
    expect(await auditEntries(logPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "security", outcome: "authfail", blockReason: "E_AUTH_FAILED" })
      ])
    );
  });

  it("rate-limits auth failures without writing rate state to audit", async () => {
    let now = 1_000;
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-rate-auth-"));
    const logPath = path.join(tmp, "audit.log");
    const app = express();
    app.use(
      createNetworkAuthMiddleware({
        secretHash: hashAccessSecret(generateAccessSecret()),
        limiter: createRateLimiter(
          { windowMs: 60_000, maxFailures: 5, lockoutThreshold: 10, lockoutMs: 900_000, backoffBaseMs: 1_000 },
          () => now
        ),
        audit: createAuditLogger(logPath)
      })
    );
    app.post("/mcp", (_req, res) => res.json({ ok: true }));
    const url = await listen(app);

    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong" } });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong" } });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    await expect(limited.json()).resolves.toEqual({ error: "E_AUTH_RATE_LIMITED" });
    const auditText = await readFile(logPath, "utf8");
    expect(auditText).toContain("E_AUTH_RATE_LIMITED");
    expect(auditText).not.toMatch(/remainingAttempts|"locked"|attempts/);
  });

  it("never logs the access secret across an auth request and self-probe breach", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-secret-log-"));
    const logPath = path.join(tmp, "audit.log");
    const secret = generateAccessSecret();
    const audit = createAuditLogger(logPath);
    const stderrWrites: string[] = [];

    const app = express();
    app.use(
      createNetworkAuthMiddleware({
        secretHash: hashAccessSecret(secret),
        limiter: createRateLimiter(),
        audit
      })
    );
    app.post("/mcp", (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });

    const probe = createSelfProbe({
      publicMcpUrl: "https://planbridge.example.test/mcp",
      audit,
      probeRequest: async () => ({
        status: 200,
        body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: { name: "planbridge" } } }
      }),
      stderr: { write: (chunk: string) => { stderrWrites.push(chunk); return true; } },
      onHardAlert: vi.fn()
    });
    await probe.runOnce();
    await probe.runOnce();

    const auditText = await readFile(logPath, "utf8");
    expect(auditText).not.toContain(secret);
    expect(stderrWrites.join("")).not.toContain(secret);
  });
});
