import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { planbridgeHome } from "./config.js";
import { PlanbridgeError } from "./errors.js";
import type { CodexAdapterStatus, CodexHandoff } from "./adapters/codex-adapter.js";

const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StoredPlan = {
  schema_version: "1.0";
  plan_id: string;
  created_at: string;
  project: string;
  base: {
    commit_sha: string;
    branch: string;
    dirty: boolean;
  };
  objective: string;
  context?: {
    files: Array<{ path: string; bytes: number; truncated: boolean; sha256: string }>;
    omitted: Array<{ path: string; reason: string }>;
    redactions: Array<{ path: string; reason: string }>;
    budget: { used_bytes: number; max_bytes: number };
  };
  planner: {
    used: "local" | "pro";
    model?: "gpt-5.5-pro";
    mode?: "browser-subscription";
    pro_consult_run?: string;
  };
  proposed_handoff: CodexHandoff;
  plan_hash: string;
  execution?: {
    adapter: "handoff-file" | "codex-cli";
    runHandle?: string;
    handoffHandle?: string;
    handoffId?: string;
    state: CodexAdapterStatus["state"] | "queued";
    executed_at: string;
  };
};

const StoredPlanSchema: z.ZodType<StoredPlan> = z.object({
  schema_version: z.literal("1.0"),
  plan_id: z.string().regex(PLAN_ID_PATTERN),
  created_at: z.string().min(1),
  project: z.string().min(1),
  base: z.object({
    commit_sha: z.string().min(1),
    branch: z.string(),
    dirty: z.boolean()
  }),
  objective: z.string().min(1),
  context: z
    .object({
      files: z.array(z.object({ path: z.string(), bytes: z.number(), truncated: z.boolean(), sha256: z.string() })),
      omitted: z.array(z.object({ path: z.string(), reason: z.string() })),
      redactions: z.array(z.object({ path: z.string(), reason: z.string() })),
      budget: z.object({ used_bytes: z.number(), max_bytes: z.number() })
    })
    .optional(),
  planner: z.object({
    used: z.enum(["local", "pro"]),
    model: z.literal("gpt-5.5-pro").optional(),
    mode: z.literal("browser-subscription").optional(),
    pro_consult_run: z.string().optional()
  }),
  proposed_handoff: z.object({
    project: z.string(),
    objective: z.string(),
    context: z.string(),
    constraints: z.string(),
    non_goals: z.array(z.string()),
    likely_files: z.array(z.string()),
    verification: z.array(z.string()),
    stop_conditions: z.array(z.string()),
    schema_version: z.literal("1.0")
  }),
  plan_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  execution: z
    .object({
      adapter: z.enum(["handoff-file", "codex-cli"]),
      runHandle: z.string().optional(),
      handoffHandle: z.string().optional(),
      handoffId: z.string().optional(),
      state: z.enum(["queued", "running", "completed", "failed", "requires-user-input"]),
      executed_at: z.string()
    })
    .optional()
});

function assertPlanId(planId: string): void {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new PlanbridgeError("E_NOT_FOUND", "Plan was not found.", planId);
  }
}

function orderedHandoff(handoff: CodexHandoff): CodexHandoff {
  return {
    schema_version: "1.0",
    project: handoff.project,
    objective: handoff.objective,
    context: handoff.context,
    constraints: handoff.constraints,
    non_goals: handoff.non_goals,
    likely_files: handoff.likely_files,
    verification: handoff.verification,
    stop_conditions: handoff.stop_conditions
  };
}

export function hashPlan(handoff: CodexHandoff): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(orderedHandoff(handoff))).digest("hex")}`;
}

export function createPlanId(): string {
  return randomUUID();
}

export function planRecordPath(home: string, planId: string): string {
  assertPlanId(planId);
  return path.join(planbridgeHome({ HOME: home }), "plans", planId, "plan.json");
}

async function writeStoredPlan(home: string, plan: StoredPlan): Promise<string> {
  const parsed = StoredPlanSchema.parse(plan);
  const target = planRecordPath(home, parsed.plan_id);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

export async function createStoredPlan(home: string, plan: Omit<StoredPlan, "plan_id" | "created_at" | "plan_hash">): Promise<StoredPlan> {
  const stored: StoredPlan = {
    ...plan,
    plan_id: createPlanId(),
    created_at: new Date().toISOString(),
    plan_hash: hashPlan(plan.proposed_handoff)
  };
  await writeStoredPlan(home, stored);
  return stored;
}

export async function readStoredPlan(home: string, planId: string): Promise<StoredPlan> {
  try {
    return StoredPlanSchema.parse(JSON.parse(await readFile(planRecordPath(home, planId), "utf8")));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT" || error instanceof PlanbridgeError) {
      throw new PlanbridgeError("E_NOT_FOUND", "Plan was not found.", planId);
    }
    throw error;
  }
}

export async function updateStoredPlan(
  home: string,
  planId: string,
  update: (plan: StoredPlan) => StoredPlan
): Promise<StoredPlan> {
  const current = await readStoredPlan(home, planId);
  const next = update(current);
  if (next.plan_id !== current.plan_id || next.plan_hash !== current.plan_hash) {
    throw new Error("plan updates must preserve plan_id and plan_hash");
  }
  await writeStoredPlan(home, next);
  return next;
}
