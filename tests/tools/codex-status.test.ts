import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planbridgeHome } from "../../src/config.js";
import { createToolContext } from "../../src/tool-context.js";
import { codexStatus } from "../../src/tools/codex-status.js";
import { createFixtureProject, initGitFixture } from "../helpers/fixtures.js";

describe("codex_status", () => {
  it("maps a persisted run record and writes one metadata-only status audit event", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    const handle = "00000000-0000-4000-8000-000000000002";
    const runDir = path.join(planbridgeHome({ HOME: fixture.home }), "runs", handle);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify({
        id: handle,
        project: "alpha",
        worktreePath: path.join(fixture.home, ".planbridge", "worktrees", handle),
        branch: `planbridge/${handle}`,
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
    await writeFile(path.join(runDir, "last-message.txt"), "secret final body\n", { mode: 0o600 });
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
        execution: { adapter: "codex-cli" }
      }
    });

    await expect(codexStatus({ handle }, context)).resolves.toEqual({
      state: "completed",
      detail: "Codex run completed."
    });
    const entries = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toEqual([
      expect.objectContaining({
        event: "status",
        tool: "codex_status",
        path: handle,
        runId: handle,
        sessionId: context.session.id
      })
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret final body");
  });

  it("returns a ToolError for invalid direct input instead of throwing a Zod error", async () => {
    const fixture = await createFixtureProject("alpha");
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
        execution: { adapter: "codex-cli" }
      }
    });

    await expect(codexStatus({}, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_HANDOFF_INCOMPLETE" })
    });
    await expect(codexStatus({ handle: "../../escape" }, context)).resolves.toEqual({
      error: expect.objectContaining({ code: "E_HANDOFF_INCOMPLETE" })
    });
  });
});
