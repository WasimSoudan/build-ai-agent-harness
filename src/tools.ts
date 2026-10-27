import { readFileSync } from "node:fs";
import { cwd } from "node:process";
import { resolve } from "node:path";
import { Sandbox } from "./sndbox";
// Before
execute: async ({ path: filePath }) => {
    const content = readFileSync(resolve(cwd, filePath), "utf-8");
    // ...
  }
   
  // After
  execute: async ({ path: filePath }) => {
    const content = await sandbox.readFile(filePath);
    // ...
  }