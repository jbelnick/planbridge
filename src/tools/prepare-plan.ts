import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { CodexHandoff } from "../adapters/codex-adapter.js";
import { effectiveProConsult, planbridgeHome } from "../config.js";
import { toToolError } from "../envelopes.js";
import { PlanbridgeError, type ToolError } from "../errors.js";
import { createStoredPlan, planRecordPath, type StoredPlan } from "../plan-store.js";
import { gitCommitSha, gitStatus, keyDocs, pathExists, resolveAllowedProject, testCommands } from "../project-index.js";
import type { ToolContext } from "../tool-context.js";
import { contextPack, type ContextPack } from "./context-pack.js";
import { repoSearch } from "./repo-search.js";
import { extractCodexHandoffFromProAnswer, proConsult } from "./pro-consult.js";

const ScopeSchema = z
  .object({
    paths: z.array(z.string().min(1)).default([]),
    search: z.array(z.string().min(1)).default([]),
    includeDefaults: z.boolean().default(true)
  })
  .default({ paths: [], search: [], includeDefaults: true });

export const preparePlanInputSchema = z.object({
  project: z.string().min(1).optional(),
  objective: z.string().min(1),
  scope: ScopeSchema,
  planner: z.enum(["auto", "local", "pro"]).default("auto"),
  constraints: z.array(z.string().min(1)).default([]),
  verification: z.array(z.string().min(1)).default([]),
  maxBytesPerFile: z.number().int().positive().optional(),
  includeInternalPaths: z.boolean().default(false)
});

type PreparePlanInput = z.infer<typeof preparePlanInputSchema>;

export type PreparePlanOutput =
  | {
      schema_version: "1.0";
      plan_id: string;
      plan_hash: string;
      project: string;
      generated_at: string;
      base: StoredPlan["base"];
      planner: StoredPlan["planner"] & { fallback_reason?: string };
      context: NonNullable<StoredPlan["context"]>;
      proposed_plan: CodexHandoff;
      approval_required: true;
      next: {
        tool: "execute_plan";
        arguments: {
          plan_id: string;
          approved_plan_hash: string;
        };
        requires_user_approval: true;
      };
      artifact: {
        stored: true;
        path?: string;
      };
    }
  | ToolError;

function inferProject(configProjects: string[], requested?: string): string {
  if (requested) {
    return requested;
  }
  if (configProjects.length === 1) {
    return configProjects[0];
  }
  throw new PlanbridgeError(
    "E_PROJECT_REQUIRED",
    `PlanBridge has ${configProjects.length} allowlisted projects; provide a project name.`,
    configProjects.join(",")
  );
}

async function defaultContextPaths(projectRoot: string): Promise<string[]> {
  const candidates = [
    ...(await keyDocs(projectRoot)),
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "docs/OPERATOR-RUNBOOK.md",
    "docs/PLANBRIDGE-SPEC.md"
  ];
  const present: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(projectRoot, candidate))) {
      present.push(candidate);
    }
  }
  return present;
}

async function searchPaths(project: string, searches: string[], context: ToolContext): Promise<string[]> {
  const paths = new Set<string>();
  for (const query of searches) {
    const result = await repoSearch({ project, query, maxResults: Math.min(8, context.limits.maxSearchResults) }, context);
    if ("error" in result) {
      throw new PlanbridgeError(result.error.code, result.error.message, result.error.path);
    }
    for (const match of result.matches) {
      paths.add(match.path);
    }
  }
  return [...paths];
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => path.normalize(entry).split(path.sep).join("/")))].sort();
}

function contextSummary(pack: ContextPack): NonNullable<StoredPlan["context"]> {
  return {
    files: pack.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      truncated: file.truncated,
      sha256: file.sha256
    })),
    omitted: pack.omitted,
    redactions: pack.redactions,
    budget: pack.budget
  };
}

function bulletList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- none";
}

function localHandoff(input: {
  project: string;
  objective: string;
  constraints: string[];
  verification: string[];
  pack: ContextPack;
  inferredVerification: string[];
}): CodexHandoff {
  const verification = input.verification.length > 0 ? input.verification : input.inferredVerification;
  const included = input.pack.files.map((file) => `- ${file.path} (${file.bytes} bytes, sha256:${file.sha256})`);
  const omitted = input.pack.omitted.map((entry) => `- ${entry.path}: ${entry.reason}`);
  const redactions = input.pack.redactions.map((entry) => `- ${entry.path}: ${entry.reason}`);
  return {
    schema_version: "1.0",
    project: input.project,
    objective: input.objective,
    context: [
      `Prepared by PlanBridge at commit ${input.pack.commit_sha}.`,
      "",
      "Included context files:",
      included.length > 0 ? included.join("\n") : "- none",
      "",
      "Omitted files:",
      omitted.length > 0 ? omitted.join("\n") : "- none",
      "",
      "Redactions:",
      redactions.length > 0 ? redactions.join("\n") : "- none",
      "",
      "Use the repository itself as the source of truth before editing."
    ].join("\n"),
    constraints:
      input.constraints.length > 0
        ? bulletList(input.constraints)
        : "Keep changes focused, preserve PlanBridge security boundaries, and avoid unrelated refactors.",
    non_goals: [
      "Do not auto-merge Codex worktree changes.",
      "Do not expose secrets, browser state, or unrestricted filesystem access."
    ],
    likely_files: input.pack.files.map((file) => file.path),
    verification: verification.length > 0 ? verification : ["npm test"],
    stop_conditions: [
      "The repository HEAD no longer matches the prepared plan.",
      "A required verification command repeatedly fails.",
      "The implementation would require broad filesystem, shell, or secret access outside the PlanBridge boundary."
    ]
  };
}

function proPlanningPrompt(input: PreparePlanInput, project: string): string {
  return [
    "Prepare a Codex-ready implementation plan for PlanBridge.",
    "",
    "Return a concise human review first, then a fenced JSON block named PLANBRIDGE_CODEX_HANDOFF_JSON.",
    "The JSON must match PlanBridge codex_handoff exactly with schema_version, project, objective, context, constraints, non_goals, likely_files, verification, and stop_conditions.",
    "",
    `Project: ${project}`,
    "",
    "Objective:",
    input.objective,
    "",
    "Constraints:",
    bulletList(input.constraints),
    "",
    "Verification requested:",
    bulletList(input.verification)
  ].join("\n");
}

async function privateFileMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

export async function preparePlan(rawInput: unknown, context: ToolContext): Promise<PreparePlanOutput> {
  try {
    const input = preparePlanInputSchema.parse(rawInput);
    const projectName = inferProject(context.config.allowlist, input.project);
    const project = await resolveAllowedProject(context.config, projectName, planbridgeHome({ HOME: context.home }));
    const defaultPaths = input.scope.includeDefaults ? await defaultContextPaths(project.root) : [];
    const matchedPaths = await searchPaths(project.name, input.scope.search, context);
    const paths = uniqueSorted([...defaultPaths, ...input.scope.paths, ...matchedPaths]);
    if (paths.length === 0) {
      throw new PlanbridgeError("E_NOT_FOUND", "prepare_plan found no readable context paths for this project.", project.name);
    }

    const pack = await contextPack(
      {
        project: project.name,
        paths,
        prompt: input.objective,
        constraints: input.constraints,
        ...(input.maxBytesPerFile ? { maxBytesPerFile: input.maxBytesPerFile } : {})
      },
      context
    );
    if ("error" in pack) {
      return pack;
    }

    const status = await gitStatus(project.root, context.limits.toolTimeoutMs);
    const inferredVerification = (await testCommands(project.root)) ?? [];
    const proConsultConfig = effectiveProConsult(context.config);
    let planner: StoredPlan["planner"] & { fallback_reason?: string } = { used: "local" };
    let handoff = localHandoff({
      project: project.name,
      objective: input.objective,
      constraints: input.constraints,
      verification: input.verification,
      pack,
      inferredVerification
    });

    if (input.planner === "pro" && !proConsultConfig.enabled) {
      return toToolError(new PlanbridgeError("E_PRO_CONSULT_DISABLED", "Pro consult is disabled in PlanBridge config."));
    }
    if ((input.planner === "pro" || (input.planner === "auto" && proConsultConfig.enabled)) && proConsultConfig.enabled) {
      const pro = await proConsult(
        {
          project: project.name,
          paths,
          prompt: proPlanningPrompt(input, project.name),
          constraints: input.constraints,
          ...(input.maxBytesPerFile ? { maxBytesPerFile: input.maxBytesPerFile } : {})
        },
        context
      );
      if ("error" in pro) {
        if (input.planner === "pro") {
          return pro;
        }
        planner = { used: "local", fallback_reason: pro.error.code };
      } else {
        const parsed = extractCodexHandoffFromProAnswer(pro.answer);
        if (parsed) {
          handoff = { ...parsed, project: project.name };
          planner = {
            used: "pro",
            model: pro.model,
            mode: pro.mode,
            pro_consult_run: pro.run.slug
          };
        } else if (input.planner === "pro") {
          return toToolError(
            new PlanbridgeError("E_HANDOFF_INCOMPLETE", "Pro consult did not return a valid PLANBRIDGE_CODEX_HANDOFF_JSON block.")
          );
        } else {
          planner = { used: "local", fallback_reason: "E_HANDOFF_INCOMPLETE" };
        }
      }
    }

    const stored = await createStoredPlan(context.home, {
      schema_version: "1.0",
      project: project.name,
      objective: input.objective,
      base: {
        commit_sha: await gitCommitSha(project.root),
        branch: status.branch,
        dirty: status.dirty
      },
      context: contextSummary(pack),
      planner,
      proposed_handoff: handoff
    });
    const artifactPath = planRecordPath(context.home, stored.plan_id);
    await context.audit.append({
      event: "handoff",
      tool: "prepare_plan",
      project: project.name,
      path: artifactPath,
      sessionId: context.session.id
    });

    return {
      schema_version: "1.0",
      plan_id: stored.plan_id,
      plan_hash: stored.plan_hash,
      project: stored.project,
      generated_at: stored.created_at,
      base: stored.base,
      planner,
      context: stored.context!,
      proposed_plan: stored.proposed_handoff,
      approval_required: true,
      next: {
        tool: "execute_plan",
        arguments: {
          plan_id: stored.plan_id,
          approved_plan_hash: stored.plan_hash
        },
        requires_user_approval: true
      },
      artifact: {
        stored: true,
        ...(input.includeInternalPaths ? { path: artifactPath } : {})
      }
    };
  } catch (error) {
    return toToolError(error);
  }
}

export const __privatePreparePlan = {
  privateFileMode
};
