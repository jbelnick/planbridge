import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createToolContext } from "../../src/tool-context.js";
import { readStoredPlan } from "../../src/plan-store.js";
import { executePlan, type ExecutePlanOutput } from "../../src/tools/execute-plan.js";
import { preparePlan } from "../../src/tools/prepare-plan.js";
import type { CodexRunner } from "../../src/adapters/codex-cli.js";
import { createFixtureProject, initGitFixture, type FixtureProject } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_CODEX_API_KEY = process.env.CODEX_API_KEY;

afterEach(() => {
  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }
  if (ORIGINAL_CODEX_API_KEY === undefined) {
    delete process.env.CODEX_API_KEY;
  } else {
    process.env.CODEX_API_KEY = ORIGINAL_CODEX_API_KEY;
  }
});

function makeContext(fixture: FixtureProject, execution: "handoff-file" | "codex-cli" = "handoff-file", runner?: CodexRunner) {
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

function expectSuccess(result: ExecutePlanOutput): Extract<ExecutePlanOutput, { plan_id: string }> {
  expect(result).not.toHaveProperty("error");
  return result as Extract<ExecutePlanOutput, { plan_id: string }>;
}

async function preparedPlan(fixture: FixtureProject) {
  const prepared = await preparePlan(
    {
      project: "alpha",
      objective: "Execute a guided plan.",
      scope: { paths: ["README.md"], search: [], includeDefaults: false },
      verification: ["npm test"]
    },
    makeContext(fixture)
  );
  expect(prepared).not.toHaveProperty("error");
  return prepared as Extract<typeof prepared, { plan_id: string }>;
}

describe("execute_plan", () => {
  it("requires approval text before executing", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const plan = await preparedPlan(fixture);

    await expect(
      executePlan(
        {
          plan_id: plan.plan_id,
          approved_plan_hash: plan.plan_hash
        },
        makeContext(fixture)
      )
    ).resolves.toEqual({
      error: expect.objectContaining({ code: "E_APPROVAL_REQUIRED" })
    });
  });

  it("executes a matching approved handoff-file plan once and hides local paths by default", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const plan = await preparedPlan(fixture);
    const output = expectSuccess(
      await executePlan(
        {
          plan_id: plan.plan_id,
          approved_plan_hash: plan.plan_hash,
          approval: { user_message: "Approved. Execute that plan." }
        },
        makeContext(fixture)
      )
    );
    const stored = await readStoredPlan(fixture.home, plan.plan_id);

    expect(output).toMatchObject({
      schema_version: "1.0",
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      project: "alpha",
      execution: {
        adapter: "handoff-file",
        state: "queued",
        handoffId: expect.any(String),
        artifact: { stored: true }
      },
      next: { tool: "review_run", arguments: { plan_id: plan.plan_id } }
    });
    expect(JSON.stringify(output)).not.toContain(fixture.home);
    expect(stored.execution).toMatchObject({ adapter: "handoff-file", handoffId: output.execution.handoffId });

    await expect(
      executePlan(
        {
          plan_id: plan.plan_id,
          approved_plan_hash: plan.plan_hash,
          approval: { user_message: "Approved again." }
        },
        makeContext(fixture)
      )
    ).resolves.toEqual({
      error: expect.objectContaining({ code: "E_PLAN_ALREADY_EXECUTED" })
    });
  });

  it("refuses hash mismatches and stale repository HEADs", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const plan = await preparedPlan(fixture);

    await expect(
      executePlan(
        {
          plan_id: plan.plan_id,
          approved_plan_hash: `sha256:${"0".repeat(64)}`,
          approval: { user_message: "Approved." }
        },
        makeContext(fixture)
      )
    ).resolves.toEqual({
      error: expect.objectContaining({ code: "E_PLAN_HASH_MISMATCH" })
    });

    await writeFile(path.join(fixture.projectRoot, "README.md"), "# Alpha\nchanged\n");
    await execFileAsync("git", ["-C", fixture.projectRoot, "add", "README.md"]);
    await execFileAsync("git", ["-C", fixture.projectRoot, "commit", "-m", "change readme"]);

    await expect(
      executePlan(
        {
          plan_id: plan.plan_id,
          approved_plan_hash: plan.plan_hash,
          approval: { user_message: "Approved." }
        },
        makeContext(fixture)
      )
    ).resolves.toEqual({
      error: expect.objectContaining({ code: "E_STALE_PLAN" })
    });
  });

  it("reuses the configured codex-cli adapter and preserves API-key refusal", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const plan = await preparedPlan(fixture);
    const runner: CodexRunner = async (request) => {
      await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
      await writeFile(request.resultFile, "final\n", { mode: 0o600 });
      return { exitCode: 0 };
    };

    const output = expectSuccess(
      await executePlan(
        {
          plan_id: plan.plan_id,
          approved_plan_hash: plan.plan_hash,
          approval: { user_message: "Approved." }
        },
        makeContext(fixture, "codex-cli", runner)
      )
    );

    expect(output.execution).toMatchObject({
      adapter: "codex-cli",
      runHandle: expect.any(String),
      state: expect.stringMatching(/^(running|completed)$/)
    });
    const audit = await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8");
    expect(audit).toContain('"tool":"execute_plan"');

    const blockedFixture = await createFixtureProject("alpha");
    await initGitFixture(blockedFixture.projectRoot);
    const blockedPlan = await preparedPlan(blockedFixture);
    process.env.OPENAI_API_KEY = "sk-test";
    await expect(
      executePlan(
        {
          plan_id: blockedPlan.plan_id,
          approved_plan_hash: blockedPlan.plan_hash,
          approval: { user_message: "Approved." }
        },
        makeContext(blockedFixture, "codex-cli", runner)
      )
    ).resolves.toEqual({
      error: expect.objectContaining({ code: "E_API_KEY_MODE" })
    });
  });
});
