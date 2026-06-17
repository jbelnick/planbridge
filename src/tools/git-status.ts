import { z } from "zod/v4";
import type { ToolError } from "../errors.js";
import { toToolError } from "../envelopes.js";
import { planbridgeHome } from "../config.js";
import { gitStatus, type GitStatusResult, resolveAllowedProject } from "../project-index.js";
import type { ToolContext } from "../tool-context.js";

export const gitStatusInputSchema = z.object({
  project: z.string().min(1)
});

export type GitStatusOutput = GitStatusResult | ToolError;

export async function gitStatusTool(
  rawInput: { project: string },
  context: ToolContext
): Promise<GitStatusOutput> {
  const input = gitStatusInputSchema.parse(rawInput);
  try {
    const project = await resolveAllowedProject(context.config, input.project, planbridgeHome({ HOME: context.home }));
    const status = await gitStatus(project.root, context.limits.toolTimeoutMs);
    await context.audit.append({
      event: "status",
      tool: "git_status",
      project: project.name,
      sessionId: context.session.id
    });
    return status;
  } catch (error) {
    return toToolError(error);
  }
}
