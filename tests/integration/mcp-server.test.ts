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
  it("keeps legacy configs on the original nine-tool surface with codex_handoff as the action tool", async () => {
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

  it("registers the guided workflow surface and drives prepare_plan then execute_plan over Streamable HTTP", async () => {
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
        auth: { mode: "none" },
        tools: { profile: "guided" }
      }
    });
    const client = await connectClient(running.url);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(["execute_plan", "prepare_plan", "projects_list", "review_run"]);
    expect(tools.tools.find((tool) => tool.name === "prepare_plan")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false
    });
    expect(tools.tools.find((tool) => tool.name === "execute_plan")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true
    });
    expect(tools.tools.find((tool) => tool.name === "review_run")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false
    });

    const prepared = await client.callTool({
      name: "prepare_plan",
      arguments: {
        objective: "Simplify PlanBridge UX.",
        scope: { paths: ["README.md"], search: [], includeDefaults: false },
        verification: ["npm test"]
      }
    });
    expect(prepared.structuredContent).toMatchObject({
      schema_version: "1.0",
      project: "alpha",
      approval_required: true,
      next: { tool: "execute_plan" },
      artifact: { stored: true }
    });
    expect(JSON.stringify(prepared.structuredContent)).not.toContain(fixture.home);

    const preparedContent = prepared.structuredContent as { plan_id: string; plan_hash: string };
    const executed = await client.callTool({
      name: "execute_plan",
      arguments: {
        plan_id: preparedContent.plan_id,
        approved_plan_hash: preparedContent.plan_hash,
        approval: { user_message: "Approved. Execute that plan." }
      }
    });
    expect(executed.structuredContent).toMatchObject({
      schema_version: "1.0",
      plan_id: preparedContent.plan_id,
      plan_hash: preparedContent.plan_hash,
      execution: { adapter: "handoff-file", state: "queued", artifact: { stored: true } },
      next: { tool: "review_run" }
    });
    expect(JSON.stringify(executed.structuredContent)).not.toContain(fixture.home);
  });

  it("drives all ten tools over Streamable HTTP with a local SDK client when pro_consult is enabled", async () => {
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
        auth: { mode: "none" },
        proConsult: { enabled: true }
      },
      proConsultRunner: async (request) => ({
        answer: "Pro analysis from injected runner.",
        model: request.model,
        mode: "browser-subscription",
        slug: request.slug,
        outputFile: request.outputFile,
        durationMs: 7,
        stdout: "",
        stderr: ""
      })
    });
    const client = await connectClient(running.url);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "pro_consult")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    });

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

    const pro = await client.callTool({
      name: "pro_consult",
      arguments: {
        project: "alpha",
        paths: ["README.md", ".env"],
        prompt: "Use Pro to review.",
        constraints: ["Do not ask for local files."]
      }
    });
    expect(pro.structuredContent).toMatchObject({
      schema_version: "1.0",
      project: "alpha",
      model: "gpt-5.5-pro",
      mode: "browser-subscription",
      answer: "Pro analysis from injected runner.",
      context: {
        files: [expect.objectContaining({ path: "README.md" })],
        omitted: [{ path: ".env", reason: "E_SECRET_BLOCKED" }]
      }
    });

    const diff = await client.callTool({ name: "git_diff", arguments: { runHandle: "00000000-0000-4000-8000-000000000099" } });
    expect(diff.structuredContent).toMatchObject({
      error: { code: "E_NOT_FOUND" }
    });
  });
});
