import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolContext, type ToolContext } from "../../src/tool-context.js";
import { proConsult, proConsultInputSchema, type ProConsultToolOutput } from "../../src/tools/pro-consult.js";
import type { ProConsultRunner, ProConsultRunRequest } from "../../src/adapters/pro-consult.js";
import { createFixtureProject, type FixtureProject } from "../helpers/fixtures.js";

function makeContext(fixture: FixtureProject, runner: ProConsultRunner): ToolContext {
  return createToolContext({
    home: fixture.home,
    config: {
      schemaVersion: "1.0",
      projectsRoot: fixture.projectsRoot,
      allowlist: ["alpha"],
      port: 7676,
      transport: "streamable-http",
      connection: { kind: "localhost" },
      auth: { mode: "none" },
      limits: { proConsultTimeoutMs: 123_000 },
      proConsult: { enabled: true }
    },
    proConsultRunner: runner
  });
}

function expectSuccess(result: ProConsultToolOutput): Extract<ProConsultToolOutput, { answer: string }> {
  expect(result).not.toHaveProperty("error");
  return result as Extract<ProConsultToolOutput, { answer: string }>;
}

describe("pro_consult", () => {
  it("validates input with fixed GPT-5.5 Pro browser mode semantics", () => {
    expect(
      proConsultInputSchema.parse({
        project: "alpha",
        paths: ["README.md"],
        prompt: "review",
        constraints: ["cite paths"]
      })
    ).toEqual({
      project: "alpha",
      paths: ["README.md"],
      prompt: "review",
      constraints: ["cite paths"],
      includeInternalPaths: false
    });
  });

  it("writes a sanitized context bundle and invokes the injected Pro runner", async () => {
    const fixture = await createFixtureProject("alpha");
    await writeFile(path.join(fixture.projectRoot, "allowed.txt"), "visible sk-proj-abcdef1234567890\n");
    const requests: ProConsultRunRequest[] = [];
    const runner: ProConsultRunner = async (request) => {
      requests.push(request);
      return {
        answer: "Pro found one maintainability issue.",
        model: request.model,
        mode: "browser-subscription",
        slug: request.slug,
        outputFile: request.outputFile,
        durationMs: 42,
        stdout: "",
        stderr: ""
      };
    };

    const output = expectSuccess(
      await proConsult(
        {
          project: "alpha",
          paths: ["README.md", "allowed.txt", ".env", "ignored.txt"],
          prompt: "Review these files.",
          constraints: ["Do not request local filesystem access."]
        },
        makeContext(fixture, runner)
      )
    );
    const bundle = await readFile(requests[0].contextFile, "utf8");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.5-pro",
      browserChromeProfile: "Default",
      browserCookieWait: "10s",
      timeoutMs: 123_000
    });
    expect(requests[0].prompt).toContain("ChatGPT browser subscription mode");
    expect(requests[0].prompt).not.toContain("Review these files.");
    expect(requests[0].oraclePath).toBe("oracle");
    expect(bundle).toContain("# PlanBridge Pro Consult Context");
    expect(bundle).toContain("Review these files.");
    expect(bundle).toContain("README.md");
    expect(bundle).toContain("allowed.txt");
    expect(bundle).toContain("[PLANBRIDGE_REDACTED]");
    expect(bundle).toContain(".env: E_SECRET_BLOCKED");
    expect(bundle).toContain("ignored.txt: E_GITIGNORED");
    expect(bundle).not.toContain("sk-test");
    expect(bundle).not.toContain("sk-proj-abcdef1234567890");
    expect(output).toMatchObject({
      schema_version: "1.0",
      project: "alpha",
      model: "gpt-5.5-pro",
      mode: "browser-subscription",
      answer: "Pro found one maintainability issue.",
      browser: {
        chrome_profile: "Default",
        cookie_wait: "10s",
        archive: "never"
      },
      context: {
        files: [
          expect.objectContaining({ path: "README.md" }),
          expect.objectContaining({ path: "allowed.txt" })
        ],
        omitted: [
          { path: ".env", reason: "E_SECRET_BLOCKED" },
          { path: "ignored.txt", reason: "E_GITIGNORED" }
        ],
        redactions: [{ path: "allowed.txt", reason: "content-scan" }]
      },
      run: {
        duration_ms: 42
      }
    });
    expect(JSON.stringify(output)).not.toContain(fixture.home);
  });

  it("returns local artifact paths only when explicitly requested", async () => {
    const fixture = await createFixtureProject("alpha");
    const output = expectSuccess(
      await proConsult(
        {
          project: "alpha",
          paths: ["README.md"],
          prompt: "Review.",
          includeInternalPaths: true
        },
        makeContext(fixture, async (request) => ({
          answer: "Pro answer.",
          model: request.model,
          mode: "browser-subscription",
          slug: request.slug,
          outputFile: request.outputFile,
          durationMs: 1,
          stdout: "",
          stderr: ""
        }))
      )
    );

    expect(output.context.bundle_path).toContain(path.join(fixture.home, ".planbridge", "pro-consults"));
    expect(output.run.answer_path).toContain(path.join(fixture.home, ".planbridge", "pro-consults"));
  });

  it("returns existing PlanBridge read-boundary errors without invoking Pro", async () => {
    const fixture = await createFixtureProject("alpha");
    const requests: ProConsultRunRequest[] = [];
    const result = await proConsult(
      {
        project: "alpha",
        paths: ["outside-link.txt"],
        prompt: "review"
      },
      makeContext(fixture, async (request) => {
        requests.push(request);
        throw new Error("should not run");
      })
    );

    expect(result).toEqual({
      error: {
        code: "E_PATH_TRAVERSAL",
        message: "Resolved path escapes the project root.",
        path: "outside-link.txt"
      }
    });
    expect(requests).toHaveLength(0);
  });

  it("fails closed when the operator has not enabled pro consult", async () => {
    const fixture = await createFixtureProject("alpha");
    const result = await proConsult(
      {
        project: "alpha",
        paths: ["README.md"],
        prompt: "review"
      },
      createToolContext({
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
      })
    );

    expect(result).toEqual({
      error: {
        code: "E_PRO_CONSULT_DISABLED",
        message: "Pro consult is disabled in PlanBridge config."
      }
    });
  });
});
