import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
import { parseArgs } from "node:util";
import { ToolLoopAgent, isStepCount, pruneMessages, tool } from "ai";
import { z } from "zod";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createLocalSandbox } from "./src/sandbox-local";
import { createJustBashSandbox } from "./src/sandbox-just-bash";
import { buildSystemPrompt } from "./src/system";
import { addCacheControl } from "./src/cache";
import { discoverGates } from "./src/verification";
import type { Sandbox } from "./src/sandbox";
import { google } from "@ai-sdk/google";
import { discoverSkills } from "./src/skills";
import { createRegistry, registerBuiltins } from "./src/registry";
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
 
const registry = createRegistry();
registerBuiltins(registry, sandbox, skills);

registry.register("now", tool({
  description: "Return the current timestamp",
  inputSchema: z.object({}),
  execute: async () => new Date().toISOString(),
}));

const tools = Object.fromEntries(registry.entries());

const agent = new ToolLoopAgent({
  model: google(values.model!),
  instructions: buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: sandbox.type,
    toolNames: registry.list(),
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