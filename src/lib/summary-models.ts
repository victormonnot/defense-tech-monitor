// Standard text pricing, checked against the official model pages on 2026-09-26.
// Rates are integer nanodollars per token; input ceilings include cache writes.
export const SUMMARY_MODELS = {
  "gpt-4.1-mini-2025-04-14": {
    label: "GPT-4.1 mini",
    input: 400,
    cachedInput: 100,
    cacheWrite: 400,
    output: 1600,
    reasoning: false,
    effort: null,
  },
  "gpt-5-nano-2025-08-07": {
    label: "GPT-5 nano",
    input: 50,
    cachedInput: 5,
    cacheWrite: 50,
    output: 400,
    reasoning: true,
    effort: "minimal",
  },
  "gpt-5.6-luna": {
    label: "GPT-5.6 Luna",
    input: 200,
    cachedInput: 20,
    cacheWrite: 250,
    output: 1200,
    reasoning: true,
    effort: "none",
  },
  "gpt-6-luna": {
    label: "GPT-6 Luna",
    input: 100,
    cachedInput: 10,
    cacheWrite: 125,
    output: 500,
    reasoning: true,
    effort: "none",
  },
} as const;

export type SummaryModel = keyof typeof SUMMARY_MODELS;
export const DEFAULT_SUMMARY_MODEL: SummaryModel = "gpt-4.1-mini-2025-04-14";
export const SUMMARY_MAX_INPUT_TOKENS = 64000;
export const SUMMARY_MAX_OUTPUT_TOKENS = 500;

export function isSummaryModel(value: unknown): value is SummaryModel {
  return typeof value === "string" && Object.hasOwn(SUMMARY_MODELS, value);
}

export function summaryReservationNanos(model: SummaryModel) {
  const rates = SUMMARY_MODELS[model];
  return (
    SUMMARY_MAX_INPUT_TOKENS * Math.max(rates.input, rates.cacheWrite) +
    SUMMARY_MAX_OUTPUT_TOKENS * rates.output
  );
}

export function summaryCostNanos(result: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}) {
  if (!isSummaryModel(result.model)) throw new Error("Unknown summary model");
  const rates = SUMMARY_MODELS[result.model];
  const cached = result.cachedInputTokens ?? 0;
  // Older cached results have no breakdown. Charge the highest input rate
  // when cache-write accounting is absent, rather than underestimating it.
  const writes =
    result.cacheWriteTokens ??
    (rates.cacheWrite > rates.input ? result.inputTokens - cached : 0);
  for (const value of [result.inputTokens, result.outputTokens, cached, writes])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid summary usage");
  if (
    cached + writes > result.inputTokens ||
    result.inputTokens > SUMMARY_MAX_INPUT_TOKENS ||
    result.outputTokens > SUMMARY_MAX_OUTPUT_TOKENS
  )
    throw new Error("Invalid summary usage");
  return (
    (result.inputTokens - cached - writes) * rates.input +
    cached * rates.cachedInput +
    writes * rates.cacheWrite +
    result.outputTokens * rates.output
  );
}
