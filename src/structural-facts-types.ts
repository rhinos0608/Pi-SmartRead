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
export interface StructuralFacts {
  callers: CallerInfo[];
  parentClass?: ParentInfo;
  parentModule?: string;
  children: ChildSymbol[];
  baseClasses: ParentInfo[];
  interfaces: ParentInfo[];
  overrides: OverrideInfo[];
  reExportedBy: ReExportInfo[];
  notices: string[];
}
