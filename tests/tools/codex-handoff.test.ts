import { lstat, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureProject, type FixtureProject } from "../helpers/fixtures.js";
import { createToolContext, type ToolContext } from "../../src/tool-context.js";
import { repoReadFiles } from "../../src/tools/repo-read-files.js";
import { codexHandoff, codexHandoffInputSchema, type CodexHandoffToolOutput } from "../../src/tools/codex-handoff.js";
import {
  createHandoffFileAdapter,
  parseHandoffArtifact,
  renderHandoffArtifact
} from "../../src/adapters/handoff-file.js";
import type { CodexHandoff } from "../../src/adapters/codex-adapter.js";
import { initGitFixture } from "../helpers/fixtures.js";

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

function makeContext(fixture: FixtureProject): ToolContext {
  return createToolContext({
    home: fixture.home,
    config: {
      schemaVersion: "1.0",
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      port: 7676,
      transport: "streamable-http",
      connection: { kind: "localhost" },
      auth: { mode: "none" }
    }
  });
}

function completeHandoff(overrides: Partial<CodexHandoff> = {}): CodexHandoff {
  return {
    schema_version: "1.0",
    project: "alpha",
    objective: "Implement the accepted plan",
    context: "Use the planning bundle and preserve the existing tests.",
    constraints: "Do not mutate unrelated files.",
    non_goals: ["Do not deploy"],
    likely_files: ["src/index.ts", "tests/index.test.ts"],
    verification: ["npm test", "npm run build"],
    stop_conditions: ["Tests fail after two focused attempts"],
    ...overrides
  };
}

function expectSuccess(result: CodexHandoffToolOutput): Extract<CodexHandoffToolOutput, { handle: string }> {
  expect(result).not.toHaveProperty("error");
  return result as Extract<CodexHandoffToolOutput, { handle: string }>;
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n\n/.exec(markdown);
  if (!match) {
    throw new Error("frontmatter not found");
  }
  return parse(match[1]) as Record<string, unknown>;
}

async function relativeTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

describe("codex_handoff", () => {
  it("validates input and returns handle, id, and mode under ~/.planbridge/handoffs", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = makeContext(fixture);

    expect(codexHandoffInputSchema.parse(completeHandoff())).toEqual(completeHandoff());

    const result = expectSuccess(await codexHandoff(completeHandoff(), context));

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.mode).toBe("subscription");
    expect(result.handle).toBe(path.join(fixture.home, ".planbridge", "handoffs", `${result.id}.md`));
    expect(path.isAbsolute(result.handle)).toBe(true);
  });

  it("writes the frozen section 7.4 artifact and round-trips frontmatter plus H2 bodies", async () => {
    const fixture = await createFixtureProject("alpha");
    const input = completeHandoff({
      objective: "Ship a focused M3 handoff",
      context: "Planner context\nwith a second line.",
      constraints: "Keep changes narrow\nand verified.",
      verification: ["npm test", "npm run build"],
      stop_conditions: ["Unexpected repo writes", "Missing acceptance evidence"]
    });

    const result = expectSuccess(await codexHandoff(input, makeContext(fixture)));
    const markdown = await readFile(result.handle, "utf8");
    const frontmatter = parseFrontmatter(markdown);
    const parsed = parseHandoffArtifact(markdown);

    expect(Object.keys(frontmatter).sort()).toEqual([
      "likely_files",
      "non_goals",
      "objective",
      "project",
      "schema_version",
      "stop_conditions",
      "verification"
    ]);
    expect(frontmatter).toEqual({
      schema_version: "1.0",
      objective: input.objective,
      project: "alpha",
      non_goals: input.non_goals,
      likely_files: input.likely_files,
      verification: input.verification,
      stop_conditions: input.stop_conditions
    });
    expect([...markdown.matchAll(/^## .+$/gm)].map((match) => match[0])).toEqual([
      "## Objective",
      "## Context",
      "## Constraints",
      "## Verification",
      "## Stop Conditions"
    ]);
    expect(parsed).toEqual(input);
  });

  it("rejects incomplete handoffs with E_HANDOFF_INCOMPLETE and writes no artifact", async () => {
    const requiredCases: Array<[string, Partial<CodexHandoff>]> = [
      ["missing objective", { objective: undefined }],
      ["empty objective", { objective: "" }],
      ["missing context", { context: undefined }],
      ["empty context", { context: "  " }],
      ["missing constraints", { constraints: undefined }],
      ["empty constraints", { constraints: "" }],
      ["empty verification", { verification: [] }],
      ["empty verification item", { verification: ["  "] }],
      ["empty stop_conditions", { stop_conditions: [] }],
      ["empty stop_conditions item", { stop_conditions: [""] }]
    ];

    for (const [_name, override] of requiredCases) {
      const fixture = await createFixtureProject("alpha");
      const result = await codexHandoff({ ...completeHandoff(), ...override } as Record<string, unknown>, makeContext(fixture));

      expect(result).toEqual({
        error: expect.objectContaining({ code: "E_HANDOFF_INCOMPLETE" })
      });
      await expect(readdir(path.join(fixture.home, ".planbridge", "handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const acceptedFixture = await createFixtureProject("alpha");
    expectSuccess(
      await codexHandoff(
        completeHandoff({
          non_goals: [],
          likely_files: []
        }),
        makeContext(acceptedFixture)
      )
    );
  });

  it("writes only a private artifact outside the project tree and keeps ~/.planbridge unreadable through repo_read_files", async () => {
    const fixture = await createFixtureProject("alpha");
    const beforeTree = await relativeTree(fixture.projectsRoot);
    const result = expectSuccess(await codexHandoff(completeHandoff(), makeContext(fixture)));

    const artifactStat = await stat(result.handle);
    expect(result.handle.startsWith(path.join(fixture.home, ".planbridge", "handoffs"))).toBe(true);
    expect(artifactStat.mode & 0o777).toBe(0o600);
    expect(await relativeTree(fixture.projectsRoot)).toEqual(beforeTree);

    await symlink(result.handle, path.join(fixture.projectRoot, "handoff.md"));
    const readResult = await repoReadFiles({ project: "alpha", paths: ["handoff.md"] }, makeContext(fixture));
    expect(readResult).toEqual({
      error: {
        code: "E_PATH_TRAVERSAL",
        message: "Resolved path escapes the project root.",
        path: "handoff.md"
      }
    });
  });

  it("returns E_PROJECT_NOT_ALLOWED before writing for a non-allowlisted project", async () => {
    const fixture = await createFixtureProject("alpha");
    const result = await codexHandoff(completeHandoff({ project: "not-allowed" }), makeContext(fixture));

    expect(result).toEqual({
      error: {
        code: "E_PROJECT_NOT_ALLOWED",
        message: "Project is not in the allowlist: not-allowed",
        path: "not-allowed"
      }
    });
    await expect(readdir(path.join(fixture.home, ".planbridge", "handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("performs no project read or mutation while writing the handoff artifact", async () => {
    const fixture = await createFixtureProject("alpha");
    const beforeTree = await relativeTree(fixture.projectsRoot);
    const beforeMtimes = new Map<string, number>();
    for (const relative of beforeTree) {
      beforeMtimes.set(relative, (await lstat(path.join(fixture.projectsRoot, relative))).mtimeMs);
    }

    expectSuccess(await codexHandoff(completeHandoff(), makeContext(fixture)));

    expect(await relativeTree(fixture.projectsRoot)).toEqual(beforeTree);
    for (const relative of beforeTree) {
      expect((await lstat(path.join(fixture.projectsRoot, relative))).mtimeMs).toBe(beforeMtimes.get(relative));
    }
  });

  it("round-trips YAML-hostile frontmatter values without field bleed", async () => {
    const hostile = "Objective --- with: colon\n\"quotes\" # comment";
    const input = completeHandoff({
      objective: hostile,
      non_goals: ["not: yaml", "---", "# nope"],
      likely_files: ["src/a:b.ts"],
      verification: ["npm test -- --name \"a:b\""],
      stop_conditions: ["stop: now"]
    });
    const fixture = await createFixtureProject("alpha");

    const result = expectSuccess(await codexHandoff(input, makeContext(fixture)));
    const markdown = await readFile(result.handle, "utf8");
    const frontmatter = parseFrontmatter(markdown);

    expect(frontmatter.objective).toBe(hostile);
    expect(frontmatter.non_goals).toEqual(input.non_goals);
    expect(frontmatter.likely_files).toEqual(input.likely_files);
    expect(frontmatter.verification).toEqual(input.verification);
    expect(frontmatter.stop_conditions).toEqual(input.stop_conditions);
    expect(parseHandoffArtifact(markdown)).toEqual(input);
  });

  it("keeps likely_files advisory and never resolves traversal-looking entries", async () => {
    const fixture = await createFixtureProject("alpha");
    const input = completeHandoff({ likely_files: ["../../escape.md", ".env", "src/index.ts"] });
    const result = expectSuccess(await codexHandoff(input, makeContext(fixture)));
    const markdown = await readFile(result.handle, "utf8");
    const beforeTree = await relativeTree(fixture.projectsRoot);

    expect(markdown).toContain("../../escape.md");
    expect(parseHandoffArtifact(markdown).likely_files).toEqual(input.likely_files);
    expect(await relativeTree(fixture.projectsRoot)).toEqual(beforeTree);
  });

  it("detects api-key mode without returning or logging the key value", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = makeContext(fixture);
    const secret = "sk-proj-secret-value-for-test";
    process.env.OPENAI_API_KEY = secret;

    const result = expectSuccess(await codexHandoff(completeHandoff(), context));
    const audit = await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8");

    expect(result.mode).toBe("api-key");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(audit).not.toContain(secret);

    process.env.OPENAI_API_KEY = "";
    expect(expectSuccess(await codexHandoff(completeHandoff(), makeContext(await createFixtureProject("alpha")))).mode).toBe("subscription");
  });

  it("returns an actionable E_API_KEY_MODE message for codex-cli without leaking key bytes", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const secret = "sk-proj-secret-value-for-test";
    process.env.OPENAI_API_KEY = secret;
    const context = createToolContext({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        execution: { adapter: "codex-cli", timeoutMs: 1000 }
      }
    });

    const result = await codexHandoff(completeHandoff(), context);

    expect(result).toEqual({
      error: expect.objectContaining({
        code: "E_API_KEY_MODE",
        message: expect.stringMatching(/Unset OPENAI_API_KEY\/CODEX_API_KEY.*subscription/i)
      })
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(readdir(path.join(fixture.home, ".planbridge", "handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes exactly one metadata-only handoff audit event per successful call", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = makeContext(fixture);
    const input = completeHandoff({
      objective: "Do not log this objective",
      context: "secret sk-proj-body-secret-value"
    });

    const result = expectSuccess(await codexHandoff(input, context));
    const entries = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toEqual([
      expect.objectContaining({
        event: "handoff",
        tool: "codex_handoff",
        project: "alpha",
        path: result.handle,
        sessionId: context.session.id
      })
    ]);
    expect(JSON.stringify(entries)).not.toContain(input.objective);
    expect(JSON.stringify(entries)).not.toContain("sk-proj-body-secret-value");
  });

  it("selects codex-cli from operator config and writes one metadata-only exec audit event", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const input = completeHandoff({
      objective: "Do not audit this objective",
      context: "secret sk-proj-tool-body"
    });
    const context = createToolContext({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        execution: { adapter: "codex-cli", timeoutMs: 1000 }
      },
      codexRunner: async (request) => {
        await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
        await writeFile(request.resultFile, "final body should stay out of audit\n", { mode: 0o600 });
        return { exitCode: 0 };
      }
    });

    const result = expectSuccess(await codexHandoff(input, context));
    const audit = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.handle).toBe(path.join(fixture.home, ".planbridge", "handoffs", `${result.id}.md`));
    expect(result.execution).toMatchObject({
      adapter: "codex-cli",
      runHandle: result.id,
      state: expect.stringMatching(/^(running|completed)$/)
    });
    expect(audit).toEqual([
      expect.objectContaining({
        event: "exec",
        tool: "codex_handoff",
        project: "alpha",
        runId: result.id,
        path: path.join(fixture.home, ".planbridge", "worktrees", result.id),
        sessionId: context.session.id
      })
    ]);
    expect(JSON.stringify(audit)).not.toContain(input.objective);
    expect(JSON.stringify(audit)).not.toContain("sk-proj-tool-body");
    expect(JSON.stringify(audit)).not.toContain("final body should stay out of audit");
  });

  it("audits the adapter's resolved worktree path under a custom worktreeRoot", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const worktreeRoot = path.join(fixture.home, ".planbridge", "alt-worktrees");
    const context = createToolContext({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        execution: { adapter: "codex-cli", worktreeRoot, timeoutMs: 1000 }
      },
      codexRunner: async (request) => {
        await writeFile(request.eventsFile, '{"type":"turn.completed"}\n', { mode: 0o600 });
        await writeFile(request.resultFile, "final\n", { mode: 0o600 });
        return { exitCode: 0 };
      }
    });

    const result = expectSuccess(await codexHandoff(completeHandoff(), context));
    const audit = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(audit[0].path).toBe(path.join(worktreeRoot, result.id));
  });

  it("implements the handoff-file CodexAdapter contract", async () => {
    const fixture = await createFixtureProject("alpha");
    const adapter = createHandoffFileAdapter({ home: fixture.home, env: {} });
    const input = completeHandoff();

    expect(adapter.mode()).toBe("subscription");
    const { handle } = await adapter.start(input);

    expect(await adapter.status(handle)).toEqual({ state: "queued" });
    expect(parseHandoffArtifact(await readFile(handle, "utf8"))).toEqual(input);
    expect(renderHandoffArtifact(input)).toContain("## Stop Conditions");
  });
});
