import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";

export type InspectV4Mode = "directory" | "file";
export interface InspectV4Input {
  path: string; signals?: string[];
  mapTokens?: number; focus?: string[]; compact?: boolean;
  cwd: string; sessionFilePath: string; signal?: AbortSignal;
}
export interface InspectV4Result {
  mode: InspectV4Mode; contentText: string;
  workspaceEvidence: WorkspaceEvidenceEnvelope;
  lineCount: number; byteLength: number; truncated: boolean;
  upstreamDetails?: Record<string, unknown>;
}
