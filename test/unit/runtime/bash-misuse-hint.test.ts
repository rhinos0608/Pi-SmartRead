import { describe, expect, it } from "vitest";
import { detectBashMisuseHint } from "../../../src/runtime/bash-misuse-hint.js";

describe("detectBashMisuseHint", () => {
  it("flags grep family with safe literal", () => {
    expect(detectBashMisuseHint("grep -rn foo src")).toContain("grep({ pattern:");
    expect(detectBashMisuseHint("rg foo")).toContain("grep(");
    expect(detectBashMisuseHint("ag foo")).toContain("grep(");
    expect(detectBashMisuseHint("ack foo")).toContain("grep(");
    expect(detectBashMisuseHint("egrep foo")).toContain("grep(");
  });

  it("uses placeholder for unsafe pattern", () => {
    const hint = detectBashMisuseHint("grep -rn 'foo; rm -rf /' src");
    expect(hint).toContain('"symbol"');
    expect(hint).not.toContain("rm -rf");
  });

  it("keeps quoted metachars as one token (no split)", () => {
    expect(detectBashMisuseHint("grep -rn 'a|b' src")).toContain("grep(");
    expect(detectBashMisuseHint('grep "a && b" src')).toContain("grep(");
  });

  it("flags git grep but allows git log -S history", () => {
    expect(detectBashMisuseHint("git grep foo")).toContain("grep(");
    expect(detectBashMisuseHint("git log -S foo --oneline")).toBeNull();
  });

  it("flags find -exec grep and find | xargs grep", () => {
    expect(detectBashMisuseHint("find src -type f -exec grep -l foo {} +")).toContain("grep(");
    expect(detectBashMisuseHint("find src -type f | xargs grep foo")).toContain("grep(");
  });

  it("flags python -c scans", () => {
    expect(
      detectBashMisuseHint("python3 -c \"import pathlib; print(open('a').read())\""),
    ).toContain("grep(");
    expect(detectBashMisuseHint("python3 -c \"import ast; ast.parse(open('a').read())\"")).toContain(
      "grep(",
    );
    expect(detectBashMisuseHint("python3 -c \"print(1 + 1)\"")).toBeNull();
  });

  it("suggests read for file printers", () => {
    expect(detectBashMisuseHint("cat src/a.ts")).toContain("read({ path:");
    expect(detectBashMisuseHint("head -n 20 src/a.ts")).toContain("read({ path:");
    expect(detectBashMisuseHint("sed -n '1,50p' src/a.ts")).toContain("read({ path:");
    expect(detectBashMisuseHint("awk '{print $1}' src/a.ts")).toContain("read({ path:");
  });

  it("suggests inspect directory for repo scans", () => {
    expect(detectBashMisuseHint("ls -R src")).toContain('inspect({ mode: "directory"');
    expect(detectBashMisuseHint("tree src")).toContain('inspect({ mode: "directory"');
    expect(detectBashMisuseHint("find src -name '*.ts'")).toContain('inspect({ mode: "directory"');
  });

  it("suggests navigate for symbol-decl search", () => {
    const hint = detectBashMisuseHint("rg 'function myHandler'");
    expect(hint).toContain("navigate");
    expect(hint).toContain("references");
    expect(hint).toContain("line: 12, character: 1");
  });

  it("flags dependent chase but not independent searches", () => {
    const dep = detectBashMisuseHint("rg -l foo src | xargs grep -n bar | xargs sed -n '1,10p'");
    expect(dep).toContain('inspect({ mode: "script"');
    expect(detectBashMisuseHint("rg foo && rg bar")).not.toContain("script");
  });

  it("exempts runners and git write ops", () => {
    expect(detectBashMisuseHint("npm test")).toBeNull();
    expect(detectBashMisuseHint("git status")).toBeNull();
    expect(detectBashMisuseHint("git diff HEAD")).toBeNull();
    expect(detectBashMisuseHint("npx vitest run a.test.ts")).toBeNull();
  });

  it("allows grep filtering of test output", () => {
    expect(detectBashMisuseHint("npm test 2>&1 | grep FAIL")).toBeNull();
  });

  it("suppresses mutations and redirections", () => {
    expect(detectBashMisuseHint("rm -rf dist")).toBeNull();
    expect(detectBashMisuseHint("grep foo src > out.txt")).toBeNull();
    // tee suppresses only its own segment; the grep segment still hints
    expect(detectBashMisuseHint("grep foo src | tee out.txt")).toContain("grep(");
    expect(detectBashMisuseHint("sed -i 's/a/b/' src/a.ts")).toBeNull();
    // fd dup is not suppression
    expect(detectBashMisuseHint("npm test 2>&1 | grep FAIL")).toBeNull();
    expect(detectBashMisuseHint("grep foo src 2>&1")).toContain("grep(");
  });

  it("handles mixed chains: flags bad segment", () => {
    const hint = detectBashMisuseHint("git status && rg foo");
    expect(hint).toContain("grep(");
  });

  it("strips cd chains, env assignments, prefixes", () => {
    expect(detectBashMisuseHint("cd src && rg foo")).toContain("grep(");
    expect(detectBashMisuseHint("FOO=bar rg foo")).toContain("grep(");
    expect(detectBashMisuseHint("env FOO=bar rg foo")).toContain("grep(");
  });

  it("fail-closed on malformed shell", () => {
    expect(detectBashMisuseHint("rg 'unclosed foo")).toBeNull();
    expect(detectBashMisuseHint("echo $(rg foo)")).toBeNull();
    expect(detectBashMisuseHint("echo `rg foo`")).toBeNull();
    expect(detectBashMisuseHint("cat <<EOF")).toBeNull();
  });

  it("returns null on exit 126/127", () => {
    expect(detectBashMisuseHint("rg foo", 126)).toBeNull();
    expect(detectBashMisuseHint("rg foo", 127)).toBeNull();
    expect(detectBashMisuseHint("rg foo", 1)).toContain("grep(");
  });

  it("bounds input length", () => {
    expect(detectBashMisuseHint("rg " + "a".repeat(5000))).toBeNull();
  });

  it("ignores output content", () => {
    expect(detectBashMisuseHint("rg foo", 0, "rm -rf /")).toContain("grep(");
  });

  it("omits unsafe filenames from read hint (quote injection)", () => {
    const hint = detectBashMisuseHint(`cat 'a"b.ts'`)!;
    expect(hint).toContain("read({ path:");
    expect(hint).toContain('"src/file.ts"');
    expect(hint).not.toContain('a"b.ts');
    const sedHint = detectBashMisuseHint(`sed -n '1,50p' 'a"b.ts'`)!;
    expect(sedHint).toContain('"src/file.ts"');
    expect(sedHint).not.toContain('a"b.ts');
    const backslashHint = detectBashMisuseHint("cat 'a\\\\b.ts'")!;
    expect(backslashHint).toContain('"src/file.ts"');
  });

  it("falls back on control-char filenames (tab/DEL)", () => {
    const hint = detectBashMisuseHint("cat 'a\tb.ts'")!;
    expect(hint).toContain('"src/file.ts"');
    expect(hint).not.toContain("\t");
    const delHint = detectBashMisuseHint("cat 'a\x7fb.ts'")!;
    expect(delHint).toContain('"src/file.ts"');
    expect(delHint).not.toContain("\x7f");
  });

  it("footer format is compact single hint", () => {
    const hint = detectBashMisuseHint("rg foo")!;
    expect(hint.startsWith("\n\n[SmartRead hint]")).toBe(true);
    expect(hint).not.toContain("rg foo");
  });
});
