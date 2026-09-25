import type { ContentBasis } from "./types";

export interface SummaryInputArticle {
  id: string;
  title: string;
  text: string;
  sourceName: string;
  language: string;
  contentBasis: ContentBasis;
}

export interface SummaryResult {
  outcome: "summary" | "insufficient";
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ArticleSummary {
  status: "available" | "insufficient" | "pending" | "ready" | "failed";
  canGenerate: boolean;
  reason: string | null;
  text?: string;
  generatedAt?: string;
  model?: string;
  truncated?: boolean;
}

export interface SummaryState {
  configured: boolean;
  configurationError: string | null;
  model: string;
  month: string;
  monthlyBudgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  budgetBlocked: boolean;
  running: boolean;
  eligible: number;
  ready: number;
  failed: number;
}
