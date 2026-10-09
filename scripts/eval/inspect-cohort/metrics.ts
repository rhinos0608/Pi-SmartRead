export interface InspectRunMetrics {
    taskId: string;
    eligiblePositive: boolean;
    passed: boolean;
    outerAgentCalls: number;
    innerEngineSteps: number;
    indexSetupMs: number;
    bytesRead: number;
    modelCost: number;
    toolCost: number;
    coldLatencyMs: number | null;
    warmLatencyMs: number | null;
    inputTokens: number;
    outputTokens: number;
    invalidCalls: number;
    overRouting: number;
    lostPrior: boolean;
    falseCompleteness: boolean;
}

export interface InspectAggregateMetrics {
    runs: number;
    positiveTaskSuccessRate: number;
    negativeTaskSuccessRate: number;
    outerAgentCalls: number;
    innerEngineSteps: number;
    indexSetupMs: number;
    bytesRead: number;
    modelCost: number;
    toolCost: number;
    inputTokens: number;
    outputTokens: number;
    invalidCallRate: number;
    overRouting: number;
    lostPriors: number;
    falseCompletenessRate: number;
    falseCompletenessDenominator: number;
    coldLatencyMs: number | null;
    warmLatencyMs: number | null;
}

function mean(values: number[]): number | null {
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Aggregate independent counters without merging model, tool, setup, or engine costs. */
export function aggregateInspectMetrics(runs: InspectRunMetrics[]): InspectAggregateMetrics {
    const byTask = new Map<string, InspectRunMetrics[]>();
    for (const run of runs) {
        const taskRuns = byTask.get(run.taskId) ?? [];
        taskRuns.push(run);
        byTask.set(run.taskId, taskRuns);
    }
    const majority = (outcomes: boolean[]): boolean => outcomes.filter(Boolean).length / outcomes.length > 0.5;
    const taskOutcomes = [...byTask.values()].map((taskRuns) => ({
        eligiblePositive: taskRuns.some((run) => run.eligiblePositive),
        passed: majority(taskRuns.map((run) => run.passed)),
        lostPrior: majority(taskRuns.map((run) => run.lostPrior)),
        falseCompleteness: majority(taskRuns.map((run) => run.falseCompleteness)),
    }));
    const positives = taskOutcomes.filter((task) => task.eligiblePositive);
    const negatives = taskOutcomes.filter((task) => !task.eligiblePositive);
    const calls = runs.reduce((sum, run) => sum + run.outerAgentCalls, 0);
    const invalid = runs.reduce((sum, run) => sum + run.invalidCalls, 0);
    return {
        runs: runs.length,
        positiveTaskSuccessRate: positives.length === 0 ? 0 : positives.filter((task) => task.passed).length / positives.length,
        negativeTaskSuccessRate: negatives.length === 0 ? 0 : negatives.filter((task) => task.passed).length / negatives.length,
        outerAgentCalls: calls,
        innerEngineSteps: runs.reduce((sum, run) => sum + run.innerEngineSteps, 0),
        indexSetupMs: runs.reduce((sum, run) => sum + run.indexSetupMs, 0),
        bytesRead: runs.reduce((sum, run) => sum + run.bytesRead, 0),
        modelCost: runs.reduce((sum, run) => sum + run.modelCost, 0),
        toolCost: runs.reduce((sum, run) => sum + run.toolCost, 0),
        inputTokens: runs.reduce((sum, run) => sum + run.inputTokens, 0),
        outputTokens: runs.reduce((sum, run) => sum + run.outputTokens, 0),
        invalidCallRate: calls === 0 ? 0 : invalid / calls,
        overRouting: runs.reduce((sum, run) => sum + run.overRouting, 0),
        lostPriors: taskOutcomes.filter((task) => task.lostPrior).length,
        falseCompletenessRate: positives.length === 0 ? 0 : positives.filter((task) => task.falseCompleteness).length / positives.length,
        falseCompletenessDenominator: positives.length,
        coldLatencyMs: mean(runs.map((run) => run.coldLatencyMs).filter((value): value is number => value !== null)),
        warmLatencyMs: mean(runs.map((run) => run.warmLatencyMs).filter((value): value is number => value !== null)),
    };
}
