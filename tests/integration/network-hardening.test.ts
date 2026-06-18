import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSetup } from "../../src/cli.js";
import type { PlanbridgeConfig } from "../../src/config.js";
import { hashAccessSecret } from "../../src/security/access-secret.js";
import { startPlanbridgeServer, type RunningPlanbridgeServer } from "../../src/server.js";
import { createFixtureProject } from "../helpers/fixtures.js";

const OAUTH_NOT_IMPLEMENTED = "OAuth runtime is not implemented in this build; use --access-control network or the Secure MCP Tunnel.";

let running: RunningPlanbridgeServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function publicNetworkConfig(fixture: Awaited<ReturnType<typeof createFixtureProject>>, secretHash = hashAccessSecret("correct-secret")): PlanbridgeConfig {
  return {
    schemaVersion: "1.0",
    projectsRoot: fixture.projectsRoot,
    allowlist: ["alpha"],
    port: 0,
    transport: "streamable-http",
    connection: { kind: "public-url", publicBaseUrl: "https://planbridge.example.test" },
    auth: { mode: "none", accessControl: { kind: "network", configured: true, secretHash } },
    selfProbe: { intervalMs: 60_000, consecutiveBreaches: 2 }
  };
}

async function postInitialize(url: string, secret?: string): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "network-hardening-test", version: "0.1.0" }
      }
    })
  });
}

describe("network hardening integration", () => {
  it("fails closed for public-url oauth in setup and server startup", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        fixture.projectsRoot,
        "--allowlist",
        "alpha",
        "--public-base-url",
        "https://planbridge.example.test/mcp",
        "--access-control",
        "oauth"
      ], { HOME: fixture.home })
    ).rejects.toThrow(OAUTH_NOT_IMPLEMENTED);

    await expect(
      startPlanbridgeServer({
        home: fixture.home,
        config: {
          schemaVersion: "1.0",
          projectsRoot: fixture.projectsRoot,
          allowlist: ["alpha"],
          port: 0,
          transport: "streamable-http",
          connection: { kind: "public-url", publicBaseUrl: "https://planbridge.example.test" },
          auth: { mode: "oauth" }
        }
      })
    ).rejects.toThrow(OAUTH_NOT_IMPLEMENTED);
  });

  it("refuses startup for hand-edited non-HTTPS public URLs and keeps localhost bound to 127.0.0.1", async () => {
    const fixture = await createFixtureProject("alpha");
    await expect(
      startPlanbridgeServer({
        home: fixture.home,
        config: {
          ...publicNetworkConfig(fixture),
          connection: { kind: "public-url", publicBaseUrl: "http://planbridge.example.test" }
        } as PlanbridgeConfig
      })
    ).rejects.toThrow("public base URL must use HTTPS");

    running = await startPlanbridgeServer({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 0,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      }
    });
    expect(running.host).toBe("127.0.0.1");
  });

  it("mounts auth only for public-url network mode and deletes unauthenticated public requests", async () => {
    const fixture = await createFixtureProject("alpha");
    const probeRequest = vi.fn().mockResolvedValue({ status: 401, body: { error: "E_AUTH_FAILED" } });
    const onHardAlert = vi.fn();
    running = await startPlanbridgeServer({
      home: fixture.home,
      config: publicNetworkConfig(fixture),
      probeRequest,
      onHardAlert
    });

    const unauthenticated = await postInitialize(running.url);
    const authenticated = await postInitialize(running.url, "correct-secret");

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ error: "E_AUTH_FAILED" });
    expect(authenticated.status).not.toBe(401);
    expect(onHardAlert).not.toHaveBeenCalled();
    expect(probeRequest).not.toHaveBeenCalled();
  });

  it("gates public-url network traffic with 503 after two self-probe breaches", async () => {
    const fixture = await createFixtureProject("alpha");
    const onHardAlert = vi.fn();
    running = await startPlanbridgeServer({
      home: fixture.home,
      config: publicNetworkConfig(fixture),
      probeRequest: async () => ({
        status: 200,
        body: { jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", serverInfo: { name: "planbridge" } } }
      }),
      onHardAlert
    });

    await running.selfProbe?.runOnce();
    await running.selfProbe?.runOnce();
    const response = await postInitialize(running.url, "correct-secret");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "E_SELF_PROBE_OPEN" });
    expect(onHardAlert).toHaveBeenCalledTimes(1);
    const audit = await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8");
    expect(audit).toContain('"outcome":"reachable-unauthenticated"');
  });

  it("does not construct self-probe or auth middleware for localhost or secure-tunnel", async () => {
    const fixture = await createFixtureProject("alpha");
    const probeRequest = vi.fn();
    running = await startPlanbridgeServer({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 0,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      probeRequest
    });
    const client = new Client({ name: "localhost-hardening-test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
    await expect(client.listTools()).resolves.toBeDefined();
    await client.close();
    await running.close();
    running = undefined;

    const tunnel = await createFixtureProject("alpha");
    running = await startPlanbridgeServer({
      home: tunnel.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: tunnel.projectsRoot,
        allowlist: ["alpha"],
        port: 0,
        transport: "streamable-http",
        connection: { kind: "secure-tunnel", tunnelId: "tunnel_0123456789abcdef0123456789abcdef" },
        auth: { mode: "none" }
      },
      probeRequest
    });
    expect(running.selfProbe).toBeUndefined();
    expect(probeRequest).not.toHaveBeenCalled();
  });

  it("serves no-auth tunnel-client discovery metadata without enabling OAuth runtime auth", async () => {
    const fixture = await createFixtureProject("alpha");
    running = await startPlanbridgeServer({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 0,
        transport: "streamable-http",
        connection: { kind: "secure-tunnel", tunnelId: "tunnel_0123456789abcdef0123456789abcdef" },
        auth: { mode: "none" }
      }
    });

    const protectedResource = await fetch(`${running.url}/.well-known/oauth-protected-resource/mcp`);
    await expect(protectedResource.json()).resolves.toEqual({
      resource: `${running.url}/mcp`,
      resource_name: "PlanBridge"
    });

    const authorizationServer = await fetch(`${running.url}/.well-known/oauth-authorization-server`);
    expect(authorizationServer.status).toBe(404);
    const authorize = await fetch(`${running.url}/authorize`);
    expect(authorize.status).toBe(404);
    const token = await fetch(`${running.url}/token`, { method: "POST" });
    expect(token.status).toBe(404);
  });
});
