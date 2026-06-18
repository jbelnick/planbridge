import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { PlanbridgeError } from "../errors.js";

export type ProConsultModel = "gpt-5.5-pro";

export type ProConsultRunRequest = {
  prompt: string;
  contextFile: string;
  outputFile: string;
  slug: string;
  oraclePath: string;
  timeoutMs: number;
  model: ProConsultModel;
  browserChromeProfile: string;
  browserCookieWait: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type ProConsultRunResult = {
  answer: string;
  model: ProConsultModel;
  mode: "browser-subscription";
  slug: string;
  outputFile: string;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type ProConsultRunner = (request: ProConsultRunRequest) => Promise<ProConsultRunResult>;

export type OracleExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

type ExecFailure = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

const CHILD_ENV_ALLOWLIST = new Set(["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TERM", "TMPDIR"]);

function defaultExecFile(file: string, args: string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ExecFailure;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CHILD_ENV_ALLOWLIST.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

export function buildOracleProConsultArgv(input: ProConsultRunRequest): string[] {
  return [
    "--engine",
    "browser",
    "--model",
    input.model,
    "--browser-chrome-profile",
    input.browserChromeProfile,
    "--browser-cookie-wait",
    input.browserCookieWait,
    "--browser-archive",
    "never",
    "--browser-timeout",
    seconds(input.timeoutMs),
    "--timeout",
    seconds(input.timeoutMs + 60_000),
    "--browser-attachments",
    "auto",
    "--no-notify",
    "--force",
    "--slug",
    input.slug,
    "--write-output",
    input.outputFile,
    "--prompt",
    input.prompt,
    "--file",
    input.contextFile
  ];
}

export function createOracleProConsultRunner(input: { execFile?: OracleExecFile } = {}): ProConsultRunner {
  const run = input.execFile ?? defaultExecFile;
  return async (request) => {
    const started = Date.now();
    const argv = buildOracleProConsultArgv(request);
    try {
      const { stdout, stderr } = await run(request.oraclePath, argv, {
        cwd: request.cwd,
        env: sanitizeEnv(request.env),
        encoding: "utf8",
        timeout: request.timeoutMs + 90_000,
        maxBuffer: 4 * 1024 * 1024
      });
      const answer = (await readFile(request.outputFile, "utf8")).trimEnd();
      if (!answer.trim()) {
        throw new PlanbridgeError("E_PRO_CONSULT_FAILED", "Oracle browser consult produced an empty answer.");
      }
      await chmod(request.outputFile, 0o600);
      return {
        answer,
        model: request.model,
        mode: "browser-subscription",
        slug: request.slug,
        outputFile: request.outputFile,
        durationMs: Date.now() - started,
        stdout,
        stderr
      };
    } catch (error) {
      if (error instanceof PlanbridgeError) {
        throw error;
      }
      const failure = error as ExecFailure;
      const detail = failure.killed ? "Oracle browser consult timed out." : "Oracle browser consult failed.";
      const status = [failure.code !== undefined ? `code=${failure.code}` : "", failure.signal ? `signal=${failure.signal}` : ""]
        .filter(Boolean)
        .join(" ");
      throw new PlanbridgeError(
        "E_PRO_CONSULT_FAILED",
        [detail, status].filter(Boolean).join(" ")
      );
    }
  };
}
