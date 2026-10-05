/**
 * Judge wire types — shared SystemOne shape (cloud Jev via OpenRouter,
 * local von sidecar) plus the `Judge` batching interface.
 */

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

export interface NoulCriteria {
    true: string;
    false: string;
}

export interface NoulQuestion {
    type: "noul";
    instructions: string;
    criteria?: NoulCriteria;
}

export interface ChoiceQuestion {
    type: "choice";
    instructions: string;
    options: string[];
    criteria?: Record<string, string>;
}

export type JudgeQuestion = NoulQuestion | ChoiceQuestion;

export interface JudgeRequest {
    model: string;
    state: Record<string, JsonValue>;
    questions: Record<string, JudgeQuestion>;
}

/**
 * A single noul answer. The von sidecar returns per-answer detail objects
 * carrying both the banded commit (`noul`) and the pre-band posterior
 * (`noul_raw`); cloud Jev returns plain numbers.
 *
 * Measured (von spike, code-relevance probe): banding snaps near-ties to
 * 0.80/0.20 and overstates confidence, so gates over local results must use
 * `noul_raw` when present. Banded outputs are never mapped into calibrated
 * confidence without eval evidence; von stays experimental pending audit.
 */
export interface NoulAnswerDetail {
    noul: number;
    noul_raw?: number;
}

export type JudgeAnswer = number | string | NoulAnswerDetail;

export type JudgeAnswers = Record<string, JudgeAnswer>;

/**
 * Probability exposed to gates. Local backends prefer the pre-band
 * `noul_raw`; all other backends use the banded `noul`. Returns undefined
 * for non-noul (choice) answers.
 */
export function answerProbability(answer: JudgeAnswer, preferRaw: boolean): number | undefined {
    if (typeof answer === "number") return answer;
    if (typeof answer === "string") return undefined;
    if (preferRaw && typeof answer.noul_raw === "number" && Number.isFinite(answer.noul_raw)) {
        return answer.noul_raw;
    }
    return answer.noul;
}

export interface JudgeUsage {
    inputTokens: number;
    costUsd?: number;
    requests: number;
}

export type JudgeErrorCode =
    | "no_key"
    | "endpoint_not_allowed"
    | "oauth_only"
    | "timeout"
    | "network"
    | `http_${number}`
    | "bad_response"
    | "sidecar_unavailable"
    | "warming"
    | "unit_too_large"
    | "aborted";

export class JudgeError extends Error {
    readonly code: JudgeErrorCode;
    constructor(code: JudgeErrorCode, message?: string) {
        super(message ?? code);
        this.name = "JudgeError";
        this.code = code;
    }
}

export interface JudgeBackendInfo {
    backend: "cloud" | "local";
    model: string;
    baseUrl: string;
}

export interface JudgeNoulItem {
    id: string;
    state: Record<string, JsonValue>;
    question: (stateRef: string) => NoulQuestion;
}

export interface JudgeNoulInput {
    shared: Record<string, JsonValue>;
    items: JudgeNoulItem[];
}

export interface JudgeNoulResult {
    p: Map<string, number>;
    unjudged: Array<{ id: string; code: string }>;
    usage: JudgeUsage;
    cacheHits: number;
}

export interface Judge {
    readonly info: JudgeBackendInfo;
    judgeNouls(input: JudgeNoulInput, signal?: AbortSignal): Promise<JudgeNoulResult>;
}
