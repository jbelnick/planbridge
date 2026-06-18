import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOracleProConsultArgv,
  createOracleProConsultRunner,
  type OracleExecFile,
  type ProConsultRunRequest
} from "../../src/adapters/pro-consult.js";

function request(overrides: Partial<ProConsultRunRequest> = {}): ProConsultRunRequest {
  return {
    prompt: "review the attached context",
    contextFile: "/tmp/context.md",
    outputFile: "/tmp/answer.md",
    slug: "planbridge-pro-consult-test",
    oraclePath: "oracle",
    timeoutMs: 120_000,
    model: "gpt-5.5-pro",
    browserChromeProfile: "Default",
    browserCookieWait: "10s",
    cwd: "/tmp",
    env: { PATH: "/bin", HOME: "/tmp/home", OPENAI_API_KEY: "sk-proj-secret" },
    ...overrides
  };
}

describe("Oracle Pro consult adapter", () => {
  it("builds a fixed browser-subscription argv without API mode switches", () => {
    expect(buildOracleProConsultArgv(request())).toEqual([
      "--engine",
      "browser",
      "--model",
      "gpt-5.5-pro",
      "--browser-chrome-profile",
      "Default",
      "--browser-cookie-wait",
      "10s",
      "--browser-archive",
      "never",
      "--browser-timeout",
      "120s",
      "--timeout",
      "180s",
      "--browser-attachments",
      "auto",
      "--no-notify",
      "--force",
      "--slug",
      "planbridge-pro-consult-test",
      "--write-output",
      "/tmp/answer.md",
      "--prompt",
      "review the attached context",
      "--file",
      "/tmp/context.md"
    ]);
  });

  it("uses a sanitized child environment and reads the final answer file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "planbridge-pro-adapter-"));
    const outputFile = path.join(dir, "answer.md");
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const execFile: OracleExecFile = async (file, args, options) => {
      calls.push({ file, args, env: options.env ?? {} });
      await writeFile(outputFile, "Pro answer\n", "utf8");
      return { stdout: "stdout", stderr: "" };
    };
    const result = await createOracleProConsultRunner({ execFile })(
      request({ contextFile: path.join(dir, "context.md"), outputFile, cwd: dir })
    );

    expect(result).toMatchObject({
      answer: "Pro answer",
      model: "gpt-5.5-pro",
      mode: "browser-subscription",
      slug: "planbridge-pro-consult-test"
    });
    expect(calls[0]).toMatchObject({ file: "oracle" });
    expect(calls[0].env).toMatchObject({ PATH: "/bin", HOME: "/tmp/home" });
    expect(calls[0].env).not.toHaveProperty("OPENAI_API_KEY");
    expect(await readFile(outputFile, "utf8")).toBe("Pro answer\n");
  });
});
