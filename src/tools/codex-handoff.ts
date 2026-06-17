import path from "node:path";
import { z } from "zod/v4";
import { createCodexCliAdapter } from "../adapters/codex-cli.js";
import type { CodexHandoff, CodexMode } from "../adapters/codex-adapter.js";
import { createHandoffFileAdapter } from "../adapters/handoff-file.js";
import { effectiveExecution, planbridgeHome } from "../config.js";
import { PlanbridgeError, type ToolError } from "../errors.js";
import { toToolError } from "../envelopes.js";
import { resolveAllowedProject } from "../project-index.js";
import type { ToolContext } from "../tool-context.js";

const RequiredString = z.string().refine((value) => value.trim().length > 0);
const RequiredStringArray = z.array(RequiredString).min(1);

export const codexHandoffInputSchema = z.object({
  project: RequiredString,
  objective: RequiredString,
  context: RequiredString,
  constraints: RequiredString,
  non_goals: z.array(z.string()).default([]),
  likely_files: z.array(z.string()).default([]),
  verification: RequiredStringArray,
  stop_conditions: RequiredStringArray,
  schema_version: z.literal("1.0").default("1.0")
});

export type CodexHandoffToolOutput =
  | {
      handle: string;
      id: string;
      mode: CodexMode;
      execution?: {
        adapter: "handoff-file" | "codex-cli";
        runHandle?: string;
        state: "queued" | "running" | "completed" | "failed" | "requires-user-input";
      };
    }
  | ToolError;

function parseHandoffInput(input: unknown): CodexHandoff {
  const parsed = codexHandoffInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlanbridgeError("E_HANDOFF_INCOMPLETE", "codex_handoff is missing a required field or section.");
  }
  return parsed.data;
}

export async function codexHandoff(rawInput: unknown, context: ToolContext): Promise<CodexHandoffToolOutput> {
  try {
    const input = parseHandoffInput(rawInput);
    const project = await resolveAllowedProject(context.config, input.project, planbridgeHome({ HOME: context.home }));
    const execution = effectiveExecution(context.config);

    if (execution.adapter === "codex-cli") {
      const adapter = createCodexCliAdapter({
        home: context.home,
        config: context.config,
        env: process.env,
        timeoutMs: execution.timeoutMs,
        ...(context.codexRunner ? { run: context.codexRunner } : {})
      });
      const { handle, artifactPath, worktreePath } = await adapter.start({ ...input, project: project.name });
      const mode = adapter.mode();
      const status = await adapter.status(handle);
      await context.audit.append({
        event: "exec",
        tool: "codex_handoff",
        project: project.name,
        path: worktreePath,
        runId: handle,
        sessionId: context.session.id
      });
      return {
        handle: artifactPath,
        id: handle,
        mode,
        execution: {
          adapter: "codex-cli",
          runHandle: handle,
          state: status.state
        }
      };
    }

    const adapter = createHandoffFileAdapter({ home: context.home, env: process.env });
    const { handle } = await adapter.start({ ...input, project: project.name });
    const mode = adapter.mode();
    await context.audit.append({
      event: "handoff",
      tool: "codex_handoff",
      project: project.name,
      path: handle,
      sessionId: context.session.id
    });
    return {
      handle,
      id: path.basename(handle, ".md"),
      mode
    };
  } catch (error) {
    return toToolError(error);
  }
}
