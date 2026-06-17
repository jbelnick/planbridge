import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { CodexHandoff } from "../../src/adapters/codex-adapter.js";
import {
  buildCodexArgv,
  createCodexCliAdapter,
  runRecordPath,
  type CodexRunRequest
} from "../../src/adapters/codex-cli.js";
import { renderHandoffArtifact } from "../../src/adapters/handoff-file.js";
import { planbridgeHome, type PlanbridgeConfig } from "../../src/config.js";
import { DEFAULT_LIMITS } from "../../src/limits.js";
import { repoReadFiles } from "../../src/tools/repo-read-files.js";
import { createToolContext } from "../../src/tool-context.js";
import { createFixtureProject, initGitFixture, type FixtureProject } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

function completeHandoff(overrides: Partial<CodexHandoff> = {}): CodexHandoff {
  return {
    schema_version: "1.0",
    project: "alpha",
    objective: "Implement the accepted plan",
    context: "Use the approved context only.",
    constraints: "Do not mutate main.",
    non_goals: ["No deploy"],
    likely_files: ["README.md"],
    verification: ["npm test"],
    stop_conditions: ["Unexpected repo mutation"],
    ...overrides
  };
}

function makeConfig(fixture: FixtureProject, execution: Partial<NonNullable<PlanbridgeConfig["execution"]>> = {}): PlanbridgeConfig {
  return {
    schemaVersion: "1.0",
    projectsRoot: fixture.projectsRoot,
    allowlist: ["alpha"],
    port: 7676,
    transport: "streamable-http",
    connection: { kind: "localhost" },
    auth: { mode: "none" },
    execution: {
      adapter: "codex-cli",
      ...execution
    }
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function seedRun(
  fixture: FixtureProject,
  id: string,
  record: Record<string, unknown>,
  events: string,
  lastMessage: string
): Promise<string> {
  const runDir = path.join(planbridgeHome({ HOME: fixture.home }), "runs", id);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify({
      id,
      project: "alpha",
      worktreePath: "/tmp/missing",
      branch: `planbridge/${id}`,
      resultFile: path.join(runDir, "last-message.txt"),
      eventsFile: path.join(runDir, "events.jsonl"),
      startedAt: new Date().toISOString(),
      mode: "subscription",
      ...record
    }),
    { mode: 0o600 }
  );
  await writeFile(path.join(runDir, "events.jsonl"), events, { mode: 0o600 });
  await writeFile(path.join(runDir, "last-message.txt"), lastMessage, { mode: 0o600 });
  return runDir;
}

describe("codex-cli adapter", () => {
  it("builds the exact safe codex exec argv", () => {
    expect(buildCodexArgv({ worktreePath: "/tmp/wt", resultFile: "/tmp/result.txt" })).toEqual([
      "exec",
      "-c",
      'approval_policy="never"',
      "--cd",
      "/tmp/wt",
      "--sandbox",
      "workspace-write",
      "--json",
      "-o",
      "/tmp/result.txt",
      "-"
    ]);
  });

  it("writes the approved artifact, creates an external worktree, invokes the runner promptly, and never auto-merges", async () => {
    const fixture = await createFixtureProject("alpha");
    const mainSha = await initGitFixture(fixture.projectRoot);
    const calls: CodexRunRequest[] = [];
    let finishRun!: (exitCode: number) => void;
    const runDone = new Promise<number>((resolve) => {
      finishRun = resolve;
    });
    await mkdir(path.join(fixture.home, ".codex"), { recursive: true });
    const authPath = path.join(fixture.home, ".codex", "auth.json");
    await writeFile(authPath, '{"token":"subscription-secret"}\n', { mode: 0o600 });
    const authBefore = await readFile(authPath, "utf8");

    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture),
      env: {},
      run: async (request) => {
        calls.push(request);
        expect(await readdir(path.join(fixture.home, ".planbridge", "handoffs"))).toHaveLength(1);
        await writeFile(path.join(request.cwd, "codex-output.txt"), "changed in worktree\n");
        await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
        await writeFile(request.resultFile, "final message raw body\n", { mode: 0o600 });
        return { exitCode: await runDone };
      }
    });

    const startPromise = adapter.start(completeHandoff());
    const { handle, artifactPath } = await startPromise;
    expect(handle).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifactPath).toBe(path.join(fixture.home, ".planbridge", "handoffs", `${handle}.md`));
    expect(calls).toHaveLength(1);

    const request = calls[0];
    expect(request.argv).toEqual(buildCodexArgv({ worktreePath: request.cwd, resultFile: request.resultFile }));
    expect(request.argv.join(" ")).not.toContain(completeHandoff().objective);
    expect(request.stdin).toBe(renderHandoffArtifact(completeHandoff()));
    expect(request.cwd).toBe(path.join(fixture.home, ".planbridge", "worktrees", handle));
    expect(request.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(request.env).not.toHaveProperty("CODEX_API_KEY");
    expect(await readFile(authPath, "utf8")).toBe(authBefore);

    const running = await adapter.status(handle);
    expect(running).toEqual({ state: "running" });
    finishRun(0);

    await expect.poll(() => adapter.status(handle)).toEqual({
      state: "completed",
      detail: "Codex run completed."
    });
    const branch = `planbridge/${handle}`;
    await expect(execFileAsync("git", ["-C", fixture.projectRoot, "rev-parse", "main"])).resolves.toMatchObject({
      stdout: `${mainSha}\n`
    });
    await expect(execFileAsync("git", ["-C", fixture.projectRoot, "rev-parse", branch])).resolves.toMatchObject({
      stdout: expect.stringMatching(/[a-f0-9]{40}\n/)
    });
    await expect(execFileAsync("git", ["-C", fixture.projectRoot, "worktree", "list"])).resolves.toMatchObject({
      stdout: expect.stringContaining(path.join(fixture.home, ".planbridge", "worktrees", handle))
    });
    await expect(execFileAsync("git", ["-C", fixture.projectRoot, "status", "--porcelain"])).resolves.toMatchObject({
      stdout: ""
    });
  });

  it.each([
    { name: "CODEX_API_KEY", env: { CODEX_API_KEY: "codex-secret" } },
    { name: "OPENAI_API_KEY", env: { OPENAI_API_KEY: "sk-proj-secret" } }
  ])("refuses api-key mode ($name) before any artifact, worktree, or runner call", async ({ env }) => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    let called = false;
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture),
      env,
      run: async () => {
        called = true;
        return { exitCode: 0 };
      }
    });

    await expect(adapter.start(completeHandoff())).rejects.toMatchObject({
      code: "E_API_KEY_MODE"
    });
    expect(called).toBe(false);
    await expect(readdir(path.join(fixture.home, ".planbridge", "handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(fixture.home, ".planbridge", "worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes only a small non-secret environment to the child process", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const calls: CodexRunRequest[] = [];
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture),
      env: {
        PATH: "/usr/bin",
        HOME: fixture.home,
        LANG: "C",
        GITHUB_TOKEN: "ghp_secret",
        AWS_SECRET_ACCESS_KEY: "aws_secret",
        SLACK_BOT_TOKEN: "xoxb-secret"
      },
      run: async (request) => {
        calls.push(request);
        await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
        await writeFile(request.resultFile, "final\n", { mode: 0o600 });
        return { exitCode: 0 };
      }
    });

    await adapter.start(completeHandoff());

    expect(calls[0].env).toEqual({
      PATH: "/usr/bin",
      HOME: fixture.home,
      LANG: "C"
    });
    expect(JSON.stringify(calls[0].env)).not.toContain("secret");
  });

  it("rejects status handles that are not UUID run ids", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const adapter = createCodexCliAdapter({ home: fixture.home, config: makeConfig(fixture), env: {} });

    await expect(adapter.status("../../escape")).resolves.toEqual({
      state: "failed",
      detail: "invalid run handle"
    });
  });

  it("returns E_NOT_A_REPO for non-git projects and E_WORKTREE_FAILED for add failures before spawning", async () => {
    const nonRepo = await createFixtureProject("alpha");
    const nonRepoAdapter = createCodexCliAdapter({
      home: nonRepo.home,
      config: makeConfig(nonRepo),
      env: {},
      run: async () => {
        throw new Error("run should not be called");
      }
    });
    await expect(nonRepoAdapter.start(completeHandoff())).rejects.toMatchObject({ code: "E_NOT_A_REPO" });

    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    await execFileAsync("git", ["-C", fixture.projectRoot, "branch", "planbridge/fixed-id"]);
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture),
      env: {},
      randomId: () => "fixed-id",
      run: async () => {
        throw new Error("run should not be called");
      }
    });

    await expect(adapter.start(completeHandoff())).rejects.toMatchObject({ code: "E_WORKTREE_FAILED" });
    await expect(stat(path.join(fixture.home, ".planbridge", "worktrees", "fixed-id"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects worktree roots outside PlanBridge home before artifact, worktree, or runner creation", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    let called = false;
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture, { worktreeRoot: path.join(fixture.home, "outside-worktrees") }),
      env: {},
      run: async () => {
        called = true;
        return { exitCode: 0 };
      }
    });

    await expect(adapter.start(completeHandoff())).rejects.toMatchObject({
      code: "E_WORKTREE_FAILED",
      message: "codex-cli worktree path must stay under PlanBridge home."
    });
    expect(called).toBe(false);
    await expect(readdir(path.join(fixture.home, ".planbridge", "handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(fixture.home, ".planbridge", "worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts timed-out runs, marks them failed, leaves the worktree, and keeps run state private", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    let observedAbort = false;
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture, { timeoutMs: 25 }),
      env: {},
      run: (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve({ exitCode: null, timedOut: true });
          });
        })
    });

    const { handle } = await adapter.start(completeHandoff());

    await expect.poll(() => adapter.status(handle)).toEqual({
      state: "failed",
      detail: "timed out"
    });
    expect(observedAbort).toBe(true);
    await expect(stat(path.join(fixture.home, ".planbridge", "worktrees", handle))).resolves.toBeDefined();
    expect((await stat(runRecordPath(fixture.home, handle))).mode & 0o777).toBe(0o600);

    const context = createToolContext({ home: fixture.home, config: makeConfig(fixture) });
    const read = await repoReadFiles({ project: "alpha", paths: ["../.planbridge/runs/" + handle + "/run.json"] }, context);
    expect(JSON.stringify(read)).toMatch(/E_PATH_TRAVERSAL|E_SECRET_BLOCKED/);
  });

  it("maps seeded run records and reconciles dead running pids", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const adapter = createCodexCliAdapter({ home: fixture.home, config: makeConfig(fixture), env: {} });
    const id = "00000000-0000-4000-8000-000000000001";
    const runDir = path.join(planbridgeHome({ HOME: fixture.home }), "runs", id);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify({
        id,
        project: "alpha",
        worktreePath: "/tmp/missing",
        branch: `planbridge/${id}`,
        resultFile: path.join(runDir, "last-message.txt"),
        eventsFile: path.join(runDir, "events.jsonl"),
        state: "running",
        startedAt: new Date().toISOString(),
        pid: 99999999,
        mode: "subscription"
      }),
      { mode: 0o600 }
    );
    await writeFile(path.join(runDir, "events.jsonl"), '{"type":"turn.failed","message":"raw secret failure"}\n', { mode: 0o600 });
    await writeFile(path.join(runDir, "last-message.txt"), "raw failure body that must not be returned\n", { mode: 0o600 });

    await expect(adapter.status(id)).resolves.toEqual({ state: "failed", detail: "Codex run failed." });
    expect(await readJson(path.join(runDir, "run.json"))).toMatchObject({
      state: "failed",
      detail: "Codex run failed."
    });
  });

  it("does not trust a completed run.json without terminal JSONL and last-message evidence", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const adapter = createCodexCliAdapter({ home: fixture.home, config: makeConfig(fixture), env: {} });
    const id = "00000000-0000-4000-8000-000000000003";
    const runDir = path.join(planbridgeHome({ HOME: fixture.home }), "runs", id);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify({
        id,
        project: "alpha",
        worktreePath: "/tmp/missing",
        branch: `planbridge/${id}`,
        resultFile: path.join(runDir, "last-message.txt"),
        eventsFile: path.join(runDir, "events.jsonl"),
        state: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        mode: "subscription"
      }),
      { mode: 0o600 }
    );
    await writeFile(path.join(runDir, "events.jsonl"), "", { mode: 0o600 });
    await writeFile(path.join(runDir, "last-message.txt"), "", { mode: 0o600 });

    await expect(adapter.status(id)).resolves.toEqual({ state: "failed", detail: "Codex run missing terminal evidence." });
  });

  it.each([
    {
      name: "non-zero exit maps to failed",
      id: "00000000-0000-4000-8000-0000000000a1",
      record: { state: "completed", exitCode: 1, finishedAt: new Date().toISOString() },
      events: "",
      lastMessage: "",
      expected: { state: "failed", detail: "Codex exited with code 1." }
    },
    {
      name: "an error event maps to failed",
      id: "00000000-0000-4000-8000-0000000000a2",
      record: { state: "running" },
      events: '{"type":"error","message":"raw provider error must not surface"}\n',
      lastMessage: "",
      expected: { state: "failed", detail: "Codex run failed." }
    },
    {
      name: "dead pid with a completed turn and last-message reconciles to completed",
      id: "00000000-0000-4000-8000-0000000000a3",
      record: { state: "running", pid: 99999999 },
      events: '{"type":"turn.completed"}\n',
      lastMessage: "final body that must not surface\n",
      expected: { state: "completed", detail: "Codex run completed." }
    },
    {
      name: "dead pid with no evidence reconciles to orphaned failure",
      id: "00000000-0000-4000-8000-0000000000a4",
      record: { state: "running", pid: 99999999 },
      events: "",
      lastMessage: "",
      expected: { state: "failed", detail: "orphaned" }
    }
  ])("maps the $name status branch and never echoes raw codex output", async ({ id, record, events, lastMessage, expected }) => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const adapter = createCodexCliAdapter({ home: fixture.home, config: makeConfig(fixture), env: {} });
    const runDir = await seedRun(fixture, id, record, events, lastMessage);

    const status = await adapter.status(id);
    expect(status).toEqual(expected);
    expect(JSON.stringify(status)).not.toMatch(/raw provider error|final body that must not surface/);
    if (record.state === "running" && typeof record.pid === "number") {
      expect(await readJson(path.join(runDir, "run.json"))).toMatchObject(expected);
    }
  });

  it("persists a terminal record even when the runner reports a pid mid-run", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture),
      env: {},
      run: async (request) => {
        request.onPid?.(99999999);
        await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
        await writeFile(request.resultFile, "final\n", { mode: 0o600 });
        return { exitCode: 0, pid: 99999999 };
      }
    });

    const { handle } = await adapter.start(completeHandoff());
    await expect.poll(() => adapter.status(handle)).toEqual({ state: "completed", detail: "Codex run completed." });

    const persisted = await readJson(runRecordPath(fixture.home, handle));
    expect(persisted).toMatchObject({ state: "completed", exitCode: 0, pid: 99999999 });
    expect(typeof persisted.finishedAt).toBe("string");
  });

  it("runs a real detached codex process end-to-end through the default runner", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const fakeBin = path.join(fixture.home, "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    const fakeCodex = path.join(fakeBin, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const oIdx = args.indexOf('-o');",
        "const resultFile = oIdx >= 0 ? args[oIdx + 1] : null;",
        "const chunks = [];",
        "process.stdin.on('data', (c) => chunks.push(c));",
        "process.stdin.on('end', () => {",
        "  if (resultFile) fs.writeFileSync(resultFile, 'final message from fake codex\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n', () => process.exit(0));",
        "});",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
    await chmod(fakeCodex, 0o755);

    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: makeConfig(fixture, { timeoutMs: 10000 }),
      env: { PATH: `${fakeBin}:${path.dirname(process.execPath)}`, HOME: fixture.home }
    });

    const { handle, worktreePath } = await adapter.start(completeHandoff());
    expect(worktreePath).toBe(path.join(fixture.home, ".planbridge", "worktrees", handle));

    await expect
      .poll(() => adapter.status(handle), { timeout: 8000, interval: 50 })
      .toEqual({ state: "completed", detail: "Codex run completed." });

    await expect(execFileAsync("git", ["-C", fixture.projectRoot, "status", "--porcelain"])).resolves.toMatchObject({
      stdout: ""
    });
    await expect(execFileAsync("git", ["-C", fixture.projectRoot, "rev-parse", "main"])).resolves.toBeDefined();
  });
});
