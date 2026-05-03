# MCP Server Quickstart

Pi-SmartRead ships a lightweight **MCP (Model Context Protocol) stdio server** that exposes its code intelligence tools to any MCP-compatible client — no SDK dependency required.

---

## One-liner for Claude Code

```bash
claude mcp add pi-smartread -- npx tsx /absolute/path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts
```

The project lives in a nested `Pi-SmartRead/Pi-SmartRead/` structure. The server file is at the inner level. Run this from your project directory — the server uses that `cwd` for file operations.

To verify it's connected:

```bash
claude mcp list
```

Then inside a Claude Code session, use `/mcp` to see live status.

---

## What you get

| MCP Tool | Description |
|---|---|
| `intent_read` | Hybrid retrieval: BM25 keyword + semantic embeddings with RRF fusion |
| `read_multiple_files` | Read up to 20 files in one call with adaptive packing |
| `repo_map` | PageRank-ranked repository map from tree-sitter ASTs |
| `search` | Consolidated symbol tool: fuzzy search (`symbols`), resolution with enrichment (`resolve`), call graph (`callers`), AST-aware code search (`code`) |

---

## Prerequisites

- **Node.js ≥ 20**
- **`npm install`** in the `Pi-SmartRead/Pi-SmartRead/` directory
- **`tsx`** (included as a dev dependency — no global install needed)
- **Embedding config** (only for `intent_read` semantic ranking — BM25-only works without it)

---

## Configure in Claude Code

### Preferred: CLI one-liner

```bash
claude mcp add pi-smartread -- npx tsx /path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts
```

Add `--scope project` to share the config with your team via `.mcp.json` (committed to version control):

```bash
claude mcp add pi-smartread --scope project -- npx tsx /path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts
```

### Alternative: `.mcp.json` (project-scoped, team-shared)

Place a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "pi-smartread": {
      "command": "npx",
      "args": ["tsx", "/path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts"]
    }
  }
}
```

This file can be checked into version control so your whole team gets the same tools.

### Alternative: `~/.claude.json` (user-scoped)

Edit your Claude Code user config:

```json
{
  "mcpServers": {
    "pi-smartread": {
      "command": "npx",
      "args": ["tsx", "/path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts"]
    }
  }
}
```

### Import from Claude Desktop

If you already have Pi-SmartRead configured in Claude Desktop:

```bash
claude mcp add-from-claude-desktop
```

---

## Configure in Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "pi-smartread": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Set `cwd` to the directory you want the server to operate in — all relative file paths resolve against this. The server is **not sandboxed**; absolute paths to any accessible file work regardless of `cwd`.

---

## Configure in Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "pi-smartread": {
      "command": "npx",
      "args": ["tsx", "/path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts"]
    }
  }
}
```

---

## Run the server standalone

### From the project directory

```bash
# Using the npm script (tsx resolved from local node_modules)
npm run mcp-server

# Or directly
node --import tsx mcp-server.ts
```

### From anywhere (absolute path)

```bash
npx tsx /path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts
```

The server reads JSON-RPC 2.0 messages from **stdin** and writes responses to **stdout**. Logs and errors go to **stderr**.

---

## Test it manually (from Pi-SmartRead directory)

### Initialize

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | npm run mcp-server
```

Expected response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "pi-smartread", "version": "0.1.0" }
  }
}
```

### List available tools

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | npm run mcp-server
```

### Call a tool

```bash
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"mode":"symbols","query":"RepoMap","directory":"."}}}' | npm run mcp-server
```

---

## Environment variables

The MCP server inherits all Pi-SmartRead configuration from environment variables:

| Variable | Description |
|---|---|
| `PI_SMARTREAD_EMBEDDING_BASE_URL` | OpenAI-compatible embedding API URL |
| `PI_SMARTREAD_EMBEDDING_MODEL` | Embedding model name |
| `PI_SMARTREAD_EMBEDDING_API_KEY` | API key (optional) |
| `PI_SMARTREAD_CHUNK_SIZE` | Chunk size in characters (optional) |
| `PI_SMARTREAD_CHUNK_OVERLAP` | Chunk overlap in characters (optional) |

Alternatively, place a `pi-smartread.config.json` file in the project root (the `cwd` the server runs in).

To pass environment variables to an MCP server in Claude Code, use the `--env` flag:

```bash
claude mcp add pi-smartread \
  --env PI_SMARTREAD_EMBEDDING_BASE_URL=http://localhost:11434/v1 \
  --env PI_SMARTREAD_EMBEDDING_MODEL=nomic-embed-text \
  -- npx tsx /path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "pi-smartread": {
      "command": "npx",
      "args": ["tsx", "/path/to/Pi-SmartRead/Pi-SmartRead/mcp-server.ts"],
      "env": {
        "PI_SMARTREAD_EMBEDDING_BASE_URL": "http://localhost:11434/v1",
        "PI_SMARTREAD_EMBEDDING_MODEL": "nomic-embed-text"
      }
    }
  }
}
```

---

## MCP protocol reference

### Messages the server handles

| Method | Description |
|---|---|
| `initialize` | Handshake — returns server capabilities and info |
| `notifications/initialized` | Client acknowledgment (no response, handled in `start()`) |
| `tools/list` | Returns all available tools with their JSON Schema |
| `tools/call` | Executes a tool with the given arguments |
| `ping` | Health check — returns `{}` |

### Tool call format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "intent_read",
    "arguments": {
      "query": "authentication middleware",
      "files": [
        { "path": "src/auth.ts" },
        { "path": "src/middleware.ts" }
      ],
      "topK": 5
    }
  }
}
```

### Tool call response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "... file contents ..." }
    ],
    "isError": false
  }
}
```

### Error response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found: unknown/method"
  }
}
```

---

## How it differs from the Pi extension

| | Pi Extension | MCP Server |
|---|---|---|
| **Transport** | Pi's internal tool API | MCP stdio (JSON-RPC 2.0) |
| **Host** | Pi coding agent | Any MCP client (Claude Code, Claude Desktop, Cursor, etc.) |
| **Hooks** | First-read repo map interception | No hooks (direct tool calls) |
| **Install** | `pi install git:...` | `npx tsx mcp-server.ts` |
| **Same tools?** | Yes (fewer — consolidated) | Yes — same underlying implementations |

---

## Troubleshooting

**`claude mcp add` fails with "Connection closed"** — Make sure `node` and `npx` are on your PATH. If using nvm, ensure nvm loads in non-interactive shells. On Windows, add `cmd /c` before `npx`.

**Server exits immediately when testing** — Make sure you're piping valid JSON-RPC to stdin. The server reads line-by-line and exits when stdin closes.

**"Cannot find package 'tsx'"** — Run `npm install` in the Pi-SmartRead directory, or install tsx globally (`npm i -g tsx`).

**No semantic ranking** — The MCP server uses the same embedding config as the Pi extension. Set `PI_SMARTREAD_EMBEDDING_BASE_URL` and `PI_SMARTREAD_EMBEDDING_MODEL`, or place a `pi-smartread.config.json` in the working directory.

**Tool returns "Error: Embedding baseUrl is required"** — The `intent_read` tool requires embedding config. Use `read_multiple_files` or `search` for config-free operation, or configure embeddings.

**Configuration changes not taking effect** — Restart Claude Code (or the respective MCP client) after changing config. Run `claude mcp list` to verify connected servers.

---

## Architecture

```
┌─────────────────┐    stdin (JSON-RPC)    ┌──────────────────┐
│   MCP Client    │ ──────────────────────→ │   mcp-server.ts  │
│ (Claude Code,   │                         │                  │
│  Claude Desktop,│ ←────────────────────── │  Tool Registry   │
│  Cursor, etc.)  │   stdout (JSON-RPC)     │  ┌────────────┐ │
└─────────────────┘                         │  │intent_read  │ │
                                            │  │read_many    │ │
                                            │  │repo_map     │ │
                                            │  │search       │ │
                                            │  └────────────┘ │
                                            └──────────────────┘
```

The MCP server is a thin JSON-RPC wrapper. All business logic lives in the same modules used by the Pi extension — no code duplication.
