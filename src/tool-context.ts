import os from "node:os";
import path from "node:path";
import type { PlanbridgeConfig } from "./config.js";
import { ConfigSchema, effectiveAuditRetention, effectiveLimits } from "./config.js";
import type { CodexRunner } from "./adapters/codex-cli.js";
import type { ProConsultRunner } from "./adapters/pro-consult.js";
import type { Limits } from "./limits.js";
import { createAuditLogger, type AuditLogger } from "./security/audit-log.js";

export type SessionState = {
  id: string;
  filesRead: number;
};

export type ToolContext = {
  config: PlanbridgeConfig;
  home: string;
  limits: Limits;
  audit: AuditLogger;
  session: SessionState;
  codexRunner?: CodexRunner;
  proConsultRunner?: ProConsultRunner;
};

export function createToolContext(input: {
  config: PlanbridgeConfig;
  home?: string;
  session?: Partial<SessionState>;
  codexRunner?: CodexRunner;
  proConsultRunner?: ProConsultRunner;
}): ToolContext {
  const config = ConfigSchema.parse(input.config);
  const home = input.home ?? process.env.HOME ?? os.homedir();
  return {
    config,
    home,
    limits: effectiveLimits(config),
    audit: createAuditLogger(path.join(home, ".planbridge", "audit.log"), effectiveAuditRetention(config)),
    session: {
      id: input.session?.id ?? "local-test-session",
      filesRead: input.session?.filesRead ?? 0
    },
    codexRunner: input.codexRunner,
    proConsultRunner: input.proConsultRunner
  };
}
