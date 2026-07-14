import { cpus } from "node:os";

export type AdaptiveOperation = "parse" | "io" | "graph";

export interface AdaptiveConcurrencyInput {
  fileCount: number;
  operation: AdaptiveOperation;
  env?: NodeJS.ProcessEnv;
  cpuCount?: number;
}

export function chooseConcurrency(input: AdaptiveConcurrencyInput): number {
  const env = input.env ?? process.env;
  const override = env.PI_SMARTREAD_CONCURRENCY ? Number.parseInt(env.PI_SMARTREAD_CONCURRENCY, 10) : undefined;
  if (override && override > 0) return Math.max(1, Math.min(128, override));

  const cpuCount = input.cpuCount ?? cpus().length;
  const files = Math.max(0, input.fileCount);
  if (files <= 1) return 1;

  if (input.operation === "io") return Math.max(2, Math.min(64, cpuCount * 4, files));
  if (input.operation === "graph") return Math.max(2, Math.min(16, cpuCount, files));
  return Math.max(2, Math.min(32, cpuCount * 2, files));
}
