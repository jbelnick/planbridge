import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../../src/tool-context.js";
import { planRecordPath, readStoredPlan } from "../../src/plan-store.js";
import { preparePlan, preparePlanInputSchema, type PreparePlanOutput } from "../../src/tools/prepare-plan.js";
import type { ProConsultRunner } from "../../src/adapters/pro-consult.js";
import { createFixtureProject, initGitFixture, type FixtureProject } from "../helpers/fixtures.js";

function makeContext(fixture: FixtureProject, overrides: Record<string, unknown> = {}, runner?: ProConsultRunner) {
  return createToolContext({
    home: fixture.home,
    config: {
      schemaVersion: "1.0",
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      port: 7676,
      transport: "streamable-http",
      connection: { kind: "localhost" },
      auth: { mode: "none" },
      ...overrides
    },
    ...(runner ? { proConsultRunner: runner } : {})
  });
}

function expectSuccess(result: PreparePlanOutput): Extract<PreparePlanOutput, { plan_id: string }> {
  expect(result).not.toHaveProperty("error");
  return result as Extract<PreparePlanOutput, { plan_id: string }>;
}

async function relativeTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

describe("prepare_plan", () => {
  it("validates the guided planning schema defaults", () => {
    expect(
      preparePlanInputSchema.parse({
        objective: "Make the workflow easier."
      })
    ).toEqual({
      objective: "Make the workflow easier.",
      scope: { paths: [], search: [], includeDefaults: true },
      planner: "auto",
      constraints: [],
      verification: [],
      includeInternalPaths: false
    });
  });

  it("infers the single allowlisted project, stores a private hashed plan, and does not mutate the project", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const beforeTree = await relativeTree(fixture.projectRoot);
    const result = expectSuccess(
      await preparePlan(
        {
          objective: "Add the guided workflow facade.",
          constraints: ["Keep existing security boundaries."],
          verification: ["npm test"]
        },
        makeContext(fixture)
      )
    );
    const stored = await readStoredPlan(fixture.home, result.plan_id);
    const artifactPath = planRecordPath(fixture.home, result.plan_id);

    expect(result.project).toBe("alpha");
    expect(result.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.artifact).toEqual({ stored: true });
    expect(result.proposed_plan).toMatchObject({
      schema_version: "1.0",
      project: "alpha",
      objective: "Add the guided workflow facade.",
      verification: ["npm test"]
    });
    expect(result.next).toMatchObject({
      tool: "execute_plan",
      arguments: { plan_id: result.plan_id, approved_plan_hash: result.plan_hash },
      requires_user_approval: true
    });
    expect(stored.plan_hash).toBe(result.plan_hash);
    expect(stored.proposed_handoff).toEqual(result.proposed_plan);
    expect((await lstat(artifactPath)).mode & 0o777).toBe(0o600);
    expect(await relativeTree(fixture.projectRoot)).toEqual(beforeTree);
    expect(JSON.stringify(result)).not.toContain(fixture.home);
  });

  it("requires an explicit project when more than one project is allowlisted", async () => {
    const fixture = await createFixtureProject("alpha");
    await mkdir(path.join(fixture.projectsRoot, "beta"), { recursive: true });
    const context = createToolContext({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha", "beta"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      }
    });

    await expect(preparePlan({ objective: "Plan it." }, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_PROJECT_REQUIRED" })
    });
  });

  it("fails closed when planner=pro but Pro consult is disabled", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(preparePlan({ project: "alpha", objective: "Plan it.", planner: "pro" }, makeContext(fixture))).resolves.toEqual({
      error: {
        code: "E_PRO_CONSULT_DISABLED",
        message: "Pro consult is disabled in PlanBridge config."
      }
    });
  });

  it("uses a structured Pro answer when the operator has enabled the browser-subscription bridge", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const runner: ProConsultRunner = async (request) => ({
      answer: [
        "Use the guided facade.",
        "",
        "PLANBRIDGE_CODEX_HANDOFF_JSON",
        "```json",
        JSON.stringify({
          schema_version: "1.0",
          project: "alpha",
          objective: "Simplify PlanBridge UX.",
          context: "Pro reviewed the sanitized bundle and recommends guided tools.",
          constraints: "Keep approval explicit.",
          non_goals: ["Do not auto-merge"],
          likely_files: ["src/tool-registry.ts"],
          verification: ["npm test"],
          stop_conditions: ["Hash mismatch"]
        }),
        "```"
      ].join("\n"),
      model: request.model,
      mode: "browser-subscription",
      slug: request.slug,
      outputFile: request.outputFile,
      durationMs: 9,
      stdout: "",
      stderr: ""
    });

    const result = expectSuccess(
      await preparePlan(
        {
          project: "alpha",
          objective: "Simplify PlanBridge UX.",
          planner: "pro",
          scope: { paths: ["README.md"], search: [], includeDefaults: false }
        },
        makeContext(fixture, { proConsult: { enabled: true } }, runner)
      )
    );

    expect(result.planner).toMatchObject({ used: "pro", model: "gpt-5.5-pro", mode: "browser-subscription" });
    expect(result.proposed_plan).toMatchObject({
      objective: "Simplify PlanBridge UX.",
      likely_files: ["src/tool-registry.ts"],
      stop_conditions: ["Hash mismatch"]
    });
    expect(await readFile(planRecordPath(fixture.home, result.plan_id), "utf8")).toContain('"used": "pro"');
  });
});
