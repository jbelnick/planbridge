import { z } from "zod/v4";
import { toToolError } from "../envelopes.js";
import { PlanbridgeError, type ToolError } from "../errors.js";
import { readStoredPlan } from "../plan-store.js";
import type { ToolContext } from "../tool-context.js";
import { codexStatus, type CodexStatusToolOutput } from "./codex-status.js";
import { gitDiffTool, type GitDiffOutput } from "./git-diff.js";

export const reviewRunInputSchema = z
  .object({
    plan_id: z.string().min(1).optional(),
    runHandle: z.string().min(1).optional(),
    includeDiff: z.boolean().default(true),
    maxDiffBytes: z.number().int().positive().optional()
  })
  .refine((input) => Boolean(input.plan_id) !== Boolean(input.runHandle), {
    message: "provide exactly one of plan_id or runHandle"
  });

type ReviewRunInput = z.infer<typeof reviewRunInputSchema>;

export type ReviewRunOutput =
  | {
      schema_version: "1.0";
      plan_id?: string;
      runHandle: string;
      state: "queued" | "running" | "completed" | "failed" | "requires-user-input";
      status: CodexStatusToolOutput;
      diff?: Exclude<GitDiffOutput, ToolError>;
      next: {
        human_review_required: boolean;
        merge_automatically: false;
      };
    }
  | ToolError;

function parseReviewRunInput(rawInput: unknown): ReviewRunInput {
  const parsed = reviewRunInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PlanbridgeError("E_HANDOFF_INCOMPLETE", "review_run requires exactly one of plan_id or runHandle.");
  }
  return parsed.data;
}

async function runHandleFor(input: ReviewRunInput, context: ToolContext): Promise<{ planId?: string; runHandle: string }> {
  if (input.runHandle) {
    return { runHandle: input.runHandle };
  }
  const planId = input.plan_id!;
  const stored = await readStoredPlan(context.home, planId);
  if (!stored.execution?.runHandle) {
    throw new PlanbridgeError("E_NOT_FOUND", "Plan has no codex-cli run to review.", planId);
  }
  return { planId, runHandle: stored.execution.runHandle };
}

export async function reviewRun(rawInput: unknown, context: ToolContext): Promise<ReviewRunOutput> {
  try {
    const input = parseReviewRunInput(rawInput);
    const target = await runHandleFor(input, context);
    const status = await codexStatus({ handle: target.runHandle }, context);
    if ("error" in status) {
      return status;
    }

    let diff: Exclude<GitDiffOutput, ToolError> | undefined;
    if (input.includeDiff && status.state === "completed") {
      const diffResult = await gitDiffTool(
        {
          runHandle: target.runHandle,
          ...(input.maxDiffBytes ? { maxDiffBytes: input.maxDiffBytes } : {})
        },
        context
      );
      if ("error" in diffResult) {
        return diffResult;
      }
      diff = diffResult;
    }

    return {
      schema_version: "1.0",
      ...(target.planId ? { plan_id: target.planId } : {}),
      runHandle: target.runHandle,
      state: status.state,
      status,
      ...(diff ? { diff } : {}),
      next: {
        human_review_required: status.state === "completed",
        merge_automatically: false
      }
    };
  } catch (error) {
    return toToolError(error);
  }
}
