import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createToolContext } from "../../src/tool-context.js";
import { DEFAULT_LIMITS } from "../../src/limits.js";
import { repoReadFiles, repoReadFilesInputSchema } from "../../src/tools/repo-read-files.js";

describe("repo_read_files", () => {
  it("validates input and returns allowed files plus blocked paths", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    expect(repoReadFilesInputSchema.parse({ project: "alpha", paths: ["README.md"] })).toEqual({
      project: "alpha",
      paths: ["README.md"]
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["README.md", ".env", "ignored.txt"] }, context);

    expect("files" in result && result.files).toEqual([
      { path: "README.md", bytes: 8, truncated: false, content: "# Alpha\n" }
    ]);
    expect("blocked" in result && result.blocked).toEqual([
      { path: ".env", reason: "E_SECRET_BLOCKED" },
      { path: "ignored.txt", reason: "E_GITIGNORED" }
    ]);
    expect(result).toHaveProperty("truncated", false);
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(context.session.filesRead).toBe(1);
  });

  it("enforces per-call and per-session file limits from the central limits module", async () => {
    const fixture = await createFixtureProject("alpha");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        limits: { maxFilesPerRead: 1, maxFilesPerSession: 1 }
      },
      home: fixture.home
    });

    await expect(repoReadFiles({ project: "alpha", paths: ["README.md", "AGENTS.md"] }, context)).resolves.toEqual({
      error: {
        code: "E_SIZE_EXCEEDED",
        message: "repo_read_files exceeds maxFilesPerRead"
      }
    });

    await expect(repoReadFiles({ project: "alpha", paths: ["README.md"] }, context)).resolves.toMatchObject({
      files: [{ path: "README.md" }]
    });
    await expect(repoReadFiles({ project: "alpha", paths: ["AGENTS.md"] }, context)).resolves.toEqual({
      error: {
        code: "E_SIZE_EXCEEDED",
        message: "repo_read_files exceeds maxFilesPerSession"
      }
    });
  });

  it("allows maxFilesPerRead config overrides above the default", async () => {
    const fixture = await createFixtureProject("alpha");
    const paths: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const fileName = `file-${index}.md`;
      paths.push(fileName);
      await writeFile(path.join(fixture.projectRoot, fileName), `file ${index}\n`);
    }
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        limits: { maxFilesPerRead: 25, maxFilesPerSession: 25 }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths }, context);

    expect("files" in result && result.files).toHaveLength(21);
    expect(result).toHaveProperty("truncated", false);
  });

  it("allows maxBytesPerFile config overrides above the default", async () => {
    const fixture = await createFixtureProject("alpha");
    const content = "safe line\n".repeat(Math.ceil((DEFAULT_LIMITS.maxBytesPerFile + 100) / 10));
    await writeFile(path.join(fixture.projectRoot, "large.md"), content);
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" },
        limits: { maxBytesPerFile: DEFAULT_LIMITS.maxBytesPerFile + 1024 }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["large.md"] }, context);

    expect("files" in result && result.files[0]).toMatchObject({
      path: "large.md",
      bytes: content.length,
      truncated: false,
      content
    });
    expect(result).toHaveProperty("truncated", false);
  });

  it("blocks nested directories ignored by a root .gitignore directory pattern", async () => {
    const fixture = await createFixtureProject("alpha");
    await mkdir(path.join(fixture.projectRoot, "src", "build"), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, "src", "build", "output.js"), "ignored nested content\n");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["src/build/output.js"] }, context);

    expect(result).toMatchObject({
      files: [],
      blocked: [{ path: "src/build/output.js", reason: "E_GITIGNORED" }]
    });
    expect(JSON.stringify(result)).not.toContain("ignored nested content");
  });

  it("blocks slashless .gitignore directory patterns such as node_modules", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, ".gitignore"), "node_modules\n");
    await mkdir(path.join(fixture.projectRoot, "src", "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, "src", "node_modules", "pkg", "index.js"), "ignored package content\n");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["src/node_modules/pkg/index.js"] }, context);

    expect(result).toMatchObject({
      files: [],
      blocked: [{ path: "src/node_modules/pkg/index.js", reason: "E_GITIGNORED" }]
    });
    expect(JSON.stringify(result)).not.toContain("ignored package content");
  });

  it("blocks a read that resolves into ~/.planbridge", async () => {
    const fixture = await createFixtureProject("alpha");
    const planbridgeHome = path.join(fixture.home, ".planbridge");
    await mkdir(planbridgeHome, { recursive: true });
    await writeFile(path.join(planbridgeHome, "config.json"), "{\"secret\":\"sk-test\"}\n");
    await symlink(path.join(planbridgeHome, "config.json"), path.join(fixture.projectRoot, "planbridge-config.json"));
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["planbridge-config.json"] }, context);

    expect(result).toEqual({
      error: {
        code: "E_PATH_TRAVERSAL",
        message: "Resolved path escapes the project root.",
        path: "planbridge-config.json"
      }
    });
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("blocks a benign-named symlink that resolves to a secret file inside the project", async () => {
    const fixture = await createFixtureProject("alpha");
    await symlink(path.join(fixture.projectRoot, ".env"), path.join(fixture.projectRoot, "notes.txt"));
    await symlink(path.join(fixture.projectRoot, ".git", "config"), path.join(fixture.projectRoot, "history.txt"));
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["notes.txt", "history.txt"] }, context);

    expect(result).toMatchObject({
      files: [],
      blocked: [
        { path: "notes.txt", reason: "E_SECRET_BLOCKED" },
        { path: "history.txt", reason: "E_SECRET_BLOCKED" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(JSON.stringify(result)).not.toContain("secret history");
  });

  it("blocks a multi-segment anchored .gitignore file pattern, directly and via symlink", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, ".gitignore"), "vendor/cache.dat\n");
    await mkdir(path.join(fixture.projectRoot, "vendor"), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, "vendor", "cache.dat"), "BUILD_TOKEN=hunter2plaintext\n");
    await symlink(path.join(fixture.projectRoot, "vendor", "cache.dat"), path.join(fixture.projectRoot, "doc.txt"));
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    const result = await repoReadFiles({ project: "alpha", paths: ["vendor/cache.dat", "doc.txt"] }, context);

    expect(result).toMatchObject({
      files: [],
      blocked: [
        { path: "vendor/cache.dat", reason: "E_GITIGNORED" },
        { path: "doc.txt", reason: "E_GITIGNORED" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("hunter2plaintext");
  });

  it("writes metadata-only audit JSONL entries for reads, blocks, and redactions", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, "allowed.txt"), "visible sk-proj-abcdef1234567890\n");
    const context = createToolContext({
      config: {
        schemaVersion: "1.0",
        projectsRoot: fixture.projectsRoot,
        allowlist: ["alpha"],
        port: 7676,
        transport: "streamable-http",
        connection: { kind: "localhost" },
        auth: { mode: "none" }
      },
      home: fixture.home
    });

    await repoReadFiles({ project: "alpha", paths: ["allowed.txt", ".env"] }, context);
    const entries = (await readFile(path.join(fixture.home, ".planbridge", "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; path?: string; blockReason?: string });

    expect(entries.map((entry) => entry.event)).toEqual(expect.arrayContaining(["read", "blocked", "redact"]));
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "blocked", path: ".env", blockReason: "E_SECRET_BLOCKED" }),
        expect.objectContaining({ event: "redact", path: "allowed.txt" }),
        expect.objectContaining({ event: "read", path: "allowed.txt" })
      ])
    );
    expect(JSON.stringify(entries)).not.toContain("sk-proj");
    expect(JSON.stringify(entries)).not.toContain("abcdef1234567890");
  });
});
