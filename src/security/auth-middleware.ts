import type { RequestHandler } from "express";
import type { AuditLogger } from "./audit-log.js";
import type { RateLimiter } from "./rate-limit.js";
import { verifyAccessSecret } from "./access-secret.js";

export type NetworkAuthMiddlewareInput = {
  secretHash?: string;
  limiter: RateLimiter;
  audit: AuditLogger;
};

function bearerSecret(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

export function createNetworkAuthMiddleware(input: NetworkAuthMiddlewareInput): RequestHandler {
  return async (req, res, next) => {
    const authorization = req.headers.authorization;
    delete req.headers.authorization;
    const key = req.ip ?? "";
    const decision = input.limiter.check(key);
    if (!decision.allowed) {
      await input.audit.append({
        event: "security",
        outcome: "authfail",
        tool: "network-auth",
        blockReason: "E_AUTH_RATE_LIMITED",
        sessionId: "transport"
      });
      res.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
      res.status(429).json({ error: "E_AUTH_RATE_LIMITED" });
      return;
    }

    if (!verifyAccessSecret(bearerSecret(authorization), input.secretHash)) {
      input.limiter.fail(key);
      await input.audit.append({
        event: "security",
        outcome: "authfail",
        tool: "network-auth",
        blockReason: "E_AUTH_FAILED",
        sessionId: "transport"
      });
      res.status(401).json({ error: "E_AUTH_FAILED" });
      return;
    }

    input.limiter.reset(key);
    next();
  };
}
