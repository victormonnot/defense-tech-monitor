export type JevMode = "off" | "compare" | "personal";

export type JevContentKind =
  | "technical"
  | "field_report"
  | "research"
  | "business"
  | "general"
  | "unknown";

export interface JevResult {
  score: number;
  confidence: number;
  kind: JevContentKind;
  kindConfidence: number;
  model: string;
  inputTokens: number;
}

export interface JevAnalysis extends Omit<JevResult, "inputTokens"> {
  evaluatedAt: string;
  applied: boolean;
  scope: "all_text" | "title_excerpt";
  truncated: boolean;
}

export interface JevState {
  mode: JevMode;
  configured: boolean;
  configurationError: string | null;
  model: string;
  month: string;
  monthlyBudgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  inputTokens: number;
  ready: number;
  pending: number;
  failed: number;
  running: boolean;
  lastError: string | null;
  budgetBlocked: boolean;
}
