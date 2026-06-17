import { z } from "zod/v4";
import { createCodexCliAdapter } from "../adapters/codex-cli.js";
import type { CodexAdapterStatus } from "../adapters/codex-adapter.js";
import { effectiveExecution } from "../config.js";
import { PlanbridgeError, type ToolError } from "../errors.js";
import { toToolError } from "../envelopes.js";
import type { ToolContext } from "../tool-context.js";

export const codexStatusInputSchema = z.object({
  handle: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
});

export type CodexStatusToolOutput = CodexAdapterStatus | ToolError;

export async function codexStatus(rawInput: unknown, context: ToolContext): Promise<CodexStatusToolOutput> {
  try {
    const parsed = codexStatusInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PlanbridgeError("E_HANDOFF_INCOMPLETE", "codex_status requires a run handle.");
    }
    const input = parsed.data;
    const execution = effectiveExecution(context.config);
    const adapter = createCodexCliAdapter({
      home: context.home,
      config: context.config,
      env: process.env,
      timeoutMs: execution.timeoutMs
    });
    const status = await adapter.status(input.handle);
    await context.audit.append({
      event: "status",
      tool: "codex_status",
      path: input.handle,
      runId: input.handle,
      sessionId: context.session.id
    });
    return status;
  } catch (error) {
    return toToolError(error);
  }
}
