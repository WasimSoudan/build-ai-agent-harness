import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
import { parseArgs } from "node:util";
import { ToolLoopAgent, isStepCount, pruneMessages } from "ai";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
 
import { createLocalSandbox } from "./src/sandbox-local";
import { createJustBashSandbox } from "./src/sandbox-just-bash";
import { buildSystemPrompt } from "./src/system";
import {
  createReadTool,
  createGrepTool,
  createBashTool,
  createTaskTool,
  createAskUserTool,
  createTodoTool,
} from "./src/tools";
import { createApproval } from "./src/approval";
import { addCacheControl } from "./src/cache";
import { discoverGates } from "./src/verification";
import type { Sandbox } from "./src/sandbox";
 import { google } from "@ai-sdk/google";
 import { discoverSkills } from "./src/skills";
 import { createLoadSkillTool } from "./src/tools";
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sandbox: { type: "string", default: "local" },
    model: { type: "string", default: "gemini-3.5-flash-lite" },
  },
  allowPositionals: true,
});
 
const cwd = resolve(positionals[0] || process.cwd());
const prompt = positionals.slice(1).join(" ") || "Hello!";
 
async function sandboxFromFlag(name: string, dir: string): Promise<Sandbox> {
  if (name === "just-bash") return createJustBashSandbox(dir);
  return createLocalSandbox(dir);
}
 
const sandbox = await sandboxFromFlag(values.sandbox!, cwd);
console.error(`Sandbox: ${sandbox.type}`);
 
const projectContext = existsSync(join(cwd, "AGENTS.md"))
  ? readFileSync(join(cwd, "AGENTS.md"), "utf-8")
  : undefined;
 
const verificationCommands = await discoverGates(sandbox);
const skillDirs = [
  join(cwd, "skills"),
  join(process.env.HOME ?? "", ".harness", "skills"),
];
const skills = discoverSkills(skillDirs);
 
const baseTools = {
  read: createReadTool(sandbox),
  grep: createGrepTool(sandbox),
  bash: createBashTool(sandbox, createApproval({ mode: "interactive" })),
};
const tools = {
  ...baseTools,
  task: createTaskTool(sandbox, { read: baseTools.read, grep: baseTools.grep }),
  askUser: createAskUserTool(),
  todo: createTodoTool(),
  loadSkill: createLoadSkillTool(skills),
};
 
const agent = new ToolLoopAgent({
  model: google(values.model!),
  instructions: buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: sandbox.type,
    toolNames: Object.keys(tools),
    projectContext,
    verificationCommands,
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
  }),
  tools,
  stopWhen: isStepCount(15),
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
  onStepEnd: ({ usage, stepNumber }) => {
    console.error(
      `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output`,
    );
  },
});
 
process.on("SIGINT", async () => {
  console.error("\nShutting down...");
  await sandbox.stop();
  process.exit(0);
});
 
try {
  const result = await agent.stream({ prompt });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.text);
        break;
      case "tool-call":
        console.error(
          `\n[tool] ${chunk.toolName}(${JSON.stringify(chunk.input)})`,
        );
        break;
      case "tool-result": {
        const raw =
          typeof chunk.output === "string"
            ? chunk.output
            : JSON.stringify(chunk.output) ?? "";
        console.error(`  -> ${raw.slice(0, 100)}`);
        break;
      }
    }
  }

  console.log();
} finally {
  await sandbox.stop();
}