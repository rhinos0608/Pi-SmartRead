import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resetSessionState } from "../../src/hook.js";

export interface IndexHarness {
  registered: { name: string; execute: unknown }[];
  handlers: Record<string, (...args: any[]) => any>;
  api: ExtensionAPI;
}

type RegisterExtension = (pi: ExtensionAPI) => void | Promise<void>;

/** Shared makeApi fixture: fresh session state + dynamic import + registered/handlers capture. */
export async function setupExtension(): Promise<IndexHarness> {
  resetSessionState();
  const mod = await import("../../src/index.js");
  const registerExtension = mod.default as unknown as RegisterExtension;
  const registered: { name: string; execute: unknown }[] = [];
  const handlers: Record<string, (...args: any[]) => any> = {};
  const api = {
    registerTool: (definition: { name: string; execute: unknown }) => {
      registered.push(definition);
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  await (registerExtension as RegisterExtension)(api);
  return { registered, handlers, api };
}
