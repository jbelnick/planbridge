import { z } from "zod/v4";
import { effectiveExecution, planbridgeHome } from "../config.js";
import { toToolError } from "../envelopes.js";
import { PlanbridgeError, type ToolError } from "../errors.js";
import { readStoredPlan, updateStoredPlan } from "../plan-store.js";
import { gitCommitSha, resolveAllowedProject } from "../project-index.js";
import type { ToolContext } from "../tool-context.js";
import { startCodexHandoff } from "./codex-handoff.js";

export const executePlanInputSchema = z.object({
  plan_id: z.string().min(1),
  approved_plan_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approval: z.object({
    user_message: z.string().min(1)
  }),
  allowBaseDrift: z.boolean().default(false),
  includeInternalPaths: z.boolean().default(false)
});

type ExecutePlanInput = z.infer<typeof executePlanInputSchema>;

export type ExecutePlanOutput =
  | {
      schema_version: "1.0";
      plan_id: string;
      plan_hash: string;
      project: string;
      execution: {
        adapter: "handoff-file" | "codex-cli";
        state: "queued" | "running" | "completed" | "failed" | "requires-user-input";
        runHandle?: string;
        handoffId?: string;
        artifact?: {
          stored: true;
          path?: string;
        };
      };
      next: {
        tool: "review_run";
        arguments: {
          plan_id: string;
        };
      };
    }
  | ToolError;

function parseExecutePlanInput(rawInput: unknown): ExecutePlanInput {
  const parsed = executePlanInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const missingApproval = parsed.error.issues.some((issue) => issue.path.join(".").startsWith("approval"));
    if (missingApproval) {
      throw new PlanbridgeError("E_APPROVAL_REQUIRED", "execute_plan requires explicit user approval text.");
    }
    throw new PlanbridgeError("E_HANDOFF_INCOMPLETE", "execute_plan is missing a required field.");
  }
  return parsed.data;
}

export async function executePlan(rawInput: unknown, context: ToolContext): Promise<ExecutePlanOutput> {
  try {
    const input = parseExecutePlanInput(rawInput);
    const stored = await readStoredPlan(context.home, input.plan_id);
    if (input.approved_plan_hash !== stored.plan_hash) {
      throw new PlanbridgeError("E_PLAN_HASH_MISMATCH", "Approved plan hash does not match the stored plan.");
    }
    if (stored.execution) {
      throw new PlanbridgeError("E_PLAN_ALREADY_EXECUTED", "This plan has already been executed.");
    }

    const project = await resolveAllowedProject(context.config, stored.project, planbridgeHome({ HOME: context.home }));
    const currentCommit = await gitCommitSha(project.root);
    if (!input.allowBaseDrift && stored.base.commit_sha !== "UNVERSIONED" && currentCommit !== stored.base.commit_sha) {
      throw new PlanbridgeError(
        "E_STALE_PLAN",
        `Project HEAD changed from ${stored.base.commit_sha} to ${currentCommit}; prepare a fresh plan or set allowBaseDrift.`
      );
    }

    const result = await startCodexHandoff(stored.proposed_handoff, context, "execute_plan");
    const adapter = effectiveExecution(context.config).adapter;
    const state = result.execution?.state ?? "queued";
    const runHandle = result.execution?.runHandle;
    const updated = await updateStoredPlan(context.home, stored.plan_id, (plan) => ({
      ...plan,
      execution: {
        adapter,
        state,
        ...(runHandle ? { runHandle } : {}),
        handoffHandle: result.handle,
        handoffId: result.id,
        executed_at: new Date().toISOString()
      }
    }));

    return {
      schema_version: "1.0",
      plan_id: updated.plan_id,
      plan_hash: updated.plan_hash,
      project: updated.project,
      execution: {
        adapter,
        state,
        ...(runHandle ? { runHandle } : {}),
        handoffId: result.id,
        artifact: {
          stored: true,
          ...(input.includeInternalPaths ? { path: result.handle } : {})
        }
      },
      next: {
        tool: "review_run",
        arguments: {
          plan_id: updated.plan_id
        }
      }
    };
  } catch (error) {
    return toToolError(error);
  }
}
