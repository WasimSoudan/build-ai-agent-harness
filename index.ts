import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { google } from "@ai-sdk/google";
import { buildSystemPrompt } from "./system";

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };
interface BashOperations {
  exec(command: string): Promise<{ stdout: string; exitCode: number }>;
}

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

const cwd = resolve(process.argv[2] || process.cwd());

function createBashTool(operations: BashOperations,needsApproval: (input: { command: string }) => boolean,) {

  return tool({
    description: `Execute a shell command in the working directory.

WHEN TO USE: running build commands, installing packages, running tests,
  git operations, directory listings.

WHEN NOT TO USE: reading file contents (use read instead).
  Searching for patterns (use grep instead).

DO NOT USE FOR: reading files (use read), searching code (use grep).

USAGE: command is a single shell string. Commands not in the safe-prefix
  allowlist are blocked and return a clear error message.

EXAMPLES:
  - List files: command "ls"
  - Check git status: command "git status"
  - Run a test suite: command "npm test"`,
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
        if (needsApproval({ command })) {
            return `Blocked: "${command}" requires approval.`;
          }

      const { stdout } = await operations.exec(command);
      return stdout || "(no output)";
    },
  });
}

const localOps: BashOperations = {
  exec: async (command) => {
    try {
      const stdout = execSync(command, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
        shell: "powershell.exe",
      });
      return { stdout, exitCode: 0 };
    } catch (error: any) {
      return {
        stdout: error.stdout || error.stderr || error.message || "",
        exitCode: error.status ?? 1,
      };
    }
  },
};
// // Interactive: human approves anything not on the safe list
// const bash = createBashTool(localOps, createApproval({ mode: "interactive" }));
 
// // Background: auto-approve everything (CI, automation)
// const bash = createBashTool(localOps, createApproval({ mode: "background" }));
 
// Delegated: subagent inherits a trust slice from its parent
const bash = createBashTool(
  localOps,
  createApproval({ mode: "delegated", trust: ["pwd", "find .", "git status"] }),
);
const read = tool({
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
    const abs = resolve(cwd, filePath);
    const content = readFileSync(abs, "utf-8");
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

const grep = tool({
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
    const dir = resolve(cwd, searchPath || ".");
    const regex = new RegExp(pattern);
    const matches: string[] = [];

    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = resolve(folder, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }

        const glob = globFilter || "*";
        const nameOk =
          glob === "*" || (glob.startsWith("*.") && entry.name.endsWith(glob.slice(1)));
        if (!nameOk) continue;

        readFileSync(full, "utf-8")
          .split("\n")
          .forEach((line, index) => {
            if (regex.test(line)) matches.push(`${relative(cwd, full)}:${index + 1}:${line}`);
            regex.lastIndex = 0;
          });
      }
    };

    walk(dir);
    if (matches.length === 0) return "No matches found.";

    const MAX_MATCHES = 50;
    const shown = matches.slice(0, MAX_MATCHES);
    return matches.length > MAX_MATCHES
      ? shown.join("\n") + `\n... (${matches.length} total, showing first ${MAX_MATCHES})`
      : shown.join("\n");
  },
});

const instructions = buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: "local",
    toolNames: Object.keys({ read, grep, bash }),
  });

const agent = new ToolLoopAgent({
  model: google("gemini-3.5-flash-lite"),
  instructions:  instructions,
  tools: { bash, read, grep },
  stopWhen: stepCountIs(10),
});

const prompt = process.argv.slice(3).join(" ") || "Hello!";
const { text, steps } = await agent.generate({ prompt });
console.log(text);
console.log(`\n(${steps.length} steps)`);
