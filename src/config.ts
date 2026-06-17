import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";
import { DEFAULT_AUDIT_RETENTION, type AuditRetention } from "./security/audit-rotation.js";
import { DEFAULT_RATE_LIMIT_POLICY, type RateLimitPolicy } from "./security/rate-limit.js";

const ProjectNameSchema = z
  .string()
  .min(1)
  .refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"), {
    message: "allowlist entries must be project directory names"
  });

export type ExecutionConfig = {
  adapter: "handoff-file" | "codex-cli";
  worktreeRoot?: string;
  timeoutMs: number;
  branchPrefix: string;
};

const LimitsSchema = z.object({
  maxBytesPerFile: z.number().int().positive().default(DEFAULT_LIMITS.maxBytesPerFile),
  maxFilesPerRead: z.number().int().positive().default(DEFAULT_LIMITS.maxFilesPerRead),
  maxFilesPerSession: z.number().int().positive().default(DEFAULT_LIMITS.maxFilesPerSession),
  maxContextBytes: z.number().int().positive().default(DEFAULT_LIMITS.maxContextBytes),
  maxSearchResults: z.number().int().positive().default(DEFAULT_LIMITS.maxSearchResults),
  maxMatchPreviewBytes: z.number().int().positive().default(DEFAULT_LIMITS.maxMatchPreviewBytes),
  maxDiffBytes: z.number().int().positive().default(DEFAULT_LIMITS.maxDiffBytes),
  toolTimeoutMs: z.number().int().positive().default(DEFAULT_LIMITS.toolTimeoutMs),
  codexExecTimeoutMs: z.number().int().positive().default(DEFAULT_LIMITS.codexExecTimeoutMs)
});

const ExecutionSchema = z
  .object({
    adapter: z.enum(["handoff-file", "codex-cli"]).optional(),
    worktreeRoot: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    branchPrefix: z.string().min(1).optional()
  })
  .optional()
  .transform((execution): ExecutionConfig => ({
    adapter: execution?.adapter ?? "handoff-file",
    ...(execution?.worktreeRoot ? { worktreeRoot: execution.worktreeRoot } : {}),
    timeoutMs: execution?.timeoutMs ?? DEFAULT_LIMITS.codexExecTimeoutMs,
    branchPrefix: execution?.branchPrefix ?? "planbridge/"
  }));

const AuthSchema = z.object({
  mode: z.enum(["none", "oauth"]),
  accessControl: z
    .object({
      kind: z.literal("network"),
      configured: z.literal(true),
      secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
    })
    .optional()
});

const AuditRetentionSchema = z.object({
  maxBytes: z.number().int().positive().optional(),
  maxFiles: z.number().int().positive().optional(),
  maxAgeDays: z.number().int().positive().optional()
});

const RateLimitSchema = z.object({
  windowMs: z.number().int().positive().optional(),
  maxFailures: z.number().int().positive().optional(),
  lockoutThreshold: z.number().int().positive().optional(),
  lockoutMs: z.number().int().positive().optional(),
  backoffBaseMs: z.number().int().positive().optional()
});

const SelfProbeSchema = z.object({
  intervalMs: z.number().int().positive().optional(),
  consecutiveBreaches: z.number().int().positive().optional()
});

export type SelfProbeConfig = {
  intervalMs: number;
  consecutiveBreaches: number;
};

export function assertHttpsPublicUrl(urlText: string): void {
  if (new URL(urlText).protocol !== "https:") {
    throw new Error("public base URL must use HTTPS");
  }
}

const ConnectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("secure-tunnel"),
    tunnelId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("public-url"),
    publicBaseUrl: z.string().url().refine((url) => new URL(url).protocol === "https:", {
      message: "public base URL must use HTTPS"
    })
  }),
  z.object({
    kind: z.literal("localhost")
  })
]);

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    projectsRoot: z.string().min(1),
    allowlist: z.array(ProjectNameSchema).min(1),
    port: z.number().int().nonnegative().default(7676),
    transport: z.literal("streamable-http"),
    connection: ConnectionSchema,
    auth: AuthSchema,
    limits: LimitsSchema.partial().optional(),
    execution: ExecutionSchema,
    auditRetention: AuditRetentionSchema.optional(),
    rateLimit: RateLimitSchema.optional(),
    selfProbe: SelfProbeSchema.optional()
  })
  .superRefine((config, context) => {
    if (
      config.connection.kind === "public-url" &&
      config.auth.mode === "none" &&
      config.auth.accessControl?.configured !== true
    ) {
      context.addIssue({
        code: "custom",
        path: ["auth"],
        message: "public connector URL requires access control"
      });
    }
  });

export type PlanbridgeConfig = z.input<typeof ConfigSchema>;

export function planbridgeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  return path.join(home, ".planbridge");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(planbridgeHome(env), "config.json");
}

export async function writeConfig(config: PlanbridgeConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const parsed = ConfigSchema.parse(config);
  const target = configPath(env);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<PlanbridgeConfig> {
  return ConfigSchema.parse(JSON.parse(await readFile(configPath(env), "utf8")));
}

export async function assertDirectoryExists(directory: string, label: string): Promise<void> {
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${directory}`);
    }
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }
}

export function effectiveLimits(config: PlanbridgeConfig): Limits {
  return { ...DEFAULT_LIMITS, ...(config.limits ?? {}) };
}

export function effectiveExecution(config: PlanbridgeConfig): ExecutionConfig {
  return ConfigSchema.parse(config).execution;
}

export function effectiveAuditRetention(config: PlanbridgeConfig): AuditRetention {
  const parsed = ConfigSchema.parse(config);
  return { ...DEFAULT_AUDIT_RETENTION, ...(parsed.auditRetention ?? {}) };
}

export function resolveRateLimit(config: PlanbridgeConfig): RateLimitPolicy {
  const parsed = ConfigSchema.parse(config);
  return { ...DEFAULT_RATE_LIMIT_POLICY, ...(parsed.rateLimit ?? {}) };
}

export function resolveSelfProbe(config: PlanbridgeConfig): SelfProbeConfig {
  const parsed = ConfigSchema.parse(config);
  return {
    intervalMs: parsed.selfProbe?.intervalMs ?? 60_000,
    consecutiveBreaches: parsed.selfProbe?.consecutiveBreaches ?? 2
  };
}
