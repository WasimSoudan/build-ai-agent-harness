import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
import { ToolLoopAgent, stepCountIs } from "ai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "@ai-sdk/google";
import { buildSystemPrompt } from "./system";
import { join } from "node:path";
import type { Sandbox } from "./src/sandbox";
import { createBashTool, createGrepTool, createReadTool } from "./src/tools";
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

const cwd = resolve(process.argv[2] || process.cwd());
const agentsPath = join(cwd, "AGENTS.md");
const projectContext = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : undefined;

const sandbox: Sandbox = {
  type: "local",
  workingDirectory: cwd,
  async readFile(filePath) {
    return readFileSync(resolve(cwd, filePath), "utf-8");
  },
  async exec(command) {
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
  async stop() {},
};

const approval = createApproval({
  mode: "delegated",
  trust: ["pwd", "find .", "git status"],
});
const bash = createBashTool(sandbox, approval);
const read = createReadTool(sandbox);
const grep = createGrepTool(sandbox);

const instructions = buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: "local",
    toolNames: Object.keys({ read, grep, bash }),
    projectContext: projectContext,
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
