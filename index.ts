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
import { createLocalSandbox } from "./src/sandbox-local";
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

const approval = createApproval({ mode: "interactive" });
const sandbox = createLocalSandbox(cwd);
console.error(`Sandbox ${sandbox.type} created in ${sandbox.workingDirectory}`);

const tools={
    bash: createBashTool(sandbox, approval),
    read: createReadTool(sandbox),
    grep: createGrepTool(sandbox),
}
const instructions = buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: "local",
    toolNames: Object.keys(tools),
    projectContext: projectContext,
  });

const agent = new ToolLoopAgent({
  model: google("gemini-3.5-flash-lite"),
  instructions:  instructions,
  tools: tools,
  stopWhen: stepCountIs(10),
});

const prompt = process.argv.slice(3).join(" ") || "Hello!";
const { text, steps } = await agent.generate({ prompt });
console.log(text);
console.log(`\n(${steps.length} steps)`);
