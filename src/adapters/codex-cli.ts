import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { effectiveExecution, effectiveLimits, planbridgeHome, type PlanbridgeConfig } from "../config.js";
import { PlanbridgeError } from "../errors.js";
import { gitCommitSha, gitStatus, resolveAllowedProject } from "../project-index.js";
import { codexMode, type CodexAdapter, type CodexAdapterStatus, type CodexHandoff, type CodexMode } from "./codex-adapter.js";
import { renderHandoffArtifact } from "./handoff-file.js";

const execFileAsync = promisify(execFile);

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type CodexRunResult = {
  exitCode: number | null;
  timedOut?: boolean;
  pid?: number;
};

export type CodexRunRequest = {
  argv: string[];
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
  resultFile: string;
  eventsFile: string;
  signal: AbortSignal;
  onPid?: (pid: number) => void;
};

export type CodexRunner = (request: CodexRunRequest) => Promise<CodexRunResult>;

export type CreateCodexCliAdapterInput = {
  home: string;
  config: PlanbridgeConfig;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  run?: CodexRunner;
  git?: GitExec;
  now?: () => Date;
  randomId?: () => string;
  timeoutMs?: number;
};

type RunState = "queued" | "running" | "completed" | "failed";

type RunRecord = {
  id: string;
  project: string;
  worktreePath: string;
  branch: string;
  resultFile: string;
  eventsFile: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  pid?: number;
  mode: CodexMode;
  baseSha?: string;
  detail?: string;
};

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_ENV_ALLOWLIST = new Set(["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TERM", "TMPDIR", "CODEX_HOME"]);

type CodexCliStartResult = {
  handle: string;
  artifactPath: string;
  worktreePath: string;
};

export type CodexCliAdapter = Omit<CodexAdapter, "start"> & {
  start(handoff: CodexHandoff): Promise<CodexCliStartResult>;
};

export type RunDiffTarget = {
  project: string;
  worktreePath: string;
  branch: string;
  baseSha?: string;
};

export function buildCodexArgv(input: { worktreePath: string; resultFile: string }): string[] {
  return [
    "exec",
    "-c",
    'approval_policy="never"',
    "--cd",
    input.worktreePath,
    "--sandbox",
    "workspace-write",
    "--json",
    "-o",
    input.resultFile,
    "-"
  ];
}

export function runRecordPath(home: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new PlanbridgeError("E_HANDOFF_INCOMPLETE", "Invalid codex run handle.");
  }
  return path.join(planbridgeHome({ HOME: home }), "runs", runId, "run.json");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CHILD_ENV_ALLOWLIST.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

async function writePrivateFile(filePath: string, content: string, flag: "w" | "wx" = "w"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag });
  await chmod(filePath, 0o600);
}

async function readRunRecord(home: string, runId: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await readFile(runRecordPath(home, runId), "utf8")) as RunRecord;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readRunDiffTarget(home: string, runHandle: string): Promise<RunDiffTarget | null> {
  const record = await readRunRecord(home, runHandle);
  if (!record) {
    return null;
  }
  return {
    project: record.project,
    worktreePath: record.worktreePath,
    branch: record.branch,
    ...(record.baseSha ? { baseSha: record.baseSha } : {})
  };
}

async function writeRunRecord(home: string, record: RunRecord): Promise<void> {
  await writePrivateFile(runRecordPath(home, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type TerminalEvent = { kind: "completed" } | { kind: "failed"; detail?: string };

async function terminalEvent(eventsFile: string): Promise<TerminalEvent | null> {
  if (!(await pathExists(eventsFile))) {
    return null;
  }
  const lines = (await readFile(eventsFile, "utf8")).split(/\r?\n/).filter(Boolean);
  let terminal: TerminalEvent | null = null;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event.type ?? event.event ?? "");
    if (type === "turn.completed") {
      terminal = { kind: "completed" };
    }
    if (type === "turn.failed" || type === "error") {
      terminal = { kind: "failed", detail: "Codex run failed." };
    }
  }
  return terminal;
}

async function hasLastMessage(resultFile: string): Promise<boolean> {
  if (!(await pathExists(resultFile))) {
    return false;
  }
  return (await readFile(resultFile, "utf8")).trim().length > 0;
}

async function mapRecordStatus(home: string, record: RunRecord): Promise<CodexAdapterStatus> {
  if (record.detail === "timed out") {
    return { state: "failed", detail: "timed out" };
  }
  const terminal = await terminalEvent(record.eventsFile);
  if (record.state === "running" && record.pid && !isPidAlive(record.pid)) {
    let reconciled: RunRecord = {
      ...record,
      state: "failed",
      finishedAt: record.finishedAt ?? new Date().toISOString(),
      detail: "orphaned"
    };
    if (terminal?.kind === "failed") {
      reconciled = { ...reconciled, detail: "Codex run failed." };
    }
    if (terminal?.kind === "completed" && (await hasLastMessage(record.resultFile))) {
      reconciled = { ...reconciled, state: "completed", detail: "Codex run completed." };
    }
    await writeRunRecord(home, reconciled);
    return { state: reconciled.state, ...(reconciled.detail ? { detail: reconciled.detail } : {}) };
  }
  if (terminal?.kind === "failed") {
    return { state: "failed", detail: terminal.detail ?? "Codex run failed." };
  }
  if (record.exitCode !== undefined && record.exitCode !== null && record.exitCode !== 0) {
    return { state: "failed", detail: `Codex exited with code ${record.exitCode}.` };
  }
  if (record.exitCode === 0 && terminal?.kind === "completed" && (await hasLastMessage(record.resultFile))) {
    return { state: "completed", detail: "Codex run completed." };
  }
  if (record.state === "queued") {
    return { state: "queued" };
  }
  if (record.state === "running") {
    return { state: "running" };
  }
  if (record.state === "completed") {
    return { state: "failed", detail: "Codex run missing terminal evidence." };
  }
  return { state: "failed", detail: record.detail ?? "Codex run failed." };
}

async function defaultCodexRunner(request: CodexRunRequest): Promise<CodexRunResult> {
  await writePrivateFile(request.eventsFile, "", "w");
  const events = createWriteStream(request.eventsFile, { flags: "a", mode: 0o600 });
  const child = spawn("codex", request.argv, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    shell: false
  });
  if (child.pid) {
    request.onPid?.(child.pid);
  }
  let timedOut = false;
  request.signal.addEventListener(
    "abort",
    () => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 1000).unref();
      }
    },
    { once: true }
  );
  // Route stream failures into the run's rejection channel; an unhandled 'error'
  // on a long-lived WriteStream/stdio pipe would otherwise crash the MCP server.
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    events.on("error", reject);
    child.stdout.on("error", reject);
    child.stderr.on("error", reject);
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    child.stdout.pipe(events, { end: false });
    child.stderr.resume();
    child.stdin.end(request.stdin);
  });
  await new Promise<void>((resolve, reject) => {
    events.once("error", reject);
    events.end(() => {
      resolve();
    });
  });
  await chmod(request.eventsFile, 0o600);
  if (await pathExists(request.resultFile)) {
    await chmod(request.resultFile, 0o600);
  }
  return { exitCode, timedOut, ...(child.pid ? { pid: child.pid } : {}) };
}

export function createCodexCliAdapter(input: CreateCodexCliAdapterInput): CodexCliAdapter {
  const env = input.env ?? process.env;
  const run = input.run ?? defaultCodexRunner;
  const now = input.now ?? (() => new Date());
  const randomId = input.randomId ?? randomUUID;
  const gitTimeoutMs = Math.max(1, effectiveLimits(input.config).toolTimeoutMs - 1000);
  const git: GitExec =
    input.git ??
    ((args) => execFileAsync("git", args, { timeout: gitTimeoutMs, env: { ...process.env, LC_ALL: "C", LANG: "C" } }));

  async function rollbackWorktree(projectRoot: string, worktreePath: string): Promise<void> {
    await git(["-C", projectRoot, "worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true });
    await git(["-C", projectRoot, "worktree", "prune", "--expire", "now"]).catch(() => undefined);
  }

  async function launchRun(record: RunRecord, request: Omit<CodexRunRequest, "signal" | "onPid">, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("timed out");
    }, timeoutMs);

    // Serialize every persisted mutation so a fire-and-forget mid-run pid write
    // can never land after — and clobber — the terminal record.
    let writeChain: Promise<void> = Promise.resolve();
    const updateRecord = (mutate: (current: RunRecord) => RunRecord | Promise<RunRecord>): Promise<void> => {
      writeChain = writeChain.then(async () => {
        const current = (await readRunRecord(input.home, record.id)) ?? record;
        await writeRunRecord(input.home, await mutate(current));
      });
      return writeChain;
    };

    try {
      const result = await run({
        ...request,
        signal: controller.signal,
        onPid: (pid) => {
          void updateRecord((current) => ({ ...current, pid }));
        }
      });
      clearTimeout(timer);
      await updateRecord(async (current) => {
        const next: RunRecord = {
          ...current,
          exitCode: result.exitCode,
          pid: result.pid ?? current.pid,
          finishedAt: now().toISOString()
        };
        if (timedOut || result.timedOut) {
          next.state = "failed";
          next.detail = "timed out";
        } else {
          const mapped = await mapRecordStatus(input.home, next);
          next.state = mapped.state === "completed" ? "completed" : mapped.state === "failed" ? "failed" : "running";
          next.detail = mapped.detail;
        }
        return next;
      });
    } catch (error) {
      clearTimeout(timer);
      await updateRecord((current) => ({
        ...current,
        state: "failed",
        finishedAt: now().toISOString(),
        detail: error instanceof Error ? error.message : "Codex run failed."
      }));
    }
  }

  return {
    mode() {
      return codexMode(env);
    },
    async start(handoff) {
      if (codexMode(env) === "api-key") {
        throw new PlanbridgeError(
          "E_API_KEY_MODE",
          "Unset OPENAI_API_KEY/CODEX_API_KEY and use subscription login before starting codex-cli execution."
        );
      }

      const pbHome = planbridgeHome({ HOME: input.home });
      const project = await resolveAllowedProject(input.config, handoff.project, pbHome);
      const status = await gitStatus(project.root, effectiveLimits(input.config).toolTimeoutMs);
      if (status.branch === "") {
        throw new PlanbridgeError("E_NOT_A_REPO", "codex-cli execution requires a git repository.", handoff.project);
      }
      const baseSha = await gitCommitSha(project.root);

      const execution = effectiveExecution(input.config);
      const runId = randomId();
      const branch = `${execution.branchPrefix}${runId}`;
      const worktreeRoot = path.resolve(execution.worktreeRoot ?? path.join(pbHome, "worktrees"));
      const worktreePath = path.resolve(worktreeRoot, runId);
      if (!isInside(path.resolve(pbHome), worktreePath)) {
        throw new PlanbridgeError("E_WORKTREE_FAILED", "codex-cli worktree path must stay under PlanBridge home.");
      }

      const artifactPath = path.join(pbHome, "handoffs", `${runId}.md`);
      await writePrivateFile(artifactPath, renderHandoffArtifact({ ...handoff, project: project.name }), "wx");

      await mkdir(worktreeRoot, { recursive: true });
      try {
        await git(["-C", project.root, "worktree", "add", worktreePath, "-b", branch, "HEAD"]);
      } catch (error) {
        await rollbackWorktree(project.root, worktreePath);
        throw new PlanbridgeError(
          "E_WORKTREE_FAILED",
          error instanceof Error ? error.message : "Failed to create codex-cli worktree."
        );
      }

      const runDir = path.join(pbHome, "runs", runId);
      const eventsFile = path.join(runDir, "events.jsonl");
      const resultFile = path.join(runDir, "last-message.txt");
      await writePrivateFile(eventsFile, "");
      await writePrivateFile(resultFile, "");
      const record: RunRecord = {
        id: runId,
        project: project.name,
        worktreePath,
        branch,
        resultFile,
        eventsFile,
        state: "running",
        startedAt: now().toISOString(),
        mode: "subscription",
        ...(baseSha !== "UNVERSIONED" ? { baseSha } : {})
      };
      await writeRunRecord(input.home, record);

      const argv = buildCodexArgv({ worktreePath, resultFile });
      void launchRun(
        record,
        {
          argv,
          cwd: worktreePath,
          stdin: renderHandoffArtifact({ ...handoff, project: project.name }),
          env: sanitizeEnv(env),
          resultFile,
          eventsFile
        },
        input.timeoutMs ?? execution.timeoutMs
      );

      return { handle: runId, artifactPath, worktreePath };
    },
    async status(handle) {
      if (!RUN_ID_PATTERN.test(handle)) {
        return { state: "failed", detail: "invalid run handle" };
      }
      const record = await readRunRecord(input.home, handle);
      if (!record) {
        return { state: "failed", detail: "run not found" };
      }
      return mapRecordStatus(input.home, record);
    }
  };
}
