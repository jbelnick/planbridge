export type CodexMode = "subscription" | "api-key";

export function codexMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): CodexMode {
  return (env.CODEX_API_KEY && env.CODEX_API_KEY.trim() !== "") ||
    (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim() !== "")
    ? "api-key"
    : "subscription";
}

export type CodexHandoff = {
  project: string;
  objective: string;
  context: string;
  constraints: string;
  non_goals: string[];
  likely_files: string[];
  verification: string[];
  stop_conditions: string[];
  schema_version: "1.0";
};

export type CodexAdapterStatus =
  | { state: "queued"; detail?: string }
  | { state: "running"; detail?: string }
  | { state: "completed"; detail?: string }
  | { state: "failed"; detail?: string }
  | { state: "requires-user-input"; detail?: string };

export interface CodexAdapter {
  mode(): CodexMode;
  start(handoff: CodexHandoff): Promise<{ handle: string }>;
  status(handle: string): Promise<CodexAdapterStatus>;
}
