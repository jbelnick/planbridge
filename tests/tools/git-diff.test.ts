import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createCodexCliAdapter,
  readRunDiffTarget,
  runRecordPath
} from "../../src/adapters/codex-cli.js";
import type { CodexHandoff } from "../../src/adapters/codex-adapter.js";
import { planbridgeHome, type PlanbridgeConfig } from "../../src/config.js";
import { DEFAULT_LIMITS } from "../../src/limits.js";
import { createToolContext, type ToolContext } from "../../src/tool-context.js";
import {
  gitDiffInputSchema,
  gitDiffTool,
  isInside,
  truncateOnLineBoundary,
  type GitDiffOutput,
  type GitDiffResult
} from "../../src/tools/git-diff.js";
import { createFixtureProject, initGitFixture, type FixtureProject } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);
const VALID_HANDLE = "00000000-0000-4000-8000-000000000101";

function makeConfig(
  fixture: FixtureProject,
  options: { allowlist?: string[]; limits?: PlanbridgeConfig["limits"] } = {}
): PlanbridgeConfig {
  return {
    schemaVersion: "1.0",
    projectsRoot: fixture.projectsRoot,
    allowlist: options.allowlist ?? ["alpha"],
    port: 7676,
    transport: "streamable-http",
    connection: { kind: "localhost" },
    auth: { mode: "none" },
    ...(options.limits ? { limits: options.limits } : {})
  };
}

function makeContext(
  fixture: FixtureProject,
  options: { allowlist?: string[]; limits?: PlanbridgeConfig["limits"] } = {}
): ToolContext {
  return createToolContext({
    home: fixture.home,
    config: makeConfig(fixture, options)
  });
}

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

async function git(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", projectRoot, ...args], {
    env: { ...process.env, LC_ALL: "C", LANG: "C" }
  });
  return stdout;
}

async function createRunTarget(
  fixture: FixtureProject,
  options: {
    handle?: string;
    prepareBase?: () => Promise<void>;
    baseSha?: string;
    worktreePath?: string;
    project?: string;
  } = {}
): Promise<{ handle: string; baseSha: string; branch: string; worktreePath: string }> {
  await initGitFixture(fixture.projectRoot);
  await options.prepareBase?.();
  const baseSha = options.baseSha ?? (await git(fixture.projectRoot, ["rev-parse", "HEAD"])).trim();
  const handle = options.handle ?? VALID_HANDLE;
  const branch = `planbridge/${handle}`;
  const worktreePath = options.worktreePath ?? path.join(planbridgeHome({ HOME: fixture.home }), "worktrees", handle);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  if (!options.worktreePath) {
    await execFileAsync("git", ["-C", fixture.projectRoot, "worktree", "add", worktreePath, "-b", branch, baseSha]);
  }
  const runDir = path.join(planbridgeHome({ HOME: fixture.home }), "runs", handle);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify({
      id: handle,
      project: options.project ?? "alpha",
      worktreePath,
      branch,
      baseSha,
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
  await writeFile(path.join(runDir, "events.jsonl"), '{"type":"turn.completed"}\n', { mode: 0o600 });
  await writeFile(path.join(runDir, "last-message.txt"), "done\n", { mode: 0o600 });
  return { handle, baseSha, branch, worktreePath };
}

function expectDiff(result: GitDiffOutput): GitDiffResult {
  expect(result).not.toHaveProperty("error");
  return result as GitDiffResult;
}

async function readAudit(fixture: FixtureProject): Promise<Array<Record<string, unknown>>> {
  const log = await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8");
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("git_diff", () => {
  it("accepts only run-scoped input and returns E_HANDOFF_INCOMPLETE for malformed handles", async () => {
    const parsed = gitDiffInputSchema.parse({
      runHandle: VALID_HANDLE,
      maxDiffBytes: 128,
      project: "alpha",
      rev: "HEAD",
      path: "README.md",
      cursor: "nope"
    });
    expect(parsed).toEqual({ runHandle: VALID_HANDLE, maxDiffBytes: 128 });

    const fixture = await createFixtureProject("alpha");
    await expect(gitDiffTool({ runHandle: "../../escape" }, makeContext(fixture))).resolves.toEqual({
      error: expect.objectContaining({ code: "E_HANDOFF_INCOMPLETE" })
    });
  });

  it("captures baseSha on codex-cli run records and exposes only the narrow diff target", async () => {
    const fixture = await createFixtureProject("alpha");
    const baseSha = await initGitFixture(fixture.projectRoot);
    const handle = "00000000-0000-4000-8000-00000000abcd";
    const adapter = createCodexCliAdapter({
      home: fixture.home,
      config: {
        ...makeConfig(fixture),
        execution: { adapter: "codex-cli", timeoutMs: 1000 }
      },
      env: {},
      randomId: () => handle,
      run: async (request) => {
        await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
        await writeFile(request.resultFile, "final\n", { mode: 0o600 });
        return { exitCode: 0 };
      }
    });

    await adapter.start(completeHandoff());
    const rawRecord = JSON.parse(await readFile(runRecordPath(fixture.home, handle), "utf8")) as Record<string, unknown>;
    const target = await readRunDiffTarget(fixture.home, handle);

    expect(rawRecord.baseSha).toBe(baseSha);
    expect(target).toEqual({
      project: "alpha",
      worktreePath: path.join(fixture.home, ".planbridge", "worktrees", handle),
      branch: `planbridge/${handle}`,
      baseSha
    });
    expect(Object.keys(target ?? {}).sort()).toEqual(["baseSha", "branch", "project", "worktreePath"]);
    await expect(readRunDiffTarget(fixture.home, "../../escape")).rejects.toMatchObject({ code: "E_HANDOFF_INCOMPLETE" });
    await expect(readRunDiffTarget(fixture.home, "00000000-0000-4000-8000-000000000999")).resolves.toBeNull();
  });

  it("returns committed and untracked changes while leaving status porcelain byte-identical", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture);
    await writeFile(path.join(target.worktreePath, "README.md"), "# Alpha\nchanged in commit\n");
    await git(target.worktreePath, ["add", "README.md"]);
    await git(target.worktreePath, ["commit", "-m", "codex committed change"]);
    await writeFile(path.join(target.worktreePath, "SMOKE.txt"), "smoke untracked\n");
    const before = await git(target.worktreePath, ["status", "--porcelain"]);

    const diff = expectDiff(await gitDiffTool({ runHandle: target.handle }, makeContext(fixture)));
    const after = await git(target.worktreePath, ["status", "--porcelain"]);

    expect(after).toBe(before);
    expect(diff).toMatchObject({
      base: target.baseSha,
      branch: target.branch,
      committed: true,
      truncated: false
    });
    expect(diff.files.map((file) => file.path)).toEqual(["README.md", "SMOKE.txt"]);
    expect(diff.files[0]).toMatchObject({
      path: "README.md",
      kind: "modified",
      untracked: false,
      additions: 1,
      deletions: 0
    });
    expect(diff.files[0].patch).toContain("+changed in commit");
    expect(diff.files[1]).toMatchObject({
      path: "SMOKE.txt",
      kind: "added",
      untracked: true,
      additions: 1,
      deletions: 0
    });
    expect(diff.files[1].patch).toContain("--- /dev/null");
    expect(diff.files[1].patch).toContain("+++ b/SMOKE.txt");
    expect(diff.files[1].patch).toContain("+smoke untracked");
    expect(diff.next_cursor).toBeUndefined();
    const readEntries = (await readAudit(fixture)).filter((entry) => entry.event === "read" && entry.tool === "git_diff");
    expect(readEntries).toEqual([
      expect.objectContaining({
        runId: target.handle,
        bytes: diff.total_estimate,
        filesTouched: 2,
        sessionId: "local-test-session"
      })
    ]);
  });

  it("surfaces untracked-only runs as uncommitted synthesized added-file patches", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture);
    await writeFile(path.join(target.worktreePath, "SMOKE.txt"), "smoke only\n");

    const diff = expectDiff(await gitDiffTool({ runHandle: target.handle }, makeContext(fixture)));

    expect(diff.committed).toBe(false);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "SMOKE.txt",
      kind: "added",
      untracked: true,
      additions: 1,
      deletions: 0
    });
    expect(diff.files[0].patch.length).toBeGreaterThan(0);
  });

  it("blocks untracked symlinks and returns binary placeholders without leaking target bytes", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture);
    await writeFile(path.join(target.worktreePath, "binary.dat"), Buffer.from([65, 0, 66, 67]));
    await symlink("/etc/hosts", path.join(target.worktreePath, "notes.txt"));
    await symlink(".env", path.join(target.worktreePath, "local-notes.txt"));

    const diff = expectDiff(await gitDiffTool({ runHandle: target.handle }, makeContext(fixture)));
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(byPath.get("binary.dat")).toMatchObject({
      kind: "added",
      untracked: true,
      additions: 0,
      deletions: 0,
      patch: "Binary file added (4 bytes)"
    });
    expect(byPath.get("notes.txt")).toMatchObject({
      kind: "blocked",
      blockedReason: "E_SECRET_BLOCKED",
      patch: ""
    });
    expect(JSON.stringify(diff)).not.toContain("localhost");
    expect(await readAudit(fixture)).toContainEqual(
      expect.objectContaining({
        event: "blocked",
        tool: "git_diff",
        path: "notes.txt",
        blockReason: "E_SECRET_BLOCKED"
      })
    );
    expect(byPath.get("local-notes.txt")).toMatchObject({
      kind: "blocked",
      blockedReason: "E_SECRET_BLOCKED",
      patch: ""
    });
    expect(JSON.stringify(diff)).not.toContain("sk-test");
  });

  it("keeps deterministic ordering and literal spaced paths", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture);
    await writeFile(path.join(target.worktreePath, "src.txt"), "alpha needle\ntracked change\n");
    await writeFile(path.join(target.worktreePath, "zeta.txt"), "last\n");
    await writeFile(path.join(target.worktreePath, "my notes.txt"), "literal path\n");

    const first = expectDiff(await gitDiffTool({ runHandle: target.handle }, makeContext(fixture)));
    const second = expectDiff(await gitDiffTool({ runHandle: target.handle }, makeContext(fixture)));

    expect(first.files.map((file) => file.path)).toEqual(["src.txt", "my notes.txt", "zeta.txt"]);
    expect(second.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
    expect(first.files[1].patch).toContain("+++ b/my notes.txt");
    expect(JSON.stringify(first)).not.toContain("\\303");
  });

  it("redacts secrets before truncating and never splits PEM blocks across the cap", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture);
    await writeFile(path.join(target.worktreePath, "src.txt"), "alpha needle\nsk-secret-token-value\nAKIA1234567890ABCDEF\n");
    await writeFile(
      path.join(target.worktreePath, "pem.txt"),
      [
        "before",
        "-----BEGIN PRIVATE KEY-----",
        "A".repeat(160),
        "-----END PRIVATE KEY-----",
        "after",
        ""
      ].join("\n")
    );

    const diff = expectDiff(await gitDiffTool({ runHandle: target.handle, maxDiffBytes: 180 }, makeContext(fixture)));

    expect(JSON.stringify(diff)).toContain("[PLANBRIDGE_REDACTED]");
    expect(JSON.stringify(diff)).not.toContain("sk-secret-token-value");
    expect(JSON.stringify(diff)).not.toContain("AKIA1234567890ABCDEF");
    expect(JSON.stringify(diff)).not.toContain("-----BEGIN");
    expect(diff.truncated).toBe(true);
    expect(diff.files.some((file) => file.patchTruncated === true)).toBe(true);
    for (const file of diff.files) {
      if (file.patchTruncated && file.patch.length > 0) {
        expect(file.patch.endsWith("\n")).toBe(true);
      }
    }
    expect(await readAudit(fixture)).toContainEqual(
      expect.objectContaining({
        event: "redact",
        tool: "git_diff"
      })
    );
  });

  it("blocks denylisted paths, deleted denylisted paths, rename endpoints, and tracked gitignored paths", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture, {
      prepareBase: async () => {
        await writeFile(path.join(fixture.projectRoot, "tracked-ignored.txt"), "ignored at base\n");
        await writeFile(path.join(fixture.projectRoot, ".npmrc"), "TOKEN=sk-base-should-not-leak\n");
        await writeFile(path.join(fixture.projectRoot, ".gitignore"), "ignored.txt\nbuild/\ntracked-ignored.txt\n");
        await execFileAsync("git", ["-C", fixture.projectRoot, "add", ".gitignore"]);
        await execFileAsync("git", ["-C", fixture.projectRoot, "add", ".npmrc"]);
        await execFileAsync("git", ["-C", fixture.projectRoot, "add", "-f", "tracked-ignored.txt"]);
        await execFileAsync("git", ["-C", fixture.projectRoot, "commit", "-m", "track ignored file"]);
      }
    });
    await writeFile(path.join(target.worktreePath, ".env.production"), "TOKEN=sk-added-should-not-leak\n");
    await execFileAsync("git", ["-C", target.worktreePath, "mv", ".env", "safe-env-copy.txt"]);
    await writeFile(path.join(target.worktreePath, ".npmrc"), "TOKEN=sk-should-not-leak\n");
    await rm(path.join(target.worktreePath, ".npmrc"));
    await execFileAsync("git", ["-C", target.worktreePath, "mv", "README.md", "credentials.txt"]);
    await writeFile(path.join(target.worktreePath, "tracked-ignored.txt"), "ignored changed\n");
    await writeFile(path.join(target.worktreePath, "src.txt"), "alpha needle\nsibling visible\n");
    await writeFile(path.join(target.worktreePath, "ignored.txt"), "untracked ignored should not appear\n");

    const diff = expectDiff(await gitDiffTool({ runHandle: target.handle }, makeContext(fixture)));
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(byPath.get(".env.production")).toMatchObject({ kind: "blocked", blockedReason: "E_SECRET_BLOCKED", patch: "" });
    expect(byPath.get("safe-env-copy.txt")).toMatchObject({
      kind: "blocked",
      oldPath: ".env",
      blockedReason: "E_SECRET_BLOCKED",
      patch: ""
    });
    expect(byPath.get(".npmrc")).toMatchObject({ kind: "blocked", blockedReason: "E_SECRET_BLOCKED", patch: "" });
    expect(byPath.get("credentials.txt")).toMatchObject({
      kind: "blocked",
      oldPath: "README.md",
      blockedReason: "E_SECRET_BLOCKED",
      patch: ""
    });
    expect(byPath.get("tracked-ignored.txt")).toMatchObject({
      kind: "blocked",
      blockedReason: "E_GITIGNORED",
      patch: ""
    });
    expect(byPath.get("src.txt")?.patch).toContain("+sibling visible");
    expect(diff.files.map((file) => file.path)).not.toContain("ignored.txt");
    const audit = await readAudit(fixture);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "blocked", path: ".env.production", blockReason: "E_SECRET_BLOCKED" }),
        expect.objectContaining({ event: "blocked", path: "safe-env-copy.txt", blockReason: "E_SECRET_BLOCKED" }),
        expect.objectContaining({ event: "blocked", path: ".npmrc", blockReason: "E_SECRET_BLOCKED" }),
        expect.objectContaining({ event: "blocked", path: "credentials.txt", blockReason: "E_SECRET_BLOCKED" }),
        expect.objectContaining({ event: "blocked", path: "tracked-ignored.txt", blockReason: "E_GITIGNORED" })
      ])
    );
    expect(JSON.stringify(diff)).not.toContain("sk-added-should-not-leak");
    expect(JSON.stringify(diff)).not.toContain("sk-should-not-leak");
    expect(JSON.stringify(diff)).not.toContain("sk-base-should-not-leak");
  });

  it("soft-truncates above the effective cap without E_SIZE_EXCEEDED and never lets callers raise the default cap", async () => {
    const fixture = await createFixtureProject("alpha");
    const target = await createRunTarget(fixture);
    await writeFile(path.join(target.worktreePath, "large.txt"), `${Array.from({ length: 120 }, (_, index) => `line-${index}`).join("\n")}\n`);
    await writeFile(path.join(target.worktreePath, ".env.local"), "TOKEN=sk-blocked-not-read\n");

    const small = expectDiff(await gitDiffTool({ runHandle: target.handle, maxDiffBytes: 120 }, makeContext(fixture)));
    const raised = expectDiff(
      await gitDiffTool(
        { runHandle: target.handle, maxDiffBytes: DEFAULT_LIMITS.maxDiffBytes * 10 },
        makeContext(fixture, { limits: { maxDiffBytes: 160 } })
      )
    );

    expect(small.truncated).toBe(true);
    expect(small.files.some((file) => file.patchTruncated === true)).toBe(true);
    const returnedPatchBytes = small.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch, "utf8"), 0);
    expect(small.total_estimate).toBe(returnedPatchBytes + (await stat(path.join(target.worktreePath, ".env.local"))).size);
    expect((await readAudit(fixture)).filter((entry) => entry.event === "read")[0]).toMatchObject({ bytes: returnedPatchBytes });
    expect(small).not.toHaveProperty("error");
    expect(JSON.stringify(small)).not.toContain("E_SIZE_EXCEEDED");
    const blocked = small.files.find((file) => file.path === ".env.local");
    expect(blocked).toMatchObject({ kind: "blocked", patch: "" });
    expect(blocked).not.toHaveProperty("patchTruncated");
    expect(small.files.find((file) => file.path === "large.txt")?.patch.length).toBeGreaterThan(0);
    expect(raised.truncated).toBe(true);
    const raisedReturnedPatchBytes = raised.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch, "utf8"), 0);
    expect(raisedReturnedPatchBytes).toBeLessThanOrEqual(160);
  });

  it("maps closed error cases without adding error codes or leaking raw git stderr", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = makeContext(fixture);

    await expect(gitDiffTool({ runHandle: "00000000-0000-4000-8000-000000000404" }, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_NOT_FOUND" })
    });

    await initGitFixture(fixture.projectRoot);
    const missingBase = "00000000-0000-4000-8000-000000000405";
    const runDir = path.join(planbridgeHome({ HOME: fixture.home }), "runs", missingBase);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify({
        id: missingBase,
        project: "alpha",
        worktreePath: fixture.projectRoot,
        branch: `planbridge/${missingBase}`,
        resultFile: path.join(runDir, "last-message.txt"),
        eventsFile: path.join(runDir, "events.jsonl"),
        state: "completed",
        startedAt: new Date().toISOString(),
        mode: "subscription"
      }),
      { mode: 0o600 }
    );
    await expect(gitDiffTool({ runHandle: missingBase }, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_NOT_FOUND" })
    });

    const gone = await createRunTarget(fixture, { handle: "00000000-0000-4000-8000-000000000406" });
    await rm(gone.worktreePath, { recursive: true, force: true });
    await expect(gitDiffTool({ runHandle: gone.handle }, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_NOT_FOUND" })
    });

    const deallowlisted = await createRunTarget(fixture, { handle: "00000000-0000-4000-8000-000000000407" });
    await expect(gitDiffTool({ runHandle: deallowlisted.handle }, makeContext(fixture, { allowlist: ["beta"] }))).resolves.toEqual({
      error: expect.objectContaining({ code: "E_PROJECT_NOT_ALLOWED" })
    });

    const nonRepoDir = path.join(fixture.home, "not-a-repo");
    await mkdir(nonRepoDir, { recursive: true });
    const nonRepo = await createRunTarget(fixture, {
      handle: "00000000-0000-4000-8000-000000000408",
      worktreePath: nonRepoDir,
      baseSha: "a".repeat(40)
    });
    await expect(gitDiffTool({ runHandle: nonRepo.handle }, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_NOT_A_REPO" })
    });

    const badBase = await createRunTarget(fixture, {
      handle: "00000000-0000-4000-8000-000000000409"
    });
    const badRecord = JSON.parse(await readFile(runRecordPath(fixture.home, badBase.handle), "utf8")) as Record<string, unknown>;
    await writeFile(runRecordPath(fixture.home, badBase.handle), `${JSON.stringify({ ...badRecord, baseSha: "a".repeat(40) })}\n`, {
      mode: 0o600
    });
    const failure = await gitDiffTool({ runHandle: badBase.handle }, context);
    expect(failure).toEqual({
      error: expect.objectContaining({
        code: "E_WORKTREE_FAILED",
        message: "git_diff failed while reading the run worktree."
      })
    });
    expect(JSON.stringify(failure)).not.toContain(fixture.home);
  });

  it("keeps the source contract read-only and uses the exact registry/spawn/redaction guard forms", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "tools", "git-diff.ts"), "utf8");

    expect(source).toContain("safeParse");
    expect(source).not.toContain(".parse(");
    expect(source).toContain("Math.min");
    expect(source).toContain("execFileAsync(\"git\"");
    expect(source).toContain("Math.max(1, context.limits.toolTimeoutMs - 1000)");
    expect(source).toContain("LC_ALL: \"C\"");
    expect(source).toContain("LANG: \"C\"");
    expect(source).toContain("--numstat");
    expect(source).toContain("--find-renames");
    expect(source).toContain("core.quotePath=false");
    expect(source).toContain("--no-color");
    expect(source).toContain("--no-ext-diff");
    expect(source).toContain("ls-files");
    expect(source).toContain("--exclude-standard");
    expect(source).toContain("realpath");
    expect(source).toContain("isInside");
    expect(source).not.toMatch(/"add"|--intent-to-add|"commit"|"merge"|"checkout"|"reset"/);
    expect(source).not.toMatch(/E_SIZE_EXCEEDED|sizeExceeded/);
    expect(source).not.toMatch(/shell|exec\(/);
    expect(source).not.toMatch(/runs.*run\.json|readRunRecord|RunRecord/);
  });
});

describe("git_diff internals", () => {
  it("drops an orphan BEGIN block when truncation lands inside it (dropPartialPemBlock fires)", () => {
    // An orphan `-----BEGIN` header (no matching END) survives redaction's
    // END-anchored PEM regex, so the only defense against it straddling the cap
    // is dropPartialPemBlock inside truncateOnLineBoundary. Force a cut after the
    // BEGIN line but before any END, and assert the orphan header is dropped.
    const content = ["keep-1", "keep-2", "-----BEGIN PRIVATE KEY-----", "body-line", "tail"].join("\n") + "\n";
    const cap = Buffer.byteLength("keep-1\nkeep-2\n-----BEGIN PRIVATE KEY-----\n", "utf8");

    const out = truncateOnLineBoundary(content, cap);

    expect(out).not.toContain("-----BEGIN");
    expect(out).toBe("keep-1\nkeep-2\n");
    expect(out.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(cap);
  });

  it("truncates on a line boundary and returns content unchanged when it fits", () => {
    const content = "alpha\nbeta\ngamma\n";
    expect(truncateOnLineBoundary(content, 10_000)).toBe(content);
    expect(truncateOnLineBoundary(content, 0)).toBe("");
    const clipped = truncateOnLineBoundary(content, Buffer.byteLength("alpha\nbeta\n", "utf8"));
    expect(clipped).toBe("alpha\nbeta\n");
    expect(clipped.endsWith("\n")).toBe(true);
  });

  it("isInside is true for descendants and the root itself, false for escapes", () => {
    const root = "/tmp/wt";
    expect(isInside(root, "/tmp/wt")).toBe(true);
    expect(isInside(root, "/tmp/wt/sub/file.txt")).toBe(true);
    expect(isInside(root, "/tmp/wt/../escape")).toBe(false);
    expect(isInside(root, "/etc/hosts")).toBe(false);
    expect(isInside(root, "/tmp/wtsibling")).toBe(false);
  });
});
