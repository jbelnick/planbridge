import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureProject, initGitFixture } from "../helpers/fixtures.js";
import { startPlanbridgeServer, type RunningPlanbridgeServer } from "../../src/server.js";

let running: RunningPlanbridgeServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "planbridge-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  return client;
}

describe("PlanBridge MCP server", () => {
  it("registers exactly nine M1 through git_diff tools with codex_handoff as the action tool", async () => {
    const fixture = await createFixtureProject("alpha");
    running = await startPlanbridgeServer({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 0,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      }
    });
    const client = await connectClient(running.url);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "codex_handoff",
      "codex_status",
      "context_pack",
      "git_diff",
      "git_status",
      "project_summary",
      "projects_list",
      "repo_read_files",
      "repo_search"
    ]);
    expect(names.some((name) => /(write|exec|shell|credential|browser)/.test(name))).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "codex_handoff")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true
    });
    expect(tools.tools.filter((tool) => tool.name !== "codex_handoff").every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("drives all nine tools over Streamable HTTP with a local SDK client", async () => {
    const fixture = await createFixtureProject("alpha");
    await initGitFixture(fixture.projectRoot);
    running = await startPlanbridgeServer({
      home: fixture.home,
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 0,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      }
    });
    const client = await connectClient(running.url);

    const projects = await client.callTool({ name: "projects_list", arguments: {} });
    expect(projects.structuredContent).toMatchObject({
      projects: [{ name: "alpha" }],
      truncated: false
    });

    const summary = await client.callTool({ name: "project_summary", arguments: { project: "alpha" } });
    expect(summary.structuredContent).toMatchObject({ name: "alpha", repoType: "node" });

    const search = await client.callTool({ name: "repo_search", arguments: { project: "alpha", query: "needle" } });
    expect(search.structuredContent).toMatchObject({ matches: [{ path: "src.txt", line: 1 }] });

    const read = await client.callTool({
      name: "repo_read_files",
      arguments: { project: "alpha", paths: ["README.md", ".env"] }
    });
    expect(read.structuredContent).toMatchObject({
      files: [{ path: "README.md", content: "# Alpha\n" }],
      blocked: [{ path: ".env", reason: "E_SECRET_BLOCKED" }]
    });
    expect(JSON.stringify(read.structuredContent)).not.toContain("sk-test");

    const pack = await client.callTool({
      name: "context_pack",
      arguments: { project: "alpha", paths: ["README.md", ".env"], prompt: "plan", constraints: ["verify"] }
    });
    expect(pack.structuredContent).toMatchObject({
      schema_version: "1.0",
      project: "alpha",
      prompt: "plan",
      constraints: ["verify"],
      files: [{ path: "README.md", content: "# Alpha\n" }],
      omitted: [{ path: ".env", reason: "E_SECRET_BLOCKED" }]
    });
    expect(JSON.stringify(pack.structuredContent)).not.toContain("sk-test");

    const status = await client.callTool({ name: "git_status", arguments: { project: "alpha" } });
    expect(status.structuredContent).toMatchObject({
      branch: "main",
      detached: false,
      dirty: false,
      summary: { staged: 0, modified: 0, untracked: 0 }
    });

    const handoff = await client.callTool({
      name: "codex_handoff",
      arguments: {
        project: "alpha",
        objective: "Implement the accepted plan",
        context: "Use the context pack.",
        constraints: "Keep changes focused.",
        non_goals: [],
        likely_files: ["README.md"],
        verification: ["npm test"],
        stop_conditions: ["Unexpected repo mutation"]
      }
    });
    expect(handoff.structuredContent).toMatchObject({
      id: expect.any(String),
      handle: expect.stringContaining(path.join(fixture.home, ".planbridge", "handoffs")),
      mode: expect.stringMatching(/^(subscription|api-key)$/)
    });

    const codex = await client.callTool({ name: "codex_status", arguments: { handle: "00000000-0000-4000-8000-000000000099" } });
    expect(codex.structuredContent).toMatchObject({
      state: "failed",
      detail: "run not found"
    });

    const diff = await client.callTool({ name: "git_diff", arguments: { runHandle: "00000000-0000-4000-8000-000000000099" } });
    expect(diff.structuredContent).toMatchObject({
      error: { code: "E_NOT_FOUND" }
    });
  });
});
