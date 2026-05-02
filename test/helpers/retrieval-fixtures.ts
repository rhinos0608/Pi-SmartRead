import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RetrievalFixture {
  root: string;
  files: Record<string, string>;
}

export function createRetrievalFixture(name: string, files: Record<string, string>): RetrievalFixture {
  const root = mkdtempSync(join(tmpdir(), `pi-smartread-fixture-${name}-`));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    // Ensure parent directory exists
    const parent = join(root, path, "..");
    mkdirSync(parent, { recursive: true });
    writeFileSync(fullPath, content);
  }
  return { root, files };
}

export function cleanupFixture(fixture: RetrievalFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

/**
 * Standard test scenarios for repository retrieval.
 */
export const SCENARIOS = {
  // Scenario 1: Exact lexical match
  lexicalMatch: {
    "main.ts": "import { auth } from './auth';\nauth();",
    "auth.ts": "export function auth() { console.log('authenticating'); }",
    "db.ts": "export function query() { console.log('querying'); }",
  },
  // Scenario 2: Semantic match (indirect conceptual overlap)
  semanticMatch: {
    "login.ts": "export function handleUserLogin() { /* log the user in */ }",
    "storage.ts": "export function persistData() { /* save to disk */ }",
  },
  // Scenario 3: Import neighbor match
  importNeighbor: {
    "app.ts": "import { config } from './config';\nconsole.log(config);",
    "config.ts": "export const config = { port: 8080 };",
    "helper.ts": "export const help = () => {};",
  },
  // Scenario 4: Symbol definition/reference in different files
  symbolCrossFile: {
    "service.ts": `
import { Repository } from './repo';
export class UserService {
  constructor(private repo: Repository) {}
  async getUser(id: string) { return this.repo.find(id); }
}`,
    "repo.ts": `
export class Repository {
  find(id: string) { return { id, name: 'User' }; }
}`,
    "unused.ts": "export const irrelevant = 42;",
  },
  // Scenario 5: Caller/callee relation
  callGraph: {
    "index.ts": "import { start } from './app';\nstart();",
    "app.ts": "import { init } from './init';\nexport function start() { init(); }",
    "init.ts": "export function init() { console.log('initialized'); }",
  }
};
