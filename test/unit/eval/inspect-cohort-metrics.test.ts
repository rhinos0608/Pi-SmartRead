import { describe, expect, it } from "vitest";
import { aggregateInspectMetrics, type InspectRunMetrics } from "../../../scripts/eval/inspect-cohort/metrics.js";

describe("inspect cohort metrics", () => {
    it("keeps outer calls, inner steps, setup, bytes, cost and stamped latency separate", () => {
        const runs: InspectRunMetrics[] = [{
            taskId: "t1", eligiblePositive: true, passed: true, outerAgentCalls: 3,
            innerEngineSteps: 7, indexSetupMs: 11, bytesRead: 120, modelCost: 0.4,
            toolCost: 0.1, coldLatencyMs: 500, warmLatencyMs: 200, inputTokens: 8,
            outputTokens: 4, invalidCalls: 1, overRouting: 2, lostPrior: false,
            falseCompleteness: true,
        }];
        expect(aggregateInspectMetrics(runs)).toMatchObject({
            outerAgentCalls: 3, innerEngineSteps: 7, indexSetupMs: 11, bytesRead: 120,
            modelCost: 0.4, toolCost: 0.1, coldLatencyMs: 500, warmLatencyMs: 200,
            falseCompletenessRate: 1, falseCompletenessDenominator: 1,
        });
    });
    it("uses task-level majority outcomes over unequal replicate counts", () => {
        const base: InspectRunMetrics = { taskId: "a", eligiblePositive: true, passed: false,
            outerAgentCalls: 0, innerEngineSteps: 0, indexSetupMs: 0, bytesRead: 0,
            modelCost: 0, toolCost: 0, coldLatencyMs: null, warmLatencyMs: null,
            inputTokens: 0, outputTokens: 0, invalidCalls: 0, overRouting: 0,
            lostPrior: false, falseCompleteness: false };
        const taskA = [base, { ...base, passed: true, falseCompleteness: true }, { ...base, passed: true, falseCompleteness: true }];
        const taskB = [{ ...base, taskId: "b", eligiblePositive: false, passed: true, lostPrior: true }];
        const aggregate = aggregateInspectMetrics([...taskA, ...taskB]);
        expect(aggregate.falseCompletenessDenominator).toBe(1);
        expect(aggregate.falseCompletenessRate).toBe(1);
        expect(aggregate.taskSuccessRate).toBe(1);
        expect(aggregate.lostPriors).toBe(1);
    });

    it("counts eligible positive logical tasks, not replicate rows", () => {
        const base: InspectRunMetrics = { taskId: "t", eligiblePositive: true, passed: false,
            outerAgentCalls: 0, innerEngineSteps: 0, indexSetupMs: 0, bytesRead: 0,
            modelCost: 0, toolCost: 0, coldLatencyMs: null, warmLatencyMs: null,
            inputTokens: 0, outputTokens: 0, invalidCalls: 0, overRouting: 0,
            lostPrior: false, falseCompleteness: false };
        const runs = [base, { ...base, falseCompleteness: true }, { ...base, falseCompleteness: true },
            { ...base, taskId: "u", falseCompleteness: true }];
        expect(aggregateInspectMetrics(runs).falseCompletenessDenominator).toBe(2);
        expect(aggregateInspectMetrics(runs).falseCompletenessRate).toBe(1);
    });
});
