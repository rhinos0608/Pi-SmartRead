/**
 * Tests for language detection.
 */
import { describe, it, expect } from "vitest";
import {
  filenameToLang,
  extToLang,
  isSupportedFile,
  getSupportedExtensions,
} from "../../languages.js";

describe("filenameToLang", () => {
  it("detects TypeScript", () => {
    expect(filenameToLang("file.ts")).toBe("typescript");
  });

  it("detects TSX", () => {
    expect(filenameToLang("component.tsx")).toBe("tsx");
  });

  it("detects JavaScript", () => {
    expect(filenameToLang("file.js")).toBe("javascript");
    expect(filenameToLang("file.jsx")).toBe("javascript");
    expect(filenameToLang("file.mjs")).toBe("javascript");
  });

  it("detects Python", () => {
    expect(filenameToLang("file.py")).toBe("python");
    expect(filenameToLang("file.pyi")).toBe("python");
  });

  it("detects Rust", () => {
    expect(filenameToLang("file.rs")).toBe("rust");
  });

  it("detects Go", () => {
    expect(filenameToLang("file.go")).toBe("go");
  });

  it("detects Java", () => {
    expect(filenameToLang("File.java")).toBe("java");
  });

  it("detects C++", () => {
    expect(filenameToLang("file.cpp")).toBe("cpp");
    expect(filenameToLang("file.hpp")).toBe("cpp");
    expect(filenameToLang("file.cc")).toBe("cpp");
  });

  it("detects C", () => {
    expect(filenameToLang("file.c")).toBe("c");
    expect(filenameToLang("file.h")).toBe("c");
  });

  it("detects Ruby", () => {
    expect(filenameToLang("file.rb")).toBe("ruby");
  });

  it("detects PHP", () => {
    expect(filenameToLang("file.php")).toBe("php");
  });

  it("detects Swift", () => {
    expect(filenameToLang("file.swift")).toBe("swift");
  });

  it("detects Kotlin", () => {
    expect(filenameToLang("file.kt")).toBe("kotlin");
    expect(filenameToLang("file.kts")).toBe("kotlin");
  });

  it("detects Dart", () => {
    expect(filenameToLang("file.dart")).toBe("dart");
  });

  it("detects Bash", () => {
    expect(filenameToLang("script.sh")).toBe("bash");
    expect(filenameToLang("script.bash")).toBe("bash");
    expect(filenameToLang("script.zsh")).toBe("bash");
  });

  it("detects CSS", () => {
    expect(filenameToLang("styles.css")).toBe("css");
    expect(filenameToLang("styles.scss")).toBe("css");
    expect(filenameToLang("styles.less")).toBe("css");
  });

  it("returns undefined for unsupported extensions", () => {
    expect(filenameToLang("file.xyz")).toBeUndefined();
    expect(filenameToLang("file")).toBeUndefined();
    expect(filenameToLang(".gitignore")).toBeUndefined();
  });

  it("handles paths with directories", () => {
    expect(filenameToLang("src/utils/helper.ts")).toBe("typescript");
    expect(filenameToLang("/absolute/path/main.py")).toBe("python");
  });
});

describe("extToLang", () => {
  it("maps .ts to typescript", () => {
    expect(extToLang(".ts")).toBe("typescript");
  });

  it("is case-insensitive (.TS resolves to typescript)", () => {
    expect(extToLang(".TS")).toBe("typescript");
  });

  it("handles .h for C", () => {
    expect(extToLang(".h")).toBe("c");
  });
});


describe("isSupportedFile", () => {
  it("returns true for supported files", () => {
    expect(isSupportedFile("main.ts")).toBe(true);
    expect(isSupportedFile("main.py")).toBe(true);
    expect(isSupportedFile("script.sh")).toBe(true);
    expect(isSupportedFile("styles.css")).toBe(true);
  });

  it("returns false for unsupported files", () => {
    expect(isSupportedFile("readme.md")).toBe(false);
    expect(isSupportedFile("Makefile")).toBe(false);
  });
});

describe("getSupportedExtensions", () => {
  it("returns all supported extensions", () => {
    const exts = getSupportedExtensions();
    expect(exts).toContain(".ts");
    expect(exts).toContain(".py");
    expect(exts).toContain(".rs");
    expect(exts).toContain(".go");
    expect(exts.length).toBeGreaterThan(30);
  });
});
