export interface CallerInfo {
  file: string; line: number; symbolName: string;
  snippet: string; confidence: number;
}
export interface ChildSymbol {
  name: string; kind: "function"|"method"|"class"|"interface"|"enum"|"type_alias"|"variable";
  line: number; visibility?: "public"|"private"|"protected";
  isExported?: boolean; isOverride?: boolean; deprecated?: boolean;
}
export interface ParentInfo {
  kind: "class"|"interface"|"module"; name: string;
  file?: string; line?: number;
}
export interface OverrideInfo {
  methodName: string; parentName: string; parentFile?: string;
  line: number; isExplicit?: boolean;
}
export interface ReExportInfo {
  barrelFile: string; exportName: string; line: number;
  kind: "named"|"wildcard"|"all";
}
export interface DependentInfo {
  file: string;
  line: number;
  symbolName: string;
  kind: "import" | "re-export";
}

export interface DependencyInfo {
  specifier: string;
  line: number;
  resolvedPath?: string;
  kind: "import" | "re-export" | "require";
}

export interface StructuralFacts {
  /** Backward-compat: includes both same-file and cross-file call sites */
  callers: CallerInfo[];
  /** Files that import or re-export this module (resolved by path, not by name heuristic) */
  externalDependents?: DependentInfo[];
  /** Direct modules imported/re-exported by the inspected file */
  dependencies: DependencyInfo[];
  /** Same-file call sites only */
  internalCallSites: CallerInfo[];
  parentClass?: ParentInfo;
  parentModule?: string;
  children: ChildSymbol[];
  baseClasses: ParentInfo[];
  interfaces: ParentInfo[];
  overrides: OverrideInfo[];
  reExportedBy: ReExportInfo[];
  notices: string[];
}
