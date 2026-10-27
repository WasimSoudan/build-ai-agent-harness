import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
import { ToolLoopAgent, stepCountIs,tool, pruneMessages } from "ai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "@ai-sdk/google";
import { buildSystemPrompt } from "./system";
import { join } from "node:path";
import type { SandboxLifecycle } from "./src/sandbox";
import { createLocalSandbox } from "./src/sandbox-local";
import { createJustBashSandbox } from "./src/sandbox-just-bash";
import { createBashTool, createGrepTool, createReadTool, createTaskTool } from "./src/tools";
import { addCacheControl } from "./src/cache";  
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
const sandboxType = process.env.SANDBOX || "local";
const sandbox =
  sandboxType === "just-bash"
    ? await createJustBashSandbox(cwd)
    : createLocalSandbox(cwd);
// const sandbox = createLocalSandbox(cwd);
console.error(`Sandbox ${sandbox.type} created in ${sandbox.workingDirectory}`);

const lifecycle: SandboxLifecycle = {
  afterStart: async (sb) => console.error(`[lifecycle] after start: ${sb.type}`),
  beforeStop: async (sb) => console.error(`[lifecycle] before stop: ${sb.type}`),
};
await lifecycle.afterStart?.(sandbox);

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

  const tools_with_task = {
    ...tools,
    task:  createTaskTool(sandbox, { read: tools.read, grep: tools.grep }),
  }

const agent = new ToolLoopAgent({
  model: google("gemini-3.5-flash-lite"),
  instructions:  instructions,
  tools: tools_with_task,
  stopWhen: stepCountIs(10),
  onStepEnd:({usage ,stepNumber})=>{
    console.error(
      `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.inputTokenDetails.cacheReadTokens ?? 0} cached`,
    );
  },
  prepareCall: async (options) => {
    const pruned = options.messages
      ? pruneMessages({
          messages: options.messages,
          toolCalls: "before-last-3-messages",
        })
      : undefined;
   
    return {
      ...options,
      messages: pruned ? addCacheControl(pruned) : undefined,
    };
  },
});

const prompt = process.argv.slice(3).join(" ") || "Hello!";
try {
  const { text, steps } = await agent.generate({ prompt });
  console.log(text);
  console.log(`\n(${steps.length} steps)`);
} finally {
  await lifecycle.beforeStop?.(sandbox);
  await sandbox.stop();
}
