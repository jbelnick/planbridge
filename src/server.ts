import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import express, { type Request } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { PlanbridgeConfig } from "./config.js";
import {
  assertHttpsPublicUrl,
  ConfigSchema,
  effectiveAuditRetention,
  loadConfig,
  planbridgeHome,
  resolveRateLimit,
  resolveSelfProbe
} from "./config.js";
import { connectorUrl } from "./cli.js";
import { createNetworkAuthMiddleware } from "./security/auth-middleware.js";
import { createAuditLogger } from "./security/audit-log.js";
import { createRateLimiter } from "./security/rate-limit.js";
import { createSelfProbe, type ProbeRequest, type SelfProbe } from "./security/self-probe.js";
import { createPlanbridgeMcpServer } from "./tool-registry.js";
import type { SessionState } from "./tool-context.js";
import type { ProConsultRunner } from "./adapters/pro-consult.js";

const OAUTH_RUNTIME_NOT_IMPLEMENTED =
  "OAuth runtime is not implemented in this build; use --access-control network or the Secure MCP Tunnel.";

export type RunningPlanbridgeServer = {
  host: "127.0.0.1";
  port: number;
  url: string;
  selfProbe?: SelfProbe;
  close(): Promise<void>;
};

type StartServerInput = {
  config?: PlanbridgeConfig;
  home?: string;
  probeRequest?: ProbeRequest;
  onHardAlert?: () => void | Promise<void>;
  now?: () => number;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  proConsultRunner?: ProConsultRunner;
};

function listen(app: ReturnType<typeof createMcpExpressApp>, port: number, host: "127.0.0.1"): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on("error", reject);
  });
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function metadataBaseUrl(req: Request, config: PlanbridgeConfig): string {
  if (config.connection.kind === "public-url") {
    return config.connection.publicBaseUrl.replace(/\/$/, "");
  }
  const forwardedProto = firstForwardedValue(req.get("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(req.get("x-forwarded-host"));
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`.replace(/\/$/, "");
  }
  return `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
}

export async function startPlanbridgeServer(input: StartServerInput = {}): Promise<RunningPlanbridgeServer> {
  const config = ConfigSchema.parse(input.config ?? (await loadConfig(input.home ? { HOME: input.home } : process.env)));
  const home = input.home ?? process.env.HOME ?? "";
  if (config.connection.kind === "public-url" && config.auth.mode === "oauth") {
    throw new Error(OAUTH_RUNTIME_NOT_IMPLEMENTED);
  }
  if (config.connection.kind === "public-url") {
    assertHttpsPublicUrl(config.connection.publicBaseUrl);
  }
  const audit = createAuditLogger(path.join(planbridgeHome({ HOME: home }), "audit.log"), effectiveAuditRetention(config));
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let server: HttpServer | undefined;
  let closed = false;
  const closeServer = () =>
    new Promise<void>((resolve, reject) => {
      if (!server || closed) {
        resolve();
        return;
      }
      closed = true;
      server.close((error) => (error ? reject(error) : resolve()));
    });
  let selfProbe: SelfProbe | undefined;

  if (config.connection.kind === "public-url" && config.auth.accessControl?.kind === "network") {
    const probeConfig = resolveSelfProbe(config);
    selfProbe = createSelfProbe({
      publicMcpUrl: connectorUrl(config.connection.publicBaseUrl),
      audit,
      intervalMs: probeConfig.intervalMs,
      consecutiveBreaches: probeConfig.consecutiveBreaches,
      timeoutMs: probeConfig.timeoutMs,
      probeRequest: input.probeRequest,
      onHardAlert: input.onHardAlert,
      close: closeServer,
      stderr: input.stderr
    });
    app.use("/mcp", selfProbe.gate);
    app.use(
      "/mcp",
      createNetworkAuthMiddleware({
        secretHash: config.auth.accessControl.secretHash,
        limiter: createRateLimiter(resolveRateLimit(config), input.now),
        audit
      })
    );
  }

  app.use(express.json({ limit: "1mb" }));

  // tunnel-client readiness probes require discovery metadata even when runtime OAuth remains disabled.
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    const baseUrl = metadataBaseUrl(req, config);
    res.json({
      resource: connectorUrl(baseUrl),
      resource_name: "PlanBridge"
    });
  });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      let transport: StreamableHTTPServerTransport | undefined =
        typeof sessionId === "string" ? transports.get(sessionId) : undefined;

      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        const session: SessionState = { id: `pending-${randomUUID()}`, filesRead: 0 };
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId) => {
            session.id = initializedSessionId;
            if (transport) {
              transports.set(initializedSessionId, transport);
            }
          }
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
          }
        };
        await createPlanbridgeMcpServer({ config, home, session, proConsultRunner: input.proConsultRunner }).connect(transport);
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (process.env.NODE_ENV === "test") {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).send("GET /mcp is not enabled for PlanBridge M1");
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).send("DELETE /mcp is not enabled for PlanBridge M1");
  });

  const host = "127.0.0.1" as const;
  server = await listen(app, config.port, host);
  selfProbe?.start();
  const address = server.address() as AddressInfo;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    ...(selfProbe ? { selfProbe } : {}),
    close: async () => {
      selfProbe?.stop();
      await closeServer();
    }
  };
}

async function main(): Promise<void> {
  const running = await startPlanbridgeServer();
  process.stdout.write(`PlanBridge MCP server listening on ${running.url}/mcp\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
