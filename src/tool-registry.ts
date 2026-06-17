import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlanbridgeConfig } from "./config.js";
import { createToolContext, type SessionState } from "./tool-context.js";
import { projectsList, projectsListInputSchema } from "./tools/projects-list.js";
import { projectSummary, projectSummaryInputSchema } from "./tools/project-summary.js";
import { repoSearch, repoSearchInputSchema } from "./tools/repo-search.js";
import { repoReadFiles, repoReadFilesInputSchema } from "./tools/repo-read-files.js";
import { contextPack, contextPackInputSchema } from "./tools/context-pack.js";
import { gitStatusTool, gitStatusInputSchema } from "./tools/git-status.js";
import { codexHandoff, codexHandoffInputSchema } from "./tools/codex-handoff.js";
import { codexStatus, codexStatusInputSchema } from "./tools/codex-status.js";
import { gitDiffTool, gitDiffInputSchema } from "./tools/git-diff.js";

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

export function createPlanbridgeMcpServer(input: {
  config: PlanbridgeConfig;
  home: string;
  session: SessionState;
}): McpServer {
  const context = createToolContext({
    config: input.config,
    home: input.home,
    session: input.session
  });
  const server = new McpServer({ name: "planbridge", version: "0.1.0" });

  server.registerTool(
    "projects_list",
    {
      title: "List Projects",
      description: "List allowlisted projects and basic metadata.",
      inputSchema: projectsListInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(projectsList(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "project_summary",
    {
      title: "Project Summary",
      description: "Return repo type, key docs, test commands, and recent status.",
      inputSchema: projectSummaryInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(projectSummary(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "repo_search",
    {
      title: "Repo Search",
      description: "Search allowed files with bounded ripgrep-style results.",
      inputSchema: repoSearchInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(repoSearch(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "repo_read_files",
    {
      title: "Read Repo Files",
      description: "Read specific allowed files with size limits and secret filtering.",
      inputSchema: repoReadFilesInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(repoReadFiles(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "context_pack",
    {
      title: "Context Pack",
      description: "Package selected files, prompt, and constraints into a reproducible planning bundle.",
      inputSchema: contextPackInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(contextPack(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "git_status",
    {
      title: "Git Status",
      description: "Return the allowlisted project's branch and dirty-state summary.",
      inputSchema: gitStatusInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(gitStatusTool(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "codex_handoff",
    {
      title: "Codex Handoff",
      description: "Write an approved Codex handoff artifact and start the configured execution adapter.",
      inputSchema: codexHandoffInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(codexHandoff(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "codex_status",
    {
      title: "Codex Status",
      description: "Return the persisted state for a codex-cli execution run.",
      inputSchema: codexStatusInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(codexStatus(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git Diff",
      description: "Return a bounded, redacted diff for one codex-cli run worktree.",
      inputSchema: gitDiffInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (args) => toolResult(await withTimeout(gitDiffTool(args, context), context.limits.toolTimeoutMs) as ToolPayload)
  );

  return server;
}
