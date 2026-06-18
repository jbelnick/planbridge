import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertDirectoryExists,
  configPath,
  effectiveExecution,
  effectiveProConsult,
  effectiveTools,
  loadConfig,
  type PlanbridgeConfig
} from "./config.js";

const execFileAsync = promisify(execFile);

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorResult = {
  ok: boolean;
  stdout: string;
  checks: DoctorCheck[];
};

export type DoctorCommand = (file: string, args: string[]) => Promise<{ stdout: string }>;

async function defaultCommand(file: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(file, args, { timeout: 5_000 });
  return { stdout };
}

function connectorUrl(config: PlanbridgeConfig): string {
  if (config.connection.kind === "public-url") {
    return `${config.connection.publicBaseUrl.replace(/\/$/, "")}/mcp`;
  }
  return `http://127.0.0.1:${config.port}/mcp`;
}

function projectRootFromModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(moduleDir) === "src" && path.basename(path.dirname(moduleDir)) === "dist") {
    return path.resolve(moduleDir, "..", "..");
  }
  if (path.basename(moduleDir) === "src") {
    return path.resolve(moduleDir, "..");
  }
  return moduleDir;
}

export function tunnelClientCommand(env: NodeJS.ProcessEnv): string {
  if (env.PLANBRIDGE_TUNNEL_CLIENT) {
    return env.PLANBRIDGE_TUNNEL_CLIENT;
  }
  const runtimeRoot = env.PLANBRIDGE_TUNNEL_RUNTIME
    ?? path.resolve(projectRootFromModule(), "..", "..", "..", "shared-runtime", "planbridge", "tunnel-client");
  return path.join(runtimeRoot, "bin", "tunnel-client");
}

async function checkCommand(name: string, file: string, args: string[], runCommand: DoctorCommand): Promise<DoctorCheck> {
  try {
    const { stdout } = await runCommand(file, args);
    return { name, ok: true, detail: stdout.trim().split(/\r?\n/)[0] || "available" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail };
  }
}

function formatChecks(checks: DoctorCheck[]): string {
  return `${checks.map((check) => `[${check.ok ? "pass" : "fail"}] ${check.name}: ${check.detail}`).join("\n")}\n`;
}

function recommendedPrompt(config: PlanbridgeConfig): string {
  const project = config.allowlist[0] ?? "<project>";
  return [
    "",
    "Recommended ChatGPT prompt:",
    `Use PlanBridge to prepare a Pro-backed plan for ${project}.`,
    "Objective: <what you want changed>. Do not execute yet.",
    "",
    "After reviewing the returned plan, say:",
    "Approved. Execute that plan.",
    "",
    "Then:",
    "Review the run and show me the diff.",
    ""
  ].join("\n");
}

export async function runDoctor(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  runCommand: DoctorCommand = defaultCommand
): Promise<DoctorResult> {
  if (argv.length > 0) {
    throw new Error("doctor does not accept arguments");
  }

  const checks: DoctorCheck[] = [];
  let config: PlanbridgeConfig;
  try {
    config = await loadConfig(env);
    checks.push({ name: "config", ok: true, detail: configPath(env) });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, stdout: formatChecks(checks), checks };
  }

  try {
    await assertDirectoryExists(config.projectsRoot, "projects root");
    checks.push({ name: "projects root", ok: true, detail: config.projectsRoot });
  } catch (error) {
    checks.push({ name: "projects root", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  for (const project of config.allowlist) {
    const projectPath = path.join(config.projectsRoot, project);
    try {
      await assertDirectoryExists(projectPath, "allowlisted project");
      checks.push({ name: `allowlist:${project}`, ok: true, detail: projectPath });
    } catch (error) {
      checks.push({ name: `allowlist:${project}`, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  checks.push({ name: "connector", ok: true, detail: connectorUrl(config) });
  checks.push({ name: "tool profile", ok: true, detail: effectiveTools(config).profile });
  checks.push(await checkCommand("ripgrep", "rg", ["--version"], runCommand));

  if (config.connection.kind === "public-url" && config.auth.accessControl?.kind === "network") {
    checks.push({
      name: "network secret hash",
      ok: Boolean(config.auth.accessControl.secretHash),
      detail: config.auth.accessControl.secretHash ? "configured" : "missing; re-run setup with --access-control network"
    });
  }

  if (config.connection.kind === "secure-tunnel") {
    checks.push(await checkCommand("tunnel-client", tunnelClientCommand(env), ["--version"], runCommand));
    checks.push({
      name: "tunnel runtime key",
      ok: Boolean(env.CONTROL_PLANE_API_KEY),
      detail: env.CONTROL_PLANE_API_KEY
        ? "CONTROL_PLANE_API_KEY present"
        : "missing CONTROL_PLANE_API_KEY; use a runtime key with Tunnels Read + Use"
    });
  }

  if (effectiveExecution(config).adapter === "codex-cli") {
    checks.push(await checkCommand("codex", "codex", ["--version"], runCommand));
    const apiKeyMode = Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY);
    checks.push({
      name: "codex subscription mode",
      ok: !apiKeyMode,
      detail: apiKeyMode ? "OPENAI_API_KEY/CODEX_API_KEY is set; codex-cli adapter will refuse execution" : "no API-key env detected"
    });
  }

  const proConsult = effectiveProConsult(config);
  checks.push({
    name: "pro consult",
    ok: true,
    detail: proConsult.enabled
      ? `enabled; oracle=${proConsult.oraclePath}; chromeProfile=${proConsult.chromeProfile}; cookieWait=${proConsult.cookieWait}`
      : "disabled"
  });
  if (proConsult.enabled) {
    checks.push(await checkCommand("oracle", proConsult.oraclePath, ["--version"], runCommand));
  }

  const ok = checks.every((check) => check.ok);
  return { ok, stdout: `${formatChecks(checks)}${recommendedPrompt(config)}`, checks };
}
