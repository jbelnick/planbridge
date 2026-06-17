import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFixtureProject } from "../helpers/fixtures.js";
import { createAuditLogger } from "../../src/security/audit-log.js";
import {
  classifyBlockedPath,
  redactContent,
  readAllowedTextFile
} from "../../src/security/redaction.js";
import { resolveProject } from "../../src/security/paths.js";

describe("security/redaction", () => {
  it("blocks .git and secret path classes without content", async () => {
    const fixture = await createFixtureProject("alpha");

    expect(classifyBlockedPath(".git/config")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });
    expect(classifyBlockedPath(".env")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });
    expect(classifyBlockedPath("id_rsa")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });
    expect(classifyBlockedPath(".ssh/config")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });
    expect(classifyBlockedPath("Library/Keychains/login.keychain-db")).toEqual({
      blocked: true,
      reason: "E_SECRET_BLOCKED"
    });
    expect(classifyBlockedPath(".npmrc")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });
    expect(classifyBlockedPath(".netrc")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });
    expect(classifyBlockedPath("deploy/secrets.yaml")).toEqual({ blocked: true, reason: "E_SECRET_BLOCKED" });

    const audit = createAuditLogger(path.join(fixture.home, ".planbridge", "audit.log"));
    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha"
    });

    const blocked = await readAllowedTextFile({
      project,
      relativePath: ".env",
      maxBytesPerFile: 1024,
      audit,
      sessionId: "s1"
    });

    expect(blocked).toEqual({ blocked: { path: ".env", reason: "E_SECRET_BLOCKED" } });
    expect(JSON.stringify(blocked)).not.toContain("sk-test");
  });

  it("blocks gitignored paths without content", async () => {
    const fixture = await createFixtureProject("alpha");
    const audit = createAuditLogger(path.join(fixture.home, ".planbridge", "audit.log"));
    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha"
    });

    const blocked = await readAllowedTextFile({
      project,
      relativePath: "ignored.txt",
      maxBytesPerFile: 1024,
      audit,
      sessionId: "s1"
    });

    expect(blocked).toEqual({ blocked: { path: "ignored.txt", reason: "E_GITIGNORED" } });
    expect(JSON.stringify(blocked)).not.toContain("ignored content");
  });

  it("redacts high entropy strings and known prefixes and logs each hit", async () => {
    const fixture = await createFixtureProject("alpha");
    const auditPath = path.join(fixture.home, ".planbridge", "audit.log");
    const audit = createAuditLogger(auditPath);

    const redacted = await redactContent({
      content:
        "-----BEGIN PRIVATE KEY-----\nAKIAABCDEFGHIJKLMNOP\nghp_abcdefghijklmnopqrstuvwxyz123456\nsk-proj-abcdef1234567890\nxoxb-1234567890-abcdef\nthisIsAHighEntropySecretValue1234567890",
      path: "README.md",
      audit,
      sessionId: "s1",
      tool: "repo_read_files",
      project: "alpha"
    });

    expect(redacted.content).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(redacted.content).toContain("[PLANBRIDGE_REDACTED]");
    expect(redacted.redactions.length).toBeGreaterThanOrEqual(5);
  });

  it("returns truncated allowed content at maxBytesPerFile", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, "big.txt"), "abcdef");
    const project = await resolveProject({
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      project: "alpha"
    });
    const audit = createAuditLogger(path.join(fixture.home, ".planbridge", "audit.log"));

    const result = await readAllowedTextFile({
      project,
      relativePath: "big.txt",
      maxBytesPerFile: 3,
      audit,
      sessionId: "s1"
    });

    expect(result).toMatchObject({
      file: { path: "big.txt", bytes: 3, truncated: true, content: "abc" }
    });
  });
});
