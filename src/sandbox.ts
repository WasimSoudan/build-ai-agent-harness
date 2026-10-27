export interface Sandbox {
    type:string;
    workingDirectory:string;
    readFile(path:string):Promise<string>;
    exec(command:string):Promise<string>;
    stop():Promise<void>;
    expiresAt?:number;
    snapshot?() :Promise<{snapshotId:string}>;
}