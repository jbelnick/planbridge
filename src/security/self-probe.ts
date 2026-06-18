import type { RequestHandler } from "express";
import type { AuditLogger } from "./audit-log.js";

export type ProbeStatus = "breach" | "healthy";

export type ProbeResponse = {
  status: number;
  body: unknown;
};

export type ProbeRequest = (url: string) => Promise<ProbeResponse>;

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type SelfProbe = {
  start(): void;
  stop(): void;
  runOnce(): Promise<ProbeStatus>;
  serving(): boolean;
  gate: RequestHandler;
};

export type SelfProbeInput = {
  publicMcpUrl: string;
  audit: AuditLogger;
  intervalMs?: number;
  consecutiveBreaches?: number;
  timeoutMs?: number;
  probeRequest?: ProbeRequest;
  onHardAlert?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyProbe(response: ProbeResponse): ProbeStatus {
  if (response.status < 200 || response.status > 299) {
    return "healthy";
  }
  const body = parseBody(response.body);
  if (!isRecord(body) || body.jsonrpc !== "2.0" || !isRecord(body.result)) {
    return "healthy";
  }
  return typeof body.result.protocolVersion === "string" && "serverInfo" in body.result ? "breach" : "healthy";
}

export async function defaultProbeRequest(url: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "planbridge-self-probe", version: "1.0.0" }
        }
      })
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

export function createSelfProbe(input: SelfProbeInput): SelfProbe {
  const intervalMs = input.intervalMs ?? 60_000;
  const breachThreshold = input.consecutiveBreaches ?? 2;
  const probeRequest = input.probeRequest ?? ((url: string) => defaultProbeRequest(url, input.timeoutMs));
  const stderr = input.stderr ?? process.stderr;
  let consecutive = 0;
  let tripped = false;
  let interval: NodeJS.Timeout | undefined;
  let alerting: Promise<void> | undefined;

  async function trip(): Promise<void> {
    if (tripped) {
      return;
    }
    tripped = true;
    await input.audit.append({
      event: "security",
      outcome: "reachable-unauthenticated",
      tool: "self-probe",
      blockReason: "E_SELF_PROBE_OPEN",
      sessionId: "transport"
    });
    stderr.write(
      `PLANBRIDGE CRITICAL: public endpoint ${input.publicMcpUrl} is reachable WITHOUT access control. Refusing to serve. Remediate the tunnel/network secret and restart.\n`
    );
    alerting = Promise.resolve(
      input.onHardAlert
        ? input.onHardAlert()
        : (async () => {
            await input.close?.();
            process.exitCode = 70;
          })()
    ).then(() => undefined);
    await alerting;
  }

  const selfProbe: SelfProbe = {
    start() {
      if (interval) {
        return;
      }
      interval = setInterval(() => {
        void selfProbe.runOnce();
      }, intervalMs);
      interval.unref();
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    },
    async runOnce() {
      if (tripped) {
        await alerting;
        return "breach";
      }
      let status: ProbeStatus;
      try {
        status = classifyProbe(await probeRequest(input.publicMcpUrl));
      } catch {
        status = "healthy";
      }
      if (status === "healthy") {
        consecutive = 0;
        return status;
      }
      consecutive += 1;
      if (consecutive >= breachThreshold) {
        await trip();
      }
      return status;
    },
    serving() {
      return !tripped;
    },
    gate(_req, res, next) {
      if (!selfProbe.serving()) {
        res.status(503).json({ error: "E_SELF_PROBE_OPEN" });
        return;
      }
      next();
    }
  };
  return selfProbe;
}
