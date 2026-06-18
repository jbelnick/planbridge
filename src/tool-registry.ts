import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { effectiveProConsult, effectiveTools, type PlanbridgeConfig } from "./config.js";
import { createToolContext, type SessionState, type ToolContext } from "./tool-context.js";
import { projectsList, projectsListInputSchema } from "./tools/projects-list.js";
import { projectSummary, projectSummaryInputSchema } from "./tools/project-summary.js";
import { repoSearch, repoSearchInputSchema } from "./tools/repo-search.js";
import { repoReadFiles, repoReadFilesInputSchema } from "./tools/repo-read-files.js";
import { contextPack, contextPackInputSchema } from "./tools/context-pack.js";
import { gitStatusTool, gitStatusInputSchema } from "./tools/git-status.js";
import { codexHandoff, codexHandoffInputSchema } from "./tools/codex-handoff.js";
import { codexStatus, codexStatusInputSchema } from "./tools/codex-status.js";
import { gitDiffTool, gitDiffInputSchema } from "./tools/git-diff.js";
import { proConsult, proConsultInputSchema } from "./tools/pro-consult.js";
import { preparePlan, preparePlanInputSchema } from "./tools/prepare-plan.js";
import { executePlan, executePlanInputSchema } from "./tools/execute-plan.js";
import { reviewRun, reviewRunInputSchema } from "./tools/review-run.js";
import type { ProConsultRunner } from "./adapters/pro-consult.js";

type ToolPayload = Record<string, unknown>;

function toolResult(payload: ToolPayload): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: "error" in payload
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function registerProjectsList(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "projects_list",
    {
      title: "List Projects",
      description: "List allowlisted projects and basic metadata. Use this before preparing a plan when the project name is unclear.",
      inputSchema: projectsListInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(projectsList(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );
}

function registerGuidedTools(server: McpServer, context: ToolContext): void {
  const proConsult = effectiveProConsult(context.config);
  server.registerTool(
    "prepare_plan",
    {
      title: "Prepare Plan",
      description:
        "Use this first for implementation requests. It packages allowlisted context, optionally consults GPT-5.5 Pro when enabled, stores a hashed plan, and never executes Codex.",
      inputSchema: preparePlanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: proConsult.enabled }
    },
    async (args) => toolResult(await withTimeout(preparePlan(args, context), context.limits.proConsultTimeoutMs + 120_000) as ToolPayload)
  );

  server.registerTool(
    "execute_plan",
    {
      title: "Execute Approved Plan",
      description:
        "Execute a stored PlanBridge plan only after explicit user approval and an approved_plan_hash match. Refuses stale or already executed plans.",
      inputSchema: executePlanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(executePlan(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "review_run",
    {
      title: "Review Run",
      description:
        "Review a Codex run from a plan_id or runHandle. It combines codex_status with a bounded, redacted git_diff when the run is complete and never merges.",
      inputSchema: reviewRunInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(reviewRun(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );
}

function registerLowLevelTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "project_summary",
    {
      title: "Project Summary",
      description: "Advanced: return repo type, key docs, test commands, and recent status for one allowlisted project.",
      inputSchema: projectSummaryInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(projectSummary(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "repo_search",
    {
      title: "Repo Search",
      description: "Advanced: search allowed files with bounded ripgrep-style results and secret-redacted previews.",
      inputSchema: repoSearchInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(repoSearch(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "repo_read_files",
    {
      title: "Read Repo Files",
      description: "Advanced: read specific allowed files with size limits, gitignore checks, and secret filtering.",
      inputSchema: repoReadFilesInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(repoReadFiles(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "context_pack",
    {
      title: "Context Pack",
      description: "Advanced: package selected files, prompt, and constraints into a reproducible planning bundle.",
      inputSchema: contextPackInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(contextPack(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "git_status",
    {
      title: "Git Status",
      description: "Advanced: return the allowlisted project's branch and dirty-state summary.",
      inputSchema: gitStatusInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(gitStatusTool(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );
}

function registerExecutionPrimitives(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "codex_handoff",
    {
      title: "Codex Handoff",
      description:
        "Advanced action: write an approved Codex handoff artifact and start the configured execution adapter. Prefer prepare_plan then execute_plan for normal use.",
      inputSchema: codexHandoffInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(codexHandoff(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "codex_status",
    {
      title: "Codex Status",
      description: "Advanced: return the persisted state for a codex-cli execution run. Prefer review_run for normal use.",
      inputSchema: codexStatusInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(codexStatus(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git Diff",
      description: "Advanced: return a bounded, redacted diff for one codex-cli run worktree. Prefer review_run for normal use.",
      inputSchema: gitDiffInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(gitDiffTool(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );
}

function registerProConsult(server: McpServer, context: ToolContext): void {
  if (!effectiveProConsult(context.config).enabled) {
    return;
  }
  server.registerTool(
    "pro_consult",
    {
      title: "Pro Consult",
      description:
        "Advanced opt-in: package selected allowlisted files into a redacted context bundle, consult GPT-5.5 Pro through ChatGPT browser subscription mode, and return the answer.",
      inputSchema: proConsultInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (args) => toolResult(await withTimeout(proConsult(args, context), context.limits.proConsultTimeoutMs + 120_000) as ToolPayload)
  );
}

export function createPlanbridgeMcpServer(input: {
  config: PlanbridgeConfig;
  home: string;
  session: SessionState;
  proConsultRunner?: ProConsultRunner;
}): McpServer {
  const context = createToolContext({
    config: input.config,
    home: input.home,
    session: input.session,
    proConsultRunner: input.proConsultRunner
  });
  const server = new McpServer({ name: "planbridge", version: "0.1.0" });
  const profile = effectiveTools(input.config).profile;

  registerProjectsList(server, context);
  if (profile === "guided") {
    registerGuidedTools(server, context);
    return server;
  }
  if (profile === "advanced") {
    registerGuidedTools(server, context);
    registerLowLevelTools(server, context);
    registerProConsult(server, context);
    registerExecutionPrimitives(server, context);
    return server;
  }

  registerLowLevelTools(server, context);
  registerExecutionPrimitives(server, context);
  registerProConsult(server, context);
  return server;
}
