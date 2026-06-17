import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { planbridgeHome } from "../config.js";
import { codexMode, type CodexAdapter, type CodexAdapterStatus, type CodexHandoff, type CodexMode } from "./codex-adapter.js";

const FRONTMATTER_FIELDS = [
  "schema_version",
  "objective",
  "project",
  "non_goals",
  "likely_files",
  "verification",
  "stop_conditions"
] as const;

type HandoffFileAdapterInput = {
  home: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

function frontmatterFor(handoff: CodexHandoff): Record<(typeof FRONTMATTER_FIELDS)[number], unknown> {
  return {
    schema_version: handoff.schema_version,
    objective: handoff.objective,
    project: handoff.project,
    non_goals: handoff.non_goals,
    likely_files: handoff.likely_files,
    verification: handoff.verification,
    stop_conditions: handoff.stop_conditions
  };
}

function renderList(items: string[]): string {
  return items
    .map((item) => {
      const [firstLine = "", ...rest] = item.split(/\r?\n/);
      return [`- ${firstLine}`, ...rest.map((line) => `  ${line}`)].join("\n");
    })
    .join("\n");
}

function parseList(body: string): string[] {
  const items: string[] = [];
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("- ")) {
      if (current) {
        items.push(current.join("\n"));
      }
      current = [line.slice(2)];
    } else if (current && line.startsWith("  ")) {
      current.push(line.slice(2));
    } else if (line.trim() !== "") {
      throw new Error(`Invalid list item: ${line}`);
    }
  }
  if (current) {
    items.push(current.join("\n"));
  }
  return items;
}

const CANONICAL_SECTION_HEADINGS = ["Objective", "Context", "Constraints", "Verification", "Stop Conditions"] as const;

function sectionMap(markdownBody: string): Map<string, string> {
  const lines = markdownBody.split(/\r?\n/);
  const sections = new Map<string, string>();
  let current: (typeof CANONICAL_SECTION_HEADINGS)[number] | undefined;
  let body: string[] = [];
  let nextHeadingIndex = 0;
  for (const line of lines) {
    const heading = line.match(/^## (.+)$/);
    const expectedHeading = CANONICAL_SECTION_HEADINGS[nextHeadingIndex];
    if (heading && heading[1] === expectedHeading) {
      if (current) {
        sections.set(current, body.join("\n").replace(/\n+$/, ""));
      }
      current = expectedHeading;
      body = [];
      nextHeadingIndex += 1;
    } else if (current) {
      body.push(line);
    }
  }
  if (current) {
    sections.set(current, body.join("\n").replace(/\n+$/, ""));
  }
  return sections;
}

export function handoffMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): CodexMode {
  return codexMode(env);
}

export function renderHandoffArtifact(handoff: CodexHandoff): string {
  const frontmatter = stringify(frontmatterFor(handoff)).trimEnd();
  return [
    "---",
    frontmatter,
    "---",
    "",
    "## Objective",
    handoff.objective,
    "",
    "## Context",
    handoff.context,
    "",
    "## Constraints",
    handoff.constraints,
    "",
    "## Verification",
    renderList(handoff.verification),
    "",
    "## Stop Conditions",
    renderList(handoff.stop_conditions),
    ""
  ].join("\n");
}

export function parseHandoffArtifact(markdown: string): CodexHandoff {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Handoff frontmatter not found.");
  }
  const frontmatter = parse(match[1]) as Record<string, unknown>;
  const sections = sectionMap(match[2]);
  return {
    project: String(frontmatter.project),
    objective: sections.get("Objective") ?? "",
    context: sections.get("Context") ?? "",
    constraints: sections.get("Constraints") ?? "",
    non_goals: Array.isArray(frontmatter.non_goals) ? frontmatter.non_goals.map(String) : [],
    likely_files: Array.isArray(frontmatter.likely_files) ? frontmatter.likely_files.map(String) : [],
    verification: parseList(sections.get("Verification") ?? ""),
    stop_conditions: parseList(sections.get("Stop Conditions") ?? ""),
    schema_version: "1.0"
  };
}

export function createHandoffFileAdapter(input: HandoffFileAdapterInput): CodexAdapter {
  const home = input.home;
  const env = input.env ?? process.env;
  return {
    mode() {
      return handoffMode(env);
    },
    async start(handoff) {
      const id = randomUUID();
      const handoffsDir = path.join(planbridgeHome({ HOME: home }), "handoffs");
      await mkdir(handoffsDir, { recursive: true });
      const handle = path.join(handoffsDir, `${id}.md`);
      await writeFile(handle, renderHandoffArtifact(handoff), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { handle };
    },
    async status(handle): Promise<CodexAdapterStatus> {
      try {
        await access(handle);
        return { state: "queued" };
      } catch {
        return { state: "failed", detail: "handoff artifact not found" };
      }
    }
  };
}
