import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditLogger } from "../../src/security/audit-log.js";
import { classifyProbe, createSelfProbe, defaultProbeRequest } from "../../src/security/self-probe.js";

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

describe("self-probe classification", () => {
  it("classifies only a 2xx MCP initialize result as breach", () => {
    expect(
      classifyProbe({
        status: 200,
        body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: { name: "planbridge" } } }
      })
    ).toBe("breach");
    expect(classifyProbe({ status: 200, body: { jsonrpc: "2.0", error: { code: -32000, message: "No session" } } })).toBe("healthy");
    expect(classifyProbe({ status: 200, body: "<html>ok</html>" })).toBe("healthy");
    expect(classifyProbe({ status: 401, body: { error: "E_AUTH_FAILED" } })).toBe("healthy");
    expect(classifyProbe({ status: 200, body: { jsonrpc: "2.0", result: { protocolVersion: 123, serverInfo: {} } } })).toBe("healthy");
  });

  it("aborts the default probe request after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const pending = expect(defaultProbeRequest("https://planbridge.example.test/mcp", 10)).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(fetchMock).toHaveBeenCalledWith(
        "https://planbridge.example.test/mcp",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("self-probe hard alert", () => {
  it("debounces breaches, resets on healthy, then latches and never auto-clears", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-probe-"));
    const alert = vi.fn();
    const probe = createSelfProbe({
      publicMcpUrl: "https://planbridge.example.test/mcp",
      audit: createAuditLogger(path.join(tmp, "audit.log")),
      probeRequest: vi
        .fn()
        .mockResolvedValueOnce({ status: 200, body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: {} } } })
        .mockResolvedValueOnce({ status: 401, body: { error: "E_AUTH_FAILED" } })
        .mockResolvedValueOnce({ status: 200, body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: {} } } })
        .mockResolvedValueOnce({ status: 200, body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: {} } } }),
      onHardAlert: alert
    });

    await expect(probe.runOnce()).resolves.toBe("breach");
    expect(probe.serving()).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    await expect(probe.runOnce()).resolves.toBe("healthy");
    await expect(probe.runOnce()).resolves.toBe("breach");
    expect(probe.serving()).toBe(true);
    await expect(probe.runOnce()).resolves.toBe("breach");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(probe.serving()).toBe(false);
    await expect(probe.runOnce()).resolves.toBe("breach");
    expect(probe.serving()).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("writes metadata-only audit and the exact critical stderr line on trip", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-probe-audit-"));
    const logPath = path.join(tmp, "audit.log");
    const stderrWrites: string[] = [];
    const probe = createSelfProbe({
      publicMcpUrl: "https://planbridge.example.test/mcp",
      audit: createAuditLogger(logPath),
      probeRequest: async () => ({
        status: 200,
        body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: { secret: "probe-body" } } }
      }),
      stderr: { write: (chunk: string) => { stderrWrites.push(chunk); return true; } },
      onHardAlert: vi.fn()
    });

    await probe.runOnce();
    await probe.runOnce();

    expect(stderrWrites.join("")).toContain(
      "PLANBRIDGE CRITICAL: public endpoint https://planbridge.example.test/mcp is reachable WITHOUT access control. Refusing to serve. Remediate the tunnel/network secret and restart."
    );
    expect(stderrWrites.join("")).not.toContain("probe-body");
    const audit = await readFile(logPath, "utf8");
    expect(audit).toContain('"event":"security"');
    expect(audit).toContain('"outcome":"reachable-unauthenticated"');
    expect(audit).toContain('"blockReason":"E_SELF_PROBE_OPEN"');
    expect(audit).not.toContain("probe-body");
  });

  it("treats thrown probe requests as healthy and defaults to close plus exitCode 70", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-probe-default-"));
    const oldExitCode = process.exitCode;
    process.exitCode = undefined;
    const close = vi.fn();
    const probe = createSelfProbe({
      publicMcpUrl: "https://planbridge.example.test/mcp",
      audit: createAuditLogger(path.join(tmp, "audit.log")),
      probeRequest: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue({ status: 200, body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: {} } } }),
      close
    });

    await expect(probe.runOnce()).resolves.toBe("healthy");
    await probe.runOnce();
    await probe.runOnce();
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(70);
    process.exitCode = oldExitCode;
  });

  it("can gate requests with 503 after a trip", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "planbridge-probe-gate-"));
    const probe = createSelfProbe({
      publicMcpUrl: "https://planbridge.example.test/mcp",
      audit: createAuditLogger(path.join(tmp, "audit.log")),
      probeRequest: async () => ({ status: 200, body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: {} } } }),
      onHardAlert: vi.fn()
    });
    const app = express();
    app.use((_req, res, next) => {
      if (!probe.serving()) {
        res.status(503).json({ error: "E_SELF_PROBE_OPEN" });
        return;
      }
      next();
    });
    app.post("/mcp", (_req, res) => res.json({ ok: true }));
    const url = await listen(app);

    await probe.runOnce();
    await probe.runOnce();
    const first = await fetch(`${url}/mcp`, { method: "POST" });
    const second = await fetch(`${url}/mcp`, { method: "POST" });
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toEqual({ error: "E_SELF_PROBE_OPEN" });
    expect(second.status).toBe(503);
  });
});
