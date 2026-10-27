import { tool } from "ai";
import { z } from "zod";
import { basename, relative } from "node:path";
import type { Sandbox } from "./sandbox";

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
  return tool({
    description: `Execute a shell command in the working directory.

WHEN TO USE: running build commands, installing packages, running tests,
  git operations, directory listings.

WHEN NOT TO USE: reading file contents (use read instead).
  Searching for patterns (use grep instead).

DO NOT USE FOR: reading files (use read), searching code (use grep).

USAGE: command is a single shell string. Commands not approved by the
  approval policy are blocked and return a clear error message.

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
      const { stdout } = await sandbox.exec(command);
      return stdout || "(no output)";
    },
  });
}
