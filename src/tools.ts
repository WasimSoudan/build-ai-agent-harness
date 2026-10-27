import {ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { basename, relative } from "node:path";
import type { Sandbox } from "./sandbox";
import { google } from "@ai-sdk/google";

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

const SAFE_PREFIXES = [
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
  "find",
  "head",
  "tail",
  "wc",
  "git log",
  "git status",
  "git diff",
];
function createApproval(config: ApprovalConfig) {
  return ({ command }: { command: string }) => {
    if (config.mode === "background") return false;
 
    if (config.mode === "delegated") {
      return !config.trust.some((p) => command.trim().startsWith(p));
    }
 
    return !SAFE_PREFIXES.some((p) => command.trim().startsWith(p));
  };
}
function buildExplorer(sandbox:Sandbox ,parentTools:{read:any,grep:any})  {
  return new ToolLoopAgent({
    model: google("gemini-3.5-flash-lite"),
    instructions: `You are an explorer agent. Investigate and report back concisely.
Working directory: ${sandbox.workingDirectory}`,
    tools: { read: parentTools.read, grep: parentTools.grep },
    stopWhen: isStepCount(5),
  });
}

function buildExecutor(sandbox: Sandbox, parentTools: { read: any; grep: any }) {
  const executorBash = createBashTool(
    sandbox,
    createApproval({
      mode: "delegated",
      trust: ["npm test", "npm run build", "npx tsc"],
    }),
  );
  return new ToolLoopAgent({
    model: google("gemini-3.5-flash-lite"),
    instructions: `You are an executor agent. Follow instructions precisely.
Working directory: ${sandbox.workingDirectory}
Do NOT ask questions. Do NOT explore beyond what's needed. Execute the task.`,
    tools: { read: parentTools.read, grep: parentTools.grep, bash: executorBash },
    stopWhen: isStepCount(15),
  });
}

type RunnableAgent = {
  generate(options: { prompt: string }): Promise<{ text: string; steps: { length: number } }>;
};

async function runSubagent(role: string, agent: RunnableAgent, description: string) {
  try {
    const { text, steps } = await agent.generate({ prompt: description });
    return text ? `[${role}: ${steps.length} steps]\n${text}` : `(no response from ${role})`;
  } catch (e: any) {
    return `${role} error: ${e.message}`;
  }
}


export function createReadTool(sandbox: Sandbox) {
  return tool({
    description: `Read a file from the project. Returns numbered lines.

WHEN TO USE: viewing file contents, checking configurations, reading source code,
  examining specific lines with offset/limit.

WHEN NOT TO USE: searching for patterns across files (use grep instead).
  Running commands (use bash instead).

DO NOT USE FOR: searching code (use grep), executing commands (use bash),
  modifying files (use edit or write).

USAGE: path is relative to working directory. offset and limit are optional.
  Output is capped at 500 lines.`,
    inputSchema: z.object({
      path: z.string().describe("File path relative to working directory"),
      offset: z.number().optional().describe("Start line (1-indexed)"),
      limit: z.number().optional().describe("Max lines to return"),
    }),
    execute: async ({ path: filePath, offset, limit }) => {
      const content = await sandbox.readFile(filePath);
      let lines = content.split("\n");

      if (offset) lines = lines.slice(offset - 1);
      if (limit) lines = lines.slice(0, limit);

      const MAX_LINES = 500;
      const truncated = lines.length > MAX_LINES;
      if (truncated) lines = lines.slice(0, MAX_LINES);

      const numbered = lines.map((line, index) => `${(offset || 1) + index}: ${line}`);
      return truncated
        ? numbered.join("\n") + `\n... (truncated at ${MAX_LINES} lines)`
        : numbered.join("\n");
    },
  });
}

export function createGrepTool(sandbox: Sandbox) {
  return tool({
    description: `Search file contents using regex. Returns matching lines with file paths.

WHEN TO USE: finding patterns across multiple files, locating function definitions,
  searching for imports, finding TODOs or error messages.

WHEN NOT TO USE: reading a known file (use read instead).
  Running commands (use bash instead).

DO NOT USE FOR: reading files (use read), listing directories (use bash),
  modifying files (use edit).

USAGE: pattern is a regex string. glob filters by file extension.
  Results are capped at 50 matches.

EXAMPLES:
  - Find all TODO comments: pattern "TODO" glob "*.ts"
  - Find function definitions: pattern "function \\w+" glob "*.ts"
  - Find imports of a package: pattern "from 'express'" glob "*.ts"`,
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("Directory to search (default: working dir)"),
      glob: z.string().optional().describe("File glob filter, e.g. '*.ts'"),
    }),
    execute: async ({ pattern, path: searchPath, glob: globFilter }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        return `Invalid regex: ${pattern}`;
      }

      const root = (searchPath || ".").replace(/'/g, "''");
      const listed = await sandbox.exec(
        `$root = '${root}'; $stack = @($root); while ($stack.Count -gt 0) { $current = $stack[0]; if ($stack.Count -eq 1) { $stack = @() } else { $stack = $stack[1..($stack.Count - 1)] }; Get-ChildItem -LiteralPath $current -Force -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Name -eq 'node_modules' -or $_.Name -eq '.git') { return }; if ($_.PSIsContainer) { $stack += $_.FullName } else { $_.FullName } } }`,
      );
      const files = listed.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const matches: string[] = [];
      for (const file of files) {
        const name = basename(file);
        const glob = globFilter || "*";
        const nameOk =
          glob === "*" || (glob.startsWith("*.") && name.endsWith(glob.slice(1)));
        if (!nameOk) continue;

        const content = await sandbox.readFile(file);
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (regex.test(lines[index])) {
            const display = relative(sandbox.workingDirectory, file) || file;
            matches.push(`${display}:${index + 1}:${lines[index]}`);
          }
          regex.lastIndex = 0;
        }
      }

      if (matches.length === 0) return "No matches found.";

      const MAX_MATCHES = 50;
      const shown = matches.slice(0, MAX_MATCHES);
      return matches.length > MAX_MATCHES
        ? shown.join("\n") + `\n... (${matches.length} total, showing first ${MAX_MATCHES})`
        : shown.join("\n");
    },
  });
}

export function createBashTool(
  sandbox: Sandbox,
  needsApproval: (input: { command: string }) => boolean,
) {
  const MAX_BASH_CHARS = 5000;
  return tool({
    description:  `Execute a shell command in the working directory.
    WHEN TO USE: build commands, package install, tests, git, directory listings.
    WHEN NOT TO USE: reading file contents (use read).
    DO NOT USE FOR: reading files (use read), searching code (use grep).`,
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (needsApproval({ command })) {
        return `Blocked: "${command}" requires approval.`;
      }
      const result = await sandbox.exec(command);
      const stdout = result.stdout || "(no output)";
      return stdout.length > MAX_BASH_CHARS
        ? stdout.slice(-MAX_BASH_CHARS) +
            `\n... (truncated, showing last ${MAX_BASH_CHARS} chars)`
        : stdout;
    },
  });
}

export function createTaskTool(
  sandbox: Sandbox,
  parentTools: { read: any; grep: any },
) {
  return tool({
    description: `Delegate work to a subagent.
Explorer (default): read-only research with Gemini. Use for searching across files,
  understanding patterns, and gathering context.
Executor: implementation with Gemini and delegated bash. Use for focused
  changes with explicit instructions and a known verification step.
     
    WHEN TO USE: research across many files (explorer), bulk implementation (executor).
    WHEN NOT TO USE: ambiguous requirements (use askUser), architectural decisions
      (the parent decides).
    DO NOT USE FOR: single-step tasks the parent can do directly.`,
    inputSchema: z.object({
      description: z.string().describe("Task instructions for the subagent"),
      subagentType: z
        .enum(["explorer", "executor"])
        .default("explorer")
        .describe("Subagent role"),
    }),
    execute: async ({ description, subagentType }) => {
      const agent: RunnableAgent =
        subagentType === "executor"
          ? buildExecutor(sandbox, parentTools)
          : buildExplorer(sandbox, parentTools);
      return runSubagent(subagentType, agent, description);
    },
  });
}