import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { google } from "@ai-sdk/google";
import { execSync } from "node:child_process";

const SAFE_PREFIXES =['ls',"cat" , "echo" , "pwd" ,'which', 'find',   "head", "tail", "wc", "git log", "git status", "git diff",]
function isSafe(command: string): boolean {
    return SAFE_PREFIXES.some((p) => command.trim().startsWith(p));
  }

const bash = tool({
  description:  `Search file contents using regex. Returns matching lines with file paths.
 
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
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (!isSafe(command)) {
        return `Blocked: "${command}" requires approval. Only safe commands (${SAFE_PREFIXES.join(", ")}) run automatically.`;
      }
      try {
        const stdout = execSync(command, {
          cwd,
          encoding: "utf-8",
          timeout: 30_000,
        });
        return stdout || "(no output)";
      } catch (e: any) {
        return `Exit ${e.status ?? 1}: ${e.stdout || e.stderr || e.message || ""}`;
      }
    },
  });
const cwd = resolve(process.argv[2] || process.cwd());
 
const read = tool({
  description:  `Read a file from the project. Returns numbered lines.
 
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
 
    const numbered = lines.map((l, i) => `${(offset || 1) + i}: ${l}`);
    return truncated
      ? numbered.join("\n") + `\n... (truncated at ${MAX_LINES} lines)`
      : numbered.join("\n");
  },
});
 
const grep = tool({
  description:`Search file contents using regex. Returns matching lines with file paths.
 
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
          .forEach((line, i) => {
            if (regex.test(line)) matches.push(`${relative(cwd, full)}:${i + 1}:${line}`);
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
 
const agent = new ToolLoopAgent({
//   model: "anthropic/claude-haiku-4-5",
model: google("gemini-3.5-flash-lite"),
  instructions: `You are a coding agent.\nWorking directory: ${cwd}`,
  tools: { bash ,read, grep },
  stopWhen: stepCountIs(10),
});
 
const prompt = process.argv.slice(3).join(" ") || "Hello!";
const { text, steps } = await agent.generate({ prompt });
console.log(text);
console.log(`\n(${steps.length} steps)`);