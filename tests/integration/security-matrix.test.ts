import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createToolContext } from "../../src/tool-context.js";
import { repoReadFiles } from "../../src/tools/repo-read-files.js";
import { contextPack } from "../../src/tools/context-pack.js";
import { runSetup } from "../../src/cli.js";
import { startPlanbridgeServer } from "../../src/server.js";

describe("M5 section 9.4 threat-model security matrix", () => {
  it("row 1: secret path reads are blocked with no content", async () => {
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
        auth: { mode: "none" }
      }
    });

    const result = await repoReadFiles({ project: "alpha", paths: [".env", ".git/config"] }, context);

    expect(result).toMatchObject({
      files: [],
      blocked: [
        { path: ".env", reason: "E_SECRET_BLOCKED" },
        { path: ".git/config", reason: "E_SECRET_BLOCKED" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("row 2: per-session read cap is enforced across repo_read_files and context_pack", async () => {
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
        limits: { maxFilesPerSession: 2 }
      }
    });

    await expect(repoReadFiles({ project: "alpha", paths: ["README.md"] }, context)).resolves.toMatchObject({
      files: [{ path: "README.md" }]
    });
    await expect(contextPack({ project: "alpha", paths: ["AGENTS.md"] }, context)).resolves.toMatchObject({
      files: [{ path: "AGENTS.md" }]
    });
    await expect(repoReadFiles({ project: "alpha", paths: ["src.txt"] }, context)).resolves.toMatchObject({
      error: { code: "E_SIZE_EXCEEDED" }
    });
    expect(context.session.filesRead).toBe(2);
    const auditEntries = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; filesTouched?: number; blockReason?: string; tool?: string });
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "read", tool: "repo_read_files", filesTouched: 1 }),
        expect.objectContaining({ event: "read", tool: "context_pack", filesTouched: 2 }),
        expect.objectContaining({ event: "blocked", tool: "repo_read_files", blockReason: "E_SIZE_EXCEEDED", filesTouched: 2 })
      ])
    );
  });

  it("row 3: public endpoint hardening is indexed to dedicated M5 coverage", async () => {
    // Row 3 is covered by AC-M5-04..16:
    // self-probe classification/debounce/gate, OAuth fail-closed, network secret,
    // constant-time compare, Authorization redaction, rate-limit, HTTPS backstop,
    // localhost bind, and public-url network-only auth. Secure Tunnel is moot by
    // construction for the self-probe because it is not a public-url fallback.
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

    const running = await startPlanbridgeServer({
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

    try {
      expect(running.host).toBe("127.0.0.1");
    } finally {
      await running.close();
    }
  });
});
