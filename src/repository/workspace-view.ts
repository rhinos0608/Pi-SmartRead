export interface ChannelCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  rawScore: number;
}

export interface WorkspaceViewEntity {
  entityId: string;
  path: string;
  startLine?: number;
  endLine?: number;
  renderedText: string;
}

export interface WorkspaceView {
  entities: WorkspaceViewEntity[];
  truncated: boolean;
  omittedEntityCount: number;
  byteLength: number;
}

export type WorkspaceViewFormat = "OUTLINE" | "EVIDENCE" | "DIFF";

export interface RenderWorkspaceViewInput {
  rankedCandidates: ChannelCandidate[];
  format: WorkspaceViewFormat;
  hardBudget: { maxBytes: number; maxLines: number };
}

function renderEntity(c: ChannelCandidate, format: WorkspaceViewFormat): string {
  const loc = c.line != null ? `${c.file}:${c.line}` : c.file;
  switch (format) {
    case "OUTLINE":
      return `${loc} ${c.name} (${c.kind})`;
    case "EVIDENCE":
    case "DIFF":
      return `${loc} ${c.name} ${c.snippet}`;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") n++;
  }
  return n;
}

export function renderWorkspaceView(input: RenderWorkspaceViewInput): WorkspaceView {
  const { rankedCandidates, format, hardBudget } = input;
  const entities: WorkspaceViewEntity[] = [];
  let cumBytes = 0;
  let cumLines = 0;

  for (const c of rankedCandidates) {
    const renderedText = renderEntity(c, format);
    const eBytes = byteLength(renderedText);
    const eLines = lineCount(renderedText);

    if (cumBytes + eBytes > hardBudget.maxBytes || cumLines + eLines > hardBudget.maxLines) {
      return {
        entities,
        truncated: true,
        omittedEntityCount: rankedCandidates.length - entities.length,
        byteLength: cumBytes,
      };
    }

    cumBytes += eBytes;
    cumLines += eLines;
    entities.push({
      entityId: `${c.file}:${c.line ?? 0}:${c.name}`,
      path: c.file,
      startLine: c.line,
      endLine: c.endLine,
      renderedText,
    });
  }

  return {
    entities,
    truncated: false,
    omittedEntityCount: 0,
    byteLength: cumBytes,
  };
}
