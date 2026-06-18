#!/usr/bin/env node
import path from "node:path";
import type { RunningPlanbridgeServer } from "./server.js";
import {
  assertDirectoryExists,
  writeConfig,
  type PlanbridgeConfig
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { generateAccessSecret, hashAccessSecret } from "./security/access-secret.js";

const OAUTH_RUNTIME_NOT_IMPLEMENTED =
  "OAuth runtime is not implemented in this build; use --access-control network or the Secure MCP Tunnel.";

export type SetupResult = {
  stdout: string;
  configPath: string;
};

export type ServeResult = {
  stdout: string;
  server: RunningPlanbridgeServer;
};

type SetupArgs = {
  projectsRoot?: string;
  allowlist?: string[];
  port: number;
  tunnelId?: string;
  publicBaseUrl?: string;
  localhost: boolean;
  accessControl?: "network" | "oauth";
  executionAdapter?: "handoff-file" | "codex-cli";
  worktreeRoot?: string;
  codexTimeoutMs?: number;
  branchPrefix?: string;
  enableProConsult: boolean;
  proConsultOraclePath?: string;
  proConsultChromeProfile?: string;
  proConsultCookieWait?: string;
  advancedTools: boolean;
};

function readOption(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return parsed;
}

function parseSetupArgs(argv: string[]): SetupArgs {
  if (argv[0] !== "setup") {
    throw new Error("expected command: setup");
  }

  const portText = readOption(argv, "--port") ?? "7676";
  const port = parseNonNegativeInt(portText, "port");

  const allowlistText = readOption(argv, "--allowlist");
  const accessControl = readOption(argv, "--access-control");
  if (accessControl !== undefined && accessControl !== "network" && accessControl !== "oauth") {
    throw new Error(`unsupported access control: ${accessControl}`);
  }
  const executionAdapter = readOption(argv, "--execution-adapter");
  if (executionAdapter !== undefined && executionAdapter !== "handoff-file" && executionAdapter !== "codex-cli") {
    throw new Error(`unsupported execution adapter: ${executionAdapter}`);
  }
  const codexTimeoutText = readOption(argv, "--codex-timeout-ms");

  return {
    projectsRoot: readOption(argv, "--projects-root"),
    allowlist: allowlistText
      ?.split(",")
      .map((project) => project.trim())
      .filter(Boolean),
    port,
    tunnelId: readOption(argv, "--tunnel-id"),
    publicBaseUrl: readOption(argv, "--public-base-url"),
    localhost: hasFlag(argv, "--localhost"),
    accessControl,
    executionAdapter,
    worktreeRoot: readOption(argv, "--worktree-root"),
    codexTimeoutMs: codexTimeoutText ? parsePositiveInt(codexTimeoutText, "codex timeout") : undefined,
    branchPrefix: readOption(argv, "--branch-prefix"),
    enableProConsult: hasFlag(argv, "--enable-pro-consult"),
    proConsultOraclePath: readOption(argv, "--pro-consult-oracle-path"),
    proConsultChromeProfile: readOption(argv, "--pro-consult-chrome-profile"),
    proConsultCookieWait: readOption(argv, "--pro-consult-cookie-wait"),
    advancedTools: hasFlag(argv, "--advanced-tools")
  };
}

function normalizePublicBaseUrl(urlText: string): string {
  const url = new URL(urlText);
  if (url.protocol !== "https:") {
    throw new Error("public base URL must use HTTPS");
  }
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function connectorUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/mcp`;
}

async function assertAllowlist(projectsRoot: string, allowlist: string[]): Promise<void> {
  for (const project of allowlist) {
    if (project === "." || project === ".." || project.includes("/") || project.includes("\\")) {
      throw new Error("allowlist entries must be project directory names");
    }
    await assertDirectoryExists(path.join(projectsRoot, project), "allowlisted project");
  }
}

export async function runSetup(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupResult> {
  const args = parseSetupArgs(argv);
  if (!args.projectsRoot) {
    throw new Error("missing --projects-root");
  }
  if (!args.allowlist || args.allowlist.length === 0) {
    throw new Error("missing --allowlist");
  }

  const connectionModes = [args.tunnelId, args.publicBaseUrl, args.localhost ? "localhost" : undefined].filter(Boolean);
  if (connectionModes.length !== 1) {
    throw new Error("configure exactly one connection: --tunnel-id, --public-base-url, or --localhost");
  }

  await assertDirectoryExists(args.projectsRoot, "projects root");
  await assertAllowlist(args.projectsRoot, args.allowlist);

  let connection: PlanbridgeConfig["connection"];
  let stdout: string;
  let accessSecret: string | undefined;
  if (args.tunnelId) {
    connection = { kind: "secure-tunnel", tunnelId: args.tunnelId };
    stdout = `Tunnel ID: ${args.tunnelId}\n`;
  } else if (args.publicBaseUrl) {
    const publicBaseUrl = normalizePublicBaseUrl(args.publicBaseUrl);
    if (!args.accessControl) {
      throw new Error("public connector URL requires access control");
    }
    if (args.accessControl === "oauth") {
      throw new Error(OAUTH_RUNTIME_NOT_IMPLEMENTED);
    }
    connection = { kind: "public-url", publicBaseUrl };
    stdout = `Connector URL: ${connectorUrl(publicBaseUrl)}\n`;
  } else {
    connection = { kind: "localhost" };
    stdout = `Connector URL: ${connectorUrl(`http://127.0.0.1:${args.port}`)}\n`;
  }
  if (args.accessControl === "network") {
    accessSecret = generateAccessSecret();
    stdout += `Access secret: ${accessSecret}\nInstall this bearer secret at the tunnel boundary; PlanBridge stores only its hash.\n`;
  }
  const execution = {
    adapter: args.executionAdapter ?? "handoff-file",
    ...(args.worktreeRoot ? { worktreeRoot: args.worktreeRoot } : {}),
    ...(args.codexTimeoutMs ? { timeoutMs: args.codexTimeoutMs } : {}),
    ...(args.branchPrefix ? { branchPrefix: args.branchPrefix } : {})
  } satisfies NonNullable<PlanbridgeConfig["execution"]>;
  stdout += `Execution adapter: ${execution.adapter}\n`;
  if (execution.adapter === "codex-cli") {
    stdout += "Codex execution runs in an isolated worktree and refuses API-key mode.\n";
  }
  const tools = { profile: args.advancedTools ? "advanced" : "guided" } satisfies NonNullable<PlanbridgeConfig["tools"]>;
  stdout += `Tool profile: ${tools.profile}\n`;
  if (args.enableProConsult) {
    stdout += `Pro consult: enabled via ChatGPT browser subscription mode (${args.proConsultChromeProfile ?? "Default"} Chrome profile).\n`;
  } else {
    stdout += "Pro consult: disabled.\n";
  }

  const config: PlanbridgeConfig = {
    schemaVersion: "1.0",
    projectsRoot: args.projectsRoot,
    allowlist: args.allowlist,
    port: args.port,
    transport: "streamable-http",
    connection,
    auth:
      args.accessControl === "oauth"
        ? { mode: "oauth" }
        : args.accessControl === "network"
          ? { mode: "none", accessControl: { kind: "network", configured: true, secretHash: hashAccessSecret(accessSecret ?? "") } }
          : { mode: "none" },
    execution,
    tools,
    ...(args.enableProConsult
      ? {
          proConsult: {
            enabled: true,
            ...(args.proConsultOraclePath ? { oraclePath: args.proConsultOraclePath } : {}),
            ...(args.proConsultChromeProfile ? { chromeProfile: args.proConsultChromeProfile } : {}),
            ...(args.proConsultCookieWait ? { cookieWait: args.proConsultCookieWait } : {})
          }
        }
      : {})
  };

  return {
    stdout,
    configPath: await writeConfig(config, env)
  };
}

export async function runServe(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<ServeResult> {
  if (argv.length > 0) {
    throw new Error("serve does not accept arguments");
  }
  const { startPlanbridgeServer } = await import("./server.js");
  const server = await startPlanbridgeServer(env.HOME ? { home: env.HOME } : {});
  return {
    stdout: `PlanBridge MCP server listening on ${server.url}/mcp\n`,
    server
  };
}

function usage(): string {
  return `Usage:
  planbridge setup --projects-root <path> --allowlist <name[,name...]> (--tunnel-id <id> | --public-base-url <https-url> --access-control network | --localhost) [--execution-adapter handoff-file|codex-cli] [--enable-pro-consult] [--advanced-tools]
  planbridge serve
  planbridge doctor
`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "setup") {
    const result = await runSetup([command, ...args]);
    process.stdout.write(result.stdout);
    return;
  }
  if (command === "serve" || command === "start") {
    const result = await runServe(args);
    process.stdout.write(result.stdout);
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor(args);
    process.stdout.write(result.stdout);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(command ? `unknown command: ${command}\n${usage()}` : usage());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
