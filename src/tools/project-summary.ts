import { z } from "zod/v4";
import { keyDocs, recentStatus, repoType, resolveAllowedProject, testCommands } from "../project-index.js";
import type { ToolError } from "../errors.js";
import { toToolError } from "../envelopes.js";
import type { ToolContext } from "../tool-context.js";

export const projectSummaryInputSchema = z.object({
  project: z.string().min(1)
});

export type ProjectSummaryOutput =
  | {
      name: string;
      repoType: string;
      keyDocs: string[];
      testCommands: string[] | null;
      recentStatus: string;
    }
  | ToolError;

export async function projectSummary(
  input: z.infer<typeof projectSummaryInputSchema>,
  context: ToolContext
): Promise<ProjectSummaryOutput> {
  try {
    const project = await resolveAllowedProject(context.config, input.project);
    return {
      name: project.name,
      repoType: await repoType(project.root),
      keyDocs: await keyDocs(project.root),
      testCommands: await testCommands(project.root),
      recentStatus: await recentStatus(project.root)
    };
  } catch (error) {
    return toToolError(error);
  }
}
