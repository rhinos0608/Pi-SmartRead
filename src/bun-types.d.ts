// Minimal type declarations for Bun runtime APIs used in Pi-SmartRead
// when @types/bun is not installed.

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    static setCustomSQLite(path: string): void;
    loadExtension(path: string): void;
    exec(sql: string): void;
    prepare(sql: string): any;
    close(): void;
  }
}

declare const Bun: any;
