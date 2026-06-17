import { z } from "zod/v4";
import type { Bounded } from "../envelopes.js";
import { listProjects, type ProjectMetadata } from "../project-index.js";
import type { ToolContext } from "../tool-context.js";

export const projectsListInputSchema = z.object({}).strict();

export type ProjectsListOutput = Bounded<"projects", ProjectMetadata>;

export async function projectsList(_input: z.infer<typeof projectsListInputSchema>, context: ToolContext): Promise<ProjectsListOutput> {
  return {
    projects: await listProjects(context.config),
    truncated: false
  };
}
