import express from "express";
import type { Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { createAuditLogger } from "../../src/security/audit-log.js";
import { hashAccessSecret } from "../../src/security/access-secret.js";
import { createNetworkAuthMiddleware } from "../../src/security/auth-middleware.js";
import { createRateLimiter } from "../../src/security/rate-limit.js";

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

describe("rate limiter", () => {
  it("uses an injected clock for backoff, lockout, recovery, and success reset", () => {
    let now = 0;
    const limiter = createRateLimiter(
      { windowMs: 60_000, maxFailures: 5, lockoutThreshold: 10, lockoutMs: 900_000, backoffBaseMs: 1_000 },
      () => now
    );

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check("127.0.0.1")).toEqual({ allowed: true });
      limiter.fail("127.0.0.1");
    }
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: false, retryAfterMs: 1_000 });

    for (let index = 0; index < 5; index += 1) {
      now += 2_000;
      expect(limiter.check("127.0.0.1")).toEqual({ allowed: true });
      limiter.fail("127.0.0.1");
    }
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: false, retryAfterMs: 900_000 });

    now += 900_001;
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: true });
    limiter.reset("127.0.0.1");
    for (let index = 0; index < 4; index += 1) {
      limiter.fail("127.0.0.1");
    }
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: true });
  });

  it("does not trust X-Forwarded-For as a way to evade the global req.ip bucket", async () => {
    const app = express();
    app.use(
      createNetworkAuthMiddleware({
        secretHash: hashAccessSecret("correct-secret"),
        limiter: createRateLimiter({ windowMs: 60_000, maxFailures: 5, lockoutThreshold: 10, lockoutMs: 900_000, backoffBaseMs: 1_000 }),
        audit: createAuditLogger("/tmp/planbridge-rate-limit-xff-audit.log")
      })
    );
    app.post("/mcp", (_req, res) => res.json({ ok: true }));
    const url = await listen(app);

    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong", "X-Forwarded-For": `203.0.113.${index}` }
      });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "X-Forwarded-For": "198.51.100.99" }
    });
    expect(limited.status).toBe(429);
  });
});
