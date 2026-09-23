/** Pure bash-misuse classifier. No I/O, no exec, no file reads. */

const MAX_COMMAND_LENGTH = 4000;

const SEARCH_BINARIES = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const TEST_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "vitest",
  "node",
  "cargo",
  "go",
  "make",
  "tsc",
  "eslint",
]);
const GIT_WRITE_OK = new Set([
  "status",
  "diff",
  "commit",
  "add",
  "push",
  "pull",
  "checkout",
  "branch",
  "rebase",
  "stash",
]);
const FILE_READERS = new Set(["cat", "head", "tail"]);

interface Segment {
  argv: string[];
  hadRedirection: boolean;
  pipeFromPrev: boolean;
  chainedToPrev: boolean;
}

function basename(cmd: string): string {
  const parts = cmd.split("/");
  return parts[parts.length - 1] ?? cmd;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isSafePatternLiteral(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= 60 && /^[\w.:/\-]+$/.test(pattern);
}

function isSafePathLiteral(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (/["\\\n\r]/.test(path)) return false;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function formatReadPath(file: string | undefined): string {
  if (file !== undefined && isSafePathLiteral(file)) return `"${file}"`;
  return `"src/file.ts"`;
}

function grepHint(pattern?: string): string {
  if (pattern !== undefined && isSafePatternLiteral(pattern)) {
    return `\n\n[SmartRead hint] Use grep({ pattern: "${pattern}" }) instead of shell search.`;
  }
  return `\n\n[SmartRead hint] Use grep({ pattern: "symbol" }) instead of shell search.`;
}

/** Lex + split into pipeline segments. Returns null on fail-closed input. */
function lexSegments(command: string): Segment[] | null {
  const segments: Segment[] = [];
  let argv: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hadRedirection = false;
  let pipeFromPrev = false;
  let chainedToPrev = false;
  let pendingPipe = false;
  let pendingChain = false;
  let tokenStarted = false;

  const pushToken = (): void => {
    if (tokenStarted) {
      argv.push(current);
      current = "";
      tokenStarted = false;
    }
  };
  const pushSegment = (): void => {
    pushToken();
    if (argv.length > 0 || hadRedirection) {
      segments.push({ argv, hadRedirection, pipeFromPrev, chainedToPrev });
    }
    argv = [];
    hadRedirection = false;
    pipeFromPrev = pendingPipe;
    chainedToPrev = pendingChain;
    pendingPipe = false;
    pendingChain = false;
  };

  const failClosed = (): null => {
    if (inSingle || inDouble || escaped) return null;
    return null;
  };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (!inSingle) {
        escaped = true;
        tokenStarted = true;
        i += 1;
        continue;
      }
      current += ch;
      tokenStarted = true;
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      tokenStarted = true;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      tokenStarted = true;
      i += 1;
      continue;
    }
    if (inSingle || inDouble) {
      current += ch;
      i += 1;
      continue;
    }
    // Unquoted metacharacter checks (fail-closed).
    if (ch === "`") return failClosed();
    if (ch === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) return null;
    if (ch === "<" && command[i + 1] === "<") return null;
    if (ch === "|" && command[i + 1] === "|") {
      pendingPipe = false;
      pendingChain = true;
      pushSegment();
      i += 2;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      pendingPipe = false;
      pendingChain = true;
      pushSegment();
      i += 2;
      continue;
    }
    if (ch === "|") {
      pendingPipe = true;
      pendingChain = true;
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pendingPipe = false;
      pendingChain = false;
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === ">") {
      // Allow fd-duplication forms like 2>&1, 1>&2, >&2.
      const rest = command.slice(i);
      const dup = rest.match(/^(\d*)>&\d+/);
      if (dup) {
        i += dup[0].length;
        continue;
      }
      hadRedirection = true;
      pushToken();
      i += command[i + 1] === ">" ? 2 : 1;
      continue;
    }
    if (ch === "<") {
      // Single < is redirection; << already rejected above.
      hadRedirection = true;
      pushToken();
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushToken();
      i += 1;
      continue;
    }
    current += ch;
    tokenStarted = true;
    i += 1;
  }
  if (inSingle || inDouble || escaped) return null;
  pushSegment();
  return segments.filter((s) => s.argv.length > 0 || s.hadRedirection);
}

function stripWrapper(argv: string[]): string[] | null {
  let tokens = [...argv];
  // Leading cd … chains are pre-stripped at the segment level by the caller;
  // here handle env assignments + prefixes + one bash -lc wrapper.
  while (tokens.length > 0 && isEnvAssignment(tokens[0]!)) tokens = tokens.slice(1);
  while (tokens.length > 0 && ["env", "time", "command"].includes(basename(tokens[0]!))) {
    tokens = tokens.slice(1);
    while (tokens.length > 0 && isEnvAssignment(tokens[0]!)) tokens = tokens.slice(1);
  }
  if (
    tokens.length >= 3 &&
    basename(tokens[0]!) === "bash" &&
    (tokens[1] === "-lc" || tokens[1] === "-c")
  ) {
    const inner = tokens.slice(2).join(" ");
    const innerSegments = lexSegments(inner);
    if (!innerSegments || innerSegments.length !== 1) return null;
    return innerSegments[0]!.argv;
  }
  if (tokens.length >= 2 && basename(tokens[0]!) === "bash" && tokens[1]!.startsWith("-")) {
    return null;
  }
  return tokens;
}

function firstPattern(argv: string[]): string | undefined {
  for (const token of argv.slice(1)) {
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function isDeclPattern(pattern: string): boolean {
  return /^(function|class|interface|type|def|const|fn|struct)\s+\w+/.test(pattern) ||
    /^[A-Z][A-Za-z]*[a-z][A-Za-z0-9_]*$/.test(pattern);
}

export function detectBashMisuseHint(
  command: string,
  exitCode?: number,
  _output?: string,
): string | null {
  void _output;
  if (exitCode === 126 || exitCode === 127) return null;
  if (command.length > MAX_COMMAND_LENGTH) return null;
  if (command.trim() === "") return null;

  const rawSegments = lexSegments(command);
  if (!rawSegments) return null;

  // Pre-strip leading `cd … &&` chains: drop leading segments that are only `cd`.
  let segments = rawSegments;
  while (
    segments.length > 1 &&
    segments[0]!.argv.length > 0 &&
    basename(segments[0]!.argv[0]!) === "cd"
  ) {
    segments = segments.slice(1).map((s, idx) =>
      idx === 0 ? { ...s, pipeFromPrev: false, chainedToPrev: false } : s,
    );
  }

  const parsed: Segment[] = [];
  for (const seg of segments) {
    if (seg.argv.length === 0) continue;
    const stripped = stripWrapper(seg.argv);
    if (stripped === null || stripped.length === 0) continue;
    parsed.push({ ...seg, argv: stripped });
  }
  if (parsed.length === 0) return null;

  const executableOf = (seg: Segment): string => basename(seg.argv[0]!);

  // Suppression + exemption pre-pass per segment.
  const live: Segment[] = [];
  for (const seg of parsed) {
    const exe = executableOf(seg);
    if (seg.hadRedirection) continue;
    if (exe === "tee" || exe === "rm") continue;
    if (exe === "sed" && seg.argv.includes("-i")) continue;
    if (exe === "git" && seg.argv[1] === "log" && seg.argv.includes("-S")) continue;
    if (TEST_RUNNERS.has(exe)) continue;
    if (exe === "git" && seg.argv[1] !== undefined && GIT_WRITE_OK.has(seg.argv[1]!)) continue;
    // grep filtering allowlisted-command stdout: `runner … | grep …` → drop grep.
    if (SEARCH_BINARIES.has(exe) && seg.pipeFromPrev) {
      const prev = parsed[parsed.indexOf(seg) - 1];
      if (prev && TEST_RUNNERS.has(basename(prev.argv[0]!))) continue;
    }
    live.push(seg);
  }
  if (live.length === 0) return null;

  // Dependent pipeline/chase: 3+ dependent segments feeding discovered paths
  // into further searches (not independent `rg a && rg b`).
  if (live.length >= 3) {
    let discoveryCount = 0;
    let consumerCount = 0;
    for (let sIdx = 0; sIdx < live.length; sIdx += 1) {
      const dseg = live[sIdx]!;
      const exe = executableOf(dseg);
      const args = dseg.argv.slice(1).join(" ");
      const isDiscovery =
        SEARCH_BINARIES.has(exe) ||
        (exe === "find") ||
        (exe === "git" && dseg.argv[1] === "grep") ||
        ((exe === "ls" || exe === "tree") && /-R|--files/.test(args)) ||
        (exe === "xargs");
      const isConsumer =
        (exe === "xargs") ||
        SEARCH_BINARIES.has(exe) ||
        FILE_READERS.has(exe) ||
        (exe === "sed" && dseg.argv.includes("-n")) ||
        (exe === "awk") ||
        (dseg.pipeFromPrev && (exe === "cat" || exe === "head" || exe === "tail"));
      if (isDiscovery && (sIdx === 0 || dseg.pipeFromPrev || dseg.chainedToPrev)) discoveryCount += 1;
      if (isConsumer && (dseg.pipeFromPrev || dseg.chainedToPrev)) consumerCount += 1;
    }
    const allChained = live.slice(1).every((s) => s.pipeFromPrev || s.chainedToPrev);
    if (allChained && discoveryCount >= 1 && consumerCount >= 2) {
      return `\n\n[SmartRead hint] Chain feeds discovered paths into further searches. Use inspect({ mode: "script", script: "..." }) for the dependent chase in one call.`;
    }
  }

  // find -exec grep/rg OR find | xargs grep/rg.
  for (let idx = 0; idx < live.length; idx += 1) {
    const seg = live[idx]!;
    const exe = executableOf(seg);
    if (exe === "find") {
      const args = seg.argv.slice(1);
      const execIdx = args.indexOf("-exec");
      if (execIdx >= 0 && args.slice(execIdx).some((t) => SEARCH_BINARIES.has(basename(t)))) {
        return grepHint(undefined);
      }
      const next = live[idx + 1];
      if (
        next &&
        next.pipeFromPrev &&
        basename(next.argv[0]!) === "xargs" &&
        next.argv.slice(1).some((t) => SEARCH_BINARIES.has(basename(t)))
      ) {
        return grepHint(undefined);
      }
    }
  }

  for (const seg of live) {
    const exe = executableOf(seg);
    const args = seg.argv.slice(1);

    if (exe === "git" && seg.argv[1] === "grep") {
      const pattern = firstPattern(["git", ...args.slice(1)]);
      if (pattern !== undefined && isDeclPattern(pattern)) {
        return `\n\n[SmartRead hint] Search symbol declarations with grep({ pattern: "symbol" }) first, then inspect({ mode: "navigate", path: "...", navigation: { operation: "references", line: 12, character: 1 } }) (1-based). Uppercase LSP is available for proposals only.`;
      }
      return grepHint(pattern);
    }

    if (SEARCH_BINARIES.has(exe)) {
      const pattern = firstPattern(seg.argv);
      if (pattern !== undefined && isDeclPattern(pattern)) {
        return `\n\n[SmartRead hint] Search symbol declarations with grep({ pattern: "symbol" }) first, then inspect({ mode: "navigate", path: "...", navigation: { operation: "references", line: 12, character: 1 } }) (1-based). Uppercase LSP is available for proposals only.`;
      }
      return grepHint(pattern);
    }

    if ((exe === "python" || exe === "python3") && args.includes("-c")) {
      const code = args.join(" ");
      if (
        code.includes("open(") ||
        code.includes("ast.parse") ||
        code.includes("rglob") ||
        (code.includes("pathlib") && code.includes("re")) ||
        (code.includes("os.walk"))
      ) {
        return `\n\n[SmartRead hint] Use grep({ pattern: "symbol" }) or inspect({ mode: "file", path: "..." }) instead of python -c file scans.`;
      }
      continue;
    }

    if (FILE_READERS.has(exe) && args.length > 0) {
      const file = [...args].reverse().find((t) => !t.startsWith("-"));
      if (file !== undefined) {
        return `\n\n[SmartRead hint] Use read({ path: ${formatReadPath(file)} }) instead of shell file printing.`;
      }
      continue;
    }
    if (exe === "sed" && args.includes("-n")) {
      const file = args[args.length - 1]!;
      if (!file.startsWith("-")) {
        return `\n\n[SmartRead hint] Use read({ path: ${formatReadPath(file)}, offset: 1, limit: 50 }) instead of sed -n line printing.`;
      }
      return `\n\n[SmartRead hint] Use read({ path: "file", offset: 1, limit: 50 }) instead of sed -n line printing.`;
    }
    if (exe === "awk" && /print/.test(args.join(" "))) {
      const file = [...args].reverse().find((t) => !t.startsWith("-") && t !== "print" && !t.includes("{"));
      if (file !== undefined) {
        return `\n\n[SmartRead hint] Use read({ path: ${formatReadPath(file)} }) instead of awk line printing.`;
      }
      return `\n\n[SmartRead hint] Use read({ path: "file" }) instead of awk line printing.`;
    }

    if (
      (exe === "ls" && (args.includes("-R") || args.includes("-r"))) ||
      (exe === "tree") ||
      (exe === "find" && (args.includes("-name") || args.includes("-type")))
    ) {
      return `\n\n[SmartRead hint] Use inspect({ mode: "directory", path: "." }) for repo scans. Shell listing is fine when an exhaustive listing is needed.`;
    }
  }

  return null;
}
