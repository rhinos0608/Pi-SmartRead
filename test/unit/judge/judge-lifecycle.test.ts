import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivationState, registerShutdownHandler } from "../../../src/extension-lifecycle.js";
import { registerJudgeCommandStep } from "../../../src/extension-registration.js";
import { getSharedVonSidecarManager, resetVonSidecarForTests } from "../../../src/judge/von-sidecar.js";

afterEach(() => {
    resetVonSidecarForTests();
});

describe("judge lifecycle wiring", () => {
    it("activation state carries an empty judge dispose slot", () => {
        expect(createActivationState().judgeSidecarDispose).toBeNull();
    });

    it("registerJudgeCommandStep registers /judge and arms sidecar shutdown without starting anything", () => {
        const commands: string[] = [];
        const pi = {
            registerCommand: (name: string, _options: unknown) => { commands.push(name); },
        } as never;
        const state = createActivationState();
        registerJudgeCommandStep(pi, state);
        expect(commands).toEqual(["judge"]);
        expect(state.judgeSidecarDispose).toBeTypeOf("function");
        // Factory time starts no process: the shared manager is idle.
        expect(getSharedVonSidecarManager().getStatus()).toMatchObject({ running: false });
    });

    it("registerJudgeCommandStep tolerates hosts without registerCommand", () => {
        const state = createActivationState();
        expect(() => registerJudgeCommandStep({} as never, state)).not.toThrow();
    });

    it("session_shutdown runs the judge dispose hook", async () => {
        const handlers: Record<string, (event: unknown) => unknown> = {};
        const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers[event] = handler; } } as never;
        const state = createActivationState();
        const dispose = vi.fn();
        state.judgeSidecarDispose = dispose;
        registerShutdownHandler(pi, state);
        await handlers.session_shutdown!({} as never);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(state.judgeSidecarDispose).toBeNull();
    });

    it("a throwing judge dispose does not fail shutdown", async () => {
        const handlers: Record<string, (event: unknown) => unknown> = {};
        const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers[event] = handler; } } as never;
        const state = createActivationState();
        state.judgeSidecarDispose = () => { throw new Error("kill failed"); };
        registerShutdownHandler(pi, state);
        await expect(handlers.session_shutdown!({} as never)).resolves.toBeUndefined();
    });
});
