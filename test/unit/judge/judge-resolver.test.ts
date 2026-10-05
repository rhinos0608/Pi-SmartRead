import { describe, expect, it } from "vitest";
import { resolveJudge, type ResolveJudgeDeps } from "../../../src/judge/judge-resolver.js";

function deps(over: Partial<ResolveJudgeDeps>): ResolveJudgeDeps {
    return { surface: "pi", env: {}, readSettings: () => ({ mode: "off" }), ...over };
}

describe("judge-resolver", () => {
    it("pi: off by default", async () => {
        expect(await resolveJudge(deps({}))).toEqual({ unavailable: expect.any(String) });
    });

    it("pi cloud: oauth-only provider yields oauth_only", async () => {
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "cloud" }),
            isOpenRouterOAuth: () => true,
            getOpenRouterKey: async () => undefined,
        }));
        expect(res).toEqual({ unavailable: "oauth_only" });
    });

    it("pi cloud: missing key yields no_key", async () => {
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "cloud" }),
            isOpenRouterOAuth: () => false,
            getOpenRouterKey: async () => undefined,
        }));
        expect(res).toEqual({ unavailable: "no_key" });
    });

    it("pi cloud: store key resolves a cloud judge", async () => {
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "cloud" }),
            isOpenRouterOAuth: () => false,
            getOpenRouterKey: async () => "store-key",
        }));
        expect("judge" in res && res.judge.info).toMatchObject({ backend: "cloud", model: "~typesafe/jev-latest" });
    });

    it("pi cloud: base-URL override never receives the auth-store key", async () => {
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "cloud" }),
            env: { PI_SMARTREAD_JUDGE_BASE_URL: "https://proxy.example.test" },
            isOpenRouterOAuth: () => false,
            getOpenRouterKey: async () => "store-key",
        }));
        // Without an explicit API key the override must not use the store key.
        expect(res).toEqual({ unavailable: "endpoint_not_allowed" });
    });

    it("pi cloud: rejects an explicit API key for a non-OpenRouter endpoint", async () => {
        let storeKeyCalls = 0;
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "cloud" }),
            env: { PI_SMARTREAD_JUDGE_BASE_URL: "https://proxy.example.test", PI_SMARTREAD_JUDGE_API_KEY: "explicit" },
            isOpenRouterOAuth: () => false,
            getOpenRouterKey: async () => { storeKeyCalls++; return "store-key"; },
        }));
        expect(res).toEqual({ unavailable: "endpoint_not_allowed" });
        expect(storeKeyCalls).toBe(0);
    });

    it("pi: env mode takes precedence over the settings file; invalid falls back", async () => {
        const base = deps({
            readSettings: () => ({ mode: "off" }),
            env: { PI_SMARTREAD_JUDGE_MODE: "cloud", PI_SMARTREAD_JUDGE_API_KEY: "k" },
        });
        const res = await resolveJudge(base);
        expect("judge" in res).toBe(true);
        const invalid = await resolveJudge(deps({
            readSettings: () => ({ mode: "off" }),
            env: { PI_SMARTREAD_JUDGE_MODE: "bogus" },
        }));
        expect(invalid).toEqual({ unavailable: expect.any(String) });
    });

    it("mcp: never sends an explicit key to a non-OpenRouter endpoint", async () => {
        const res = await resolveJudge(deps({
            surface: "mcp",
            env: {
                PI_SMARTREAD_JUDGE_MODE: "cloud",
                PI_SMARTREAD_JUDGE_BASE_URL: "https://proxy.example.test",
                PI_SMARTREAD_JUDGE_API_KEY: "env-key",
            },
        }));
        expect(res).toEqual({ unavailable: "endpoint_not_allowed" });
    });

    it("mcp: mode and key from env", async () => {
        const res = await resolveJudge(deps({
            surface: "mcp",
            env: { PI_SMARTREAD_JUDGE_MODE: "cloud", PI_SMARTREAD_JUDGE_API_KEY: "env-key" },
            readSettings: () => { throw new Error("must not read settings on mcp"); },
        }));
        expect("judge" in res && res.judge.info.backend).toBe("cloud");
        const missing = await resolveJudge(deps({
            surface: "mcp",
            env: { PI_SMARTREAD_JUDGE_MODE: "cloud" },
            readSettings: () => ({ mode: "off" }),
        }));
        expect(missing).toEqual({ unavailable: "no_key" });
    });

    it("mcp: defaults to off", async () => {
        expect(await resolveJudge(deps({ surface: "mcp", env: {}, readSettings: () => ({ mode: "cloud" }) }))).toEqual(
            { unavailable: expect.any(String) },
        );
    });

    it("local: env base URL wins over the sidecar", async () => {
        const ensureLocalEndpoint = async () => ({ baseUrl: "http://sidecar:9" });
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "local" }),
            env: { PI_SMARTREAD_JUDGE_BASE_URL: "http://user-run:8" },
            ensureLocalEndpoint,
        }));
        expect("judge" in res && res.judge.info.baseUrl).toBe("http://user-run:8");
    });

    it("local: sidecar unavailable propagates the code", async () => {
        const res = await resolveJudge(deps({
            readSettings: () => ({ mode: "local" }),
            ensureLocalEndpoint: async () => ({ unavailable: "warming" }),
        }));
        expect(res).toEqual({ unavailable: "warming" });
    });

    it("local: no sidecar hook yields sidecar_unavailable", async () => {
        expect(await resolveJudge(deps({ readSettings: () => ({ mode: "local" }) }))).toEqual(
            { unavailable: "sidecar_unavailable" },
        );
    });

    it("model override applies to both backends", async () => {
        const cloud = await resolveJudge(deps({
            readSettings: () => ({ mode: "cloud" }),
            env: { PI_SMARTREAD_JUDGE_MODEL: "custom/jev", PI_SMARTREAD_JUDGE_API_KEY: "k" },
            getOpenRouterKey: async () => "store-key",
        }));
        expect("judge" in cloud && cloud.judge.info.model).toBe("custom/jev");
        const local = await resolveJudge(deps({
            readSettings: () => ({ mode: "local" }),
            env: { PI_SMARTREAD_JUDGE_MODEL: "custom-von", PI_SMARTREAD_JUDGE_BASE_URL: "http://u:8" },
        }));
        expect("judge" in local && local.judge.info.model).toBe("custom-von");
    });
});
