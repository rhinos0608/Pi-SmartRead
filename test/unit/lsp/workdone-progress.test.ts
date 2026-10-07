import { describe, expect, it, vi } from "vitest";
import {
  SERVER_REQUEST_HANDLERS,
  type ServerRequestContext,
} from "../../../src/lsp/lsp-server-request-handlers.js";

function stubCtx(): ServerRequestContext & { register: ReturnType<typeof vi.fn> } {
  const register = vi.fn();
  const ctx = {
    replyClientRequest: vi.fn(async () => {}),
    retainApplyEditProposal: vi.fn(),
    openDocumentText: vi.fn(async () => null),
    getConfigurationSettings: () => null,
    registerWorkDoneToken: register,
  } as unknown as ServerRequestContext & { register: ReturnType<typeof vi.fn> };
  (ctx as unknown as { register: unknown }).register = register;
  return ctx;
}

describe("window/workDoneProgress/create handler", () => {
  it("is registered in the dispatch map", () => {
    expect(SERVER_REQUEST_HANDLERS.get("window/workDoneProgress/create")).toBeTypeOf("function");
  });

  it("registers a valid string token and returns null", () => {
    const ctx = stubCtx();
    const handler = SERVER_REQUEST_HANDLERS.get("window/workDoneProgress/create")!;
    const result = handler({ token: "build-1" }, ctx);
    expect(result).toBeNull();
    expect(ctx.registerWorkDoneToken).toHaveBeenCalledWith("build-1");
  });

  it("registers a numeric token as its string form and returns null", () => {
    const ctx = stubCtx();
    const handler = SERVER_REQUEST_HANDLERS.get("window/workDoneProgress/create")!;
    const result = handler({ token: 42 }, ctx);
    expect(result).toBeNull();
    expect(ctx.registerWorkDoneToken).toHaveBeenCalledWith("42");
  });

  it("returns null without registering on missing token", () => {
    const ctx = stubCtx();
    const handler = SERVER_REQUEST_HANDLERS.get("window/workDoneProgress/create")!;
    const result = handler({}, ctx);
    expect(result).toBeNull();
    expect(ctx.registerWorkDoneToken).not.toHaveBeenCalled();
  });

  it("returns null without registering or throwing on null params", () => {
    const ctx = stubCtx();
    const handler = SERVER_REQUEST_HANDLERS.get("window/workDoneProgress/create")!;
    let result: unknown;
    expect(() => {
      result = handler(null, ctx);
    }).not.toThrow();
    expect(result).toBeNull();
    expect(ctx.registerWorkDoneToken).not.toHaveBeenCalled();
  });

  it("returns null without throwing when registerWorkDoneToken is absent", () => {
    const ctx = stubCtx();
    delete (ctx as unknown as Record<string, unknown>).registerWorkDoneToken;
    const handler = SERVER_REQUEST_HANDLERS.get("window/workDoneProgress/create")!;
    let result: unknown;
    expect(() => {
      result = handler({ token: "late-token" }, ctx);
    }).not.toThrow();
    expect(result).toBeNull();
  });
});
