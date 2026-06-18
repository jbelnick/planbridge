import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { ConfigSchema } from "../../src/config.js";
import { runServe, runSetup } from "../../src/cli.js";

const OAUTH_NOT_IMPLEMENTED = "OAuth runtime is not implemented in this build; use --access-control network or the Secure MCP Tunnel.";

async function readConfig(home: string) {
  const configPath = path.join(home, ".planbridge", "config.json");
  return ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

describe("planbridge setup", () => {
  it("validates projects root exists and writes schema-valid config", async () => {
    const fixture = await createFixtureProject("alpha");

    const result = await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef"
    ], { HOME: fixture.home });

    const config = await readConfig(fixture.home);
    expect(config.projectsRoot).toBe(fixture.projectsRoot);
    expect(config.allowlist).toEqual(["alpha"]);
    expect(config.connection).toEqual({ kind: "secure-tunnel", tunnelId: "tunnel_0123456789abcdef0123456789abcdef" });
    expect(config.execution.adapter).toBe("handoff-file");
    expect(result.stdout).toContain("Tunnel ID: tunnel_0123456789abcdef0123456789abcdef");
    expect(result.stdout).toContain("Execution adapter: handoff-file");
  });

  it("rejects malformed Secure MCP Tunnel ids", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        fixture.projectsRoot,
        "--allowlist",
        "alpha",
        "--tunnel-id",
        "tnl_123"
      ], { HOME: fixture.home })
    ).rejects.toThrow("tunnel id must match");
  });

  it("can wire setup directly to the codex-cli execution adapter", async () => {
    const fixture = await createFixtureProject("alpha");
    const worktreeRoot = path.join(fixture.home, "planbridge-worktrees");

    const result = await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef",
      "--execution-adapter",
      "codex-cli",
      "--worktree-root",
      worktreeRoot,
      "--codex-timeout-ms",
      "120000",
      "--branch-prefix",
      "pb/"
    ], { HOME: fixture.home });

    await expect(readConfig(fixture.home)).resolves.toMatchObject({
      execution: {
        adapter: "codex-cli",
        worktreeRoot,
        timeoutMs: 120000,
        branchPrefix: "pb/"
      }
    });
    expect(result.stdout).toContain("Execution adapter: codex-cli");
    expect(result.stdout).toContain("refuses API-key mode");
  });

  it("can explicitly enable the browser-subscription Pro consult bridge", async () => {
    const fixture = await createFixtureProject("alpha");

    const result = await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--localhost",
      "--enable-pro-consult",
      "--pro-consult-oracle-path",
      "/usr/local/bin/oracle",
      "--pro-consult-chrome-profile",
      "Default",
      "--pro-consult-cookie-wait",
      "10s"
    ], { HOME: fixture.home });

    await expect(readConfig(fixture.home)).resolves.toMatchObject({
      proConsult: {
        enabled: true,
        oraclePath: "/usr/local/bin/oracle",
        chromeProfile: "Default",
        cookieWait: "10s"
      }
    });
    expect(result.stdout).toContain("Pro consult: enabled via ChatGPT browser subscription mode");
  });

  it("rejects a missing projects root", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        path.join(fixture.home, "missing"),
        "--allowlist",
        "alpha",
        "--tunnel-id",
        "tunnel_0123456789abcdef0123456789abcdef"
      ], { HOME: fixture.home })
    ).rejects.toThrow("projects root does not exist");
  });

  it("defaults port to 7676 and accepts an override", async () => {
    const fixture = await createFixtureProject("alpha");

    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef"
    ], { HOME: fixture.home });
    await expect(readConfig(fixture.home)).resolves.toMatchObject({ port: 7676 });

    const other = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      other.projectsRoot,
      "--allowlist",
      "alpha",
      "--port",
      "8888",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef"
    ], { HOME: other.home });
    await expect(readConfig(other.home)).resolves.toMatchObject({ port: 8888 });
  });

  it("accepts HTTPS public URLs and rejects non-HTTPS public URLs", async () => {
    const fixture = await createFixtureProject("alpha");

    const result = await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--public-base-url",
      "https://planbridge.example.test",
      "--access-control",
      "network"
    ], { HOME: fixture.home });

    await expect(readConfig(fixture.home)).resolves.toMatchObject({
      connection: { kind: "public-url", publicBaseUrl: "https://planbridge.example.test" },
      auth: {
        mode: "none",
        accessControl: {
          kind: "network",
          configured: true,
          secretHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      }
    });
    expect(result.stdout).toContain("https://planbridge.example.test/mcp");
    const secrets = result.stdout.match(/\b[a-f0-9]{64}\b/g) ?? [];
    expect(secrets).toHaveLength(1);
    expect(await readFile(path.join(fixture.home, ".planbridge", "config.json"), "utf8")).not.toContain(secrets[0]);

    const other = await createFixtureProject("alpha");
    await expect(
      runSetup([
        "setup",
        "--projects-root",
        other.projectsRoot,
        "--allowlist",
        "alpha",
        "--public-base-url",
        "http://planbridge.example.test",
        "--access-control",
        "network"
      ], { HOME: other.home })
    ).rejects.toThrow("public base URL must use HTTPS");
  });

  it("fails closed for public URLs without access control but allows localhost tokenless mode", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        fixture.projectsRoot,
        "--allowlist",
        "alpha",
        "--public-base-url",
        "https://planbridge.example.test"
      ], { HOME: fixture.home })
    ).rejects.toThrow("public connector URL requires access control");

    const local = await createFixtureProject("alpha");
    const result = await runSetup([
      "setup",
      "--projects-root",
      local.projectsRoot,
      "--allowlist",
      "alpha",
      "--localhost"
    ], { HOME: local.home });

    await expect(readConfig(local.home)).resolves.toMatchObject({
      connection: { kind: "localhost" },
      auth: { mode: "none" }
    });
    expect(result.stdout).toContain("http://127.0.0.1:7676/mcp");
  });

  it("fails closed for oauth on public URLs with the frozen runtime-not-implemented message", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        fixture.projectsRoot,
        "--allowlist",
        "alpha",
        "--public-base-url",
        "https://planbridge.example.test/mcp",
        "--access-control",
        "oauth"
      ], { HOME: fixture.home })
    ).rejects.toThrow(OAUTH_NOT_IMPLEMENTED);
  });

  it("rejects allowlisted projects that do not exist under the projects root", async () => {
    const fixture = await createFixtureProject("alpha");
    await mkdir(path.join(fixture.projectsRoot, "beta"), { recursive: true });

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        fixture.projectsRoot,
        "--allowlist",
        "alpha,gamma",
        "--tunnel-id",
        "tunnel_0123456789abcdef0123456789abcdef"
      ], { HOME: fixture.home })
    ).rejects.toThrow("allowlisted project does not exist");
  });

  it("rejects allowlist entries that are not relative project directory names", async () => {
    const fixture = await createFixtureProject("alpha");

    await expect(
      runSetup([
        "setup",
        "--projects-root",
        fixture.projectsRoot,
        "--allowlist",
        "../outside",
        "--tunnel-id",
        "tunnel_0123456789abcdef0123456789abcdef"
      ], { HOME: fixture.home })
    ).rejects.toThrow("allowlist entries must be project directory names");
  });

  it("serve starts the configured local MCP server through the CLI surface", async () => {
    const fixture = await createFixtureProject("alpha");
    await runSetup([
      "setup",
      "--projects-root",
      fixture.projectsRoot,
      "--allowlist",
      "alpha",
      "--port",
      "0",
      "--localhost"
    ], { HOME: fixture.home });

    const result = await runServe([], { HOME: fixture.home });
    try {
      expect(result.stdout).toBe(`PlanBridge MCP server listening on ${result.server.url}/mcp\n`);
      expect(result.server.host).toBe("127.0.0.1");
    } finally {
      await result.server.close();
    }
  });
});
