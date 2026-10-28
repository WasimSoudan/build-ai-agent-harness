import {readFileSync} from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { Sandbox } from "./sandbox";

export function createLocalSandbox(workingDir: string): Sandbox {
    return{
        type:"local",
        workingDirectory: workingDir,
        readFile:async(p)=> readFileSync(resolve(workingDir, p),'utf-8'),
        exec:async(command)=> {
            try{
                const stdout = execSync(command,{
                    cwd: workingDir,
                    encoding:'utf-8',
                    timeout:30_000,
                    shell: "powershell.exe"
                })
                return { stdout, exitCode: 0 };
            }catch(e:any){
                return { stdout:e.stdout||e.stderr||e.message||'', exitCode: e.status ?? 1 };
            }
        },
        stop:async()=>{},
        
    }
}