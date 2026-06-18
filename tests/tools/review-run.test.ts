import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../../src/tool-context.js";
import { executePlan } from "../../src/tools/execute-plan.js";
import { preparePlan } from "../../src/tools/prepare-plan.js";
import { reviewRun, type ReviewRunOutput } from "../../src/tools/review-run.js";
import type { CodexRunner } from "../../src/adapters/codex-cli.js";
import { createFixtureProject, initGitFixture, type FixtureProject } from "../helpers/fixtures.js";

function makeContext(fixture: FixtureProject, execution: "handoff-file" | "codex-cli" = "codex-cli", runner?: CodexRunner) {
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
      execution: { adapter: execution, timeoutMs: 1000 }
    },
    ...(runner ? { codexRunner: runner } : {})
  });
}

function expectSuccess(result: ReviewRunOutput): Extract<ReviewRunOutput, { runHandle: string }> {
  expect(result).not.toHaveProperty("error");
  return result as Extract<ReviewRunOutput, { runHandle: string }>;
}

async function waitForCompletedReview(fixture: FixtureProject, planId: string): Promise<Extract<ReviewRunOutput, { runHandle: string }>> {
  for (let index = 0; index < 20; index += 1) {
    const result = expectSuccess(await reviewRun({ plan_id: planId }, makeContext(fixture)));
    if (result.state === "completed") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not complete in time");
}

describe("review_run", () => {
  it("resolves a run from plan_id and includes a bounded diff only after completion", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const runner: CodexRunner = async (request) => {
      await writeFile(path.join(request.cwd, "guided.txt"), "guided change\n");
      await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
      await writeFile(request.resultFile, "final\n", { mode: 0o600 });
      return { exitCode: 0 };
    };
    const prepared = await preparePlan(
      {
        project: "alpha",
        objective: "Add a guided run artifact.",
        scope: { paths: ["README.md"], search: [], includeDefaults: false },
        verification: ["npm test"]
      },
      makeContext(fixture)
    );
    expect(prepared).not.toHaveProperty("error");
    const plan = prepared as Extract<typeof prepared, { plan_id: string }>;
    const executed = await executePlan(
      {
        plan_id: plan.plan_id,
        approved_plan_hash: plan.plan_hash,
        approval: { user_message: "Approved." }
      },
      makeContext(fixture, "codex-cli", runner)
    );
    expect(executed).not.toHaveProperty("error");

    const review = await waitForCompletedReview(fixture, plan.plan_id);

    expect(review).toMatchObject({
      schema_version: "1.0",
      plan_id: plan.plan_id,
      state: "completed",
      status: { state: "completed" },
      diff: {
        files: [expect.objectContaining({ path: "guided.txt", kind: "added" })]
      },
      next: {
        human_review_required: true,
        merge_automatically: false
      }
    });
    expect(JSON.stringify(review)).toContain("+guided change");
  });

  it("returns E_NOT_FOUND for a stored plan that has no codex-cli run", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const prepared = await preparePlan(
      {
        project: "alpha",
        objective: "Write a handoff only.",
        scope: { paths: ["README.md"], search: [], includeDefaults: false },
        verification: ["npm test"]
      },
      makeContext(fixture)
    );
    expect(prepared).not.toHaveProperty("error");
    const plan = prepared as Extract<typeof prepared, { plan_id: string }>;
    await expect(reviewRun({ plan_id: plan.plan_id }, makeContext(fixture))).resolves.toEqual({
      error: expect.objectContaining({ code: "E_NOT_FOUND" })
    });
  });

  it("accepts a direct runHandle and skips diff when includeDiff is false", async () => {
    const fixture = await createFixtureProject("alpha");
    const result = expectSuccess(
      await reviewRun(
        {
          runHandle: "00000000-0000-4000-8000-000000000099",
          includeDiff: false
        },
        makeContext(fixture)
      )
    );

    expect(result.state).toBe("failed");
    expect(result).not.toHaveProperty("diff");
  });
});
