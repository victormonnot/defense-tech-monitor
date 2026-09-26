import { randomUUID } from "node:crypto";
import { buildSummaryInput, getSummaryConfig } from "./summary-client";
import {
  DEFAULT_SUMMARY_MODEL,
  isSummaryModel,
  summaryCostNanos,
  summaryReservationNanos,
  type SummaryModel,
} from "./summary-models";
import type { MonitorStore } from "./store";
import type {
  ArticleSummary,
  SummaryInputArticle,
  SummaryResult,
  SummaryState,
} from "./summary-types";

export const SUMMARY_LEASE_MS = 120000;
type Store = Pick<MonitorStore, "db">;
type Config = ReturnType<typeof getSummaryConfig>;
type Input = NonNullable<ReturnType<typeof buildSummaryInput>>;
type CacheRow = {
  cache_key: string;
  attempt_id: string;
  status: "running" | "success" | "failed";
  lease_expires_at: string | null;
  result: string | null;
  generated_at: string | null;
  error: string | null;
};
export interface SummaryClaim {
  id: string;
  articleId: string;
  cacheKey: string;
  request: Input["request"];
}

const interrupted =
  "La génération du résumé a été interrompue. Vous pouvez la relancer explicitement.";
const insufficient =
  "Le texte collecté est insuffisant pour produire un résumé étayé.";

function month(now: number) {
  return new Date(now).toISOString().slice(0, 7);
}
function configured(config: Config) {
  return (
    !!config.apiKey &&
    !config.error &&
    (config.model === undefined || isSummaryModel(config.model)) &&
    Number.isFinite(config.monthlyBudgetUsd) &&
    config.monthlyBudgetUsd > 0 &&
    Number.isSafeInteger(Math.floor(config.monthlyBudgetUsd * 1e9))
  );
}
function selectedModel(config: Config): SummaryModel {
  return isSummaryModel(config.model) ? config.model : DEFAULT_SUMMARY_MODEL;
}
function configurationReason(config: Config) {
  return (
    config.error ||
    (config.model !== undefined && !isSummaryModel(config.model)
      ? "Le modèle de résumé configuré n’est pas pris en charge."
      : !config.apiKey
        ? "Configurez une clé OpenAI pour générer des résumés."
        : "Configurez un plafond mensuel positif pour les résumés.")
  );
}
function budget(store: Store, currentMonth: string) {
  return store.db
    .prepare(
      "SELECT COALESCE(SUM(settled_nanos),0) AS spent,COALESCE(SUM(CASE WHEN settled_nanos IS NULL THEN reserved_nanos ELSE 0 END),0) AS reserved FROM summary_attempts WHERE month=?",
    )
    .get(currentMonth) as { spent: number; reserved: number };
}
function budgetReason() {
  return "Le budget mensuel restant ne permet pas de réserver un nouveau résumé.";
}
function rawInputs(store: Store): SummaryInputArticle[] {
  return store.db
    .prepare(
      "SELECT a.id,a.title,a.text,a.language,a.content_basis,s.name AS source_name FROM article_inputs a JOIN sources s ON s.id=a.source_id ORDER BY a.id",
    )
    .all()
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      text: String(row.text),
      sourceName: String(row.source_name),
      language: String(row.language),
      contentBasis: row.content_basis as SummaryInputArticle["contentBasis"],
    }));
}
export function summaryArticle(store: Store, id: string): SummaryInputArticle {
  if (typeof id !== "string" || !id || id !== id.trim() || id.length > 200)
    throw new Error("Publication inconnue.");
  const row = store.db
    .prepare(
      "SELECT a.id,a.title,a.text,a.language,a.content_basis,s.name AS source_name FROM article_inputs a JOIN sources s ON s.id=a.source_id WHERE a.id=?",
    )
    .get(id);
  if (!row) throw new Error("Publication inconnue.");
  return {
    id: String(row.id),
    title: String(row.title),
    text: String(row.text),
    sourceName: String(row.source_name),
    language: String(row.language),
    contentBasis: row.content_basis as SummaryInputArticle["contentBasis"],
  };
}
function validResult(value: unknown): value is SummaryResult {
  if (!value || typeof value !== "object") return false;
  const result = value as SummaryResult;
  const valid =
    isSummaryModel(result.model) &&
    (result.outcome === "summary" || result.outcome === "insufficient") &&
    typeof result.text === "string" &&
    (result.outcome === "summary"
      ? result.text.trim().length >= 20 && result.text.length <= 1000
      : result.text === "") &&
    !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(result.text);
  if (!valid) return false;
  try {
    summaryCostNanos(result);
    return true;
  } catch {
    return false;
  }
}
function cachedResult(
  row: CacheRow,
  expectedModel: SummaryModel,
): SummaryResult | null {
  try {
    const parsed: unknown = JSON.parse(row.result ?? "null");
    return validResult(parsed) && parsed.model === expectedModel
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function summarySnapshot(
  store: Store,
  inputs: SummaryInputArticle[] = rawInputs(store),
  config: Config = getSummaryConfig(),
  now = Date.now(),
): { state: SummaryState; summaries: Map<string, ArticleSummary> } {
  const model = selectedModel(config);
  const cache = new Map(
    (store.db.prepare("SELECT * FROM summary_cache").all() as CacheRow[]).map(
      (row) => [row.cache_key, row],
    ),
  );
  const running = [...cache.values()].some(
    (row) =>
      row.status === "running" && Date.parse(row.lease_expires_at ?? "") > now,
  );
  const totals = budget(store, month(now));
  const safeBudget =
    Number.isFinite(config.monthlyBudgetUsd) && config.monthlyBudgetUsd > 0
      ? config.monthlyBudgetUsd
      : 0;
  const insufficientBudget =
    Math.floor(safeBudget * 1e9) - totals.spent - totals.reserved <
    summaryReservationNanos(model);
  const block = !configured(config)
    ? configurationReason(config)
    : running
      ? "Un résumé est déjà en cours de génération."
      : insufficientBudget
        ? budgetReason()
        : null;
  const summaries = new Map<string, ArticleSummary>();
  let eligible = 0,
    ready = 0,
    failed = 0,
    needsRequest = 0;
  for (const article of inputs) {
    const input = buildSummaryInput(article, model);
    if (!input) {
      summaries.set(article.id, {
        status: "insufficient",
        canGenerate: false,
        reason: insufficient,
      });
      continue;
    }
    eligible++;
    const row = cache.get(input.cacheKey);
    const result = row?.status === "success" ? cachedResult(row, model) : null;
    if (result && row?.generated_at) {
      if (result.outcome === "summary") ready++;
      summaries.set(article.id, {
        status: result.outcome === "summary" ? "ready" : "insufficient",
        canGenerate: false,
        reason: result.outcome === "summary" ? null : insufficient,
        ...(result.outcome === "summary" ? { text: result.text } : {}),
        generatedAt: row.generated_at,
        model: result.model,
        truncated: input.truncated,
      });
      continue;
    }
    if (
      row?.status === "running" &&
      Date.parse(row.lease_expires_at ?? "") > now
    ) {
      summaries.set(article.id, {
        status: "pending",
        canGenerate: false,
        reason: "Résumé en cours de génération.",
      });
      continue;
    }
    needsRequest++;
    if (row) {
      failed++;
      const failure =
        row.status === "running"
          ? interrupted
          : row.error ||
            "Le résumé précédent est indisponible. Vous pouvez le relancer.";
      summaries.set(article.id, {
        status: "failed",
        canGenerate: block === null,
        reason: block ? `${failure} ${block}` : failure,
      });
    } else
      summaries.set(article.id, {
        status: "available",
        canGenerate: block === null,
        reason: block,
      });
  }
  return {
    summaries,
    state: {
      configured: configured(config),
      configurationError: config.error,
      model,
      month: month(now),
      monthlyBudgetUsd: safeBudget,
      spentUsd: totals.spent / 1e9,
      reservedUsd: totals.reserved / 1e9,
      budgetBlocked:
        configured(config) && insufficientBudget && needsRequest > 0,
      running,
      eligible,
      ready,
      failed,
    },
  };
}

function recoverExpired(store: Store, now: number) {
  const rows = store.db
    .prepare(
      "SELECT * FROM summary_cache WHERE status='running' AND lease_expires_at<=?",
    )
    .all(new Date(now).toISOString()) as CacheRow[];
  for (const row of rows) {
    store.db
      .prepare(
        "UPDATE summary_cache SET status='failed',lease_expires_at=NULL,error=? WHERE cache_key=? AND attempt_id=?",
      )
      .run(interrupted, row.cache_key, row.attempt_id);
    store.db
      .prepare(
        "UPDATE summary_attempts SET status='failed',finished_at=? WHERE id=? AND status='running'",
      )
      .run(new Date(now).toISOString(), row.attempt_id);
  }
}

/** Called only in response to an explicit generation request; failures may be retried here. */
export function claimSummary(
  store: Store,
  articleId: string,
  config: Config = getSummaryConfig(),
  now = Date.now(),
): SummaryClaim | null {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    recoverExpired(store, now);
    const model = selectedModel(config);
    const input = buildSummaryInput(summaryArticle(store, articleId), model);
    if (!input) {
      store.db.exec("COMMIT");
      return null;
    }
    const existing = store.db
      .prepare("SELECT * FROM summary_cache WHERE cache_key=?")
      .get(input.cacheKey) as CacheRow | undefined;
    if (
      existing &&
      ((existing.status === "success" && cachedResult(existing, model)) ||
        existing.status === "running")
    ) {
      store.db.exec("COMMIT");
      return null;
    }
    if (!configured(config)) throw new Error(configurationReason(config));
    if (
      store.db
        .prepare("SELECT cache_key FROM summary_cache WHERE status='running'")
        .get()
    )
      throw new Error("Un résumé est déjà en cours de génération.");
    const totals = budget(store, month(now));
    if (
      Math.floor(config.monthlyBudgetUsd * 1e9) -
        totals.spent -
        totals.reserved <
      summaryReservationNanos(model)
    )
      throw new Error(budgetReason());
    const id = randomUUID();
    store.db
      .prepare(
        "INSERT INTO summary_attempts (id,cache_key,month,reserved_nanos,started_at,status) VALUES (?,?,?,?,?,'running')",
      )
      .run(
        id,
        input.cacheKey,
        month(now),
        summaryReservationNanos(model),
        new Date(now).toISOString(),
      );
    store.db
      .prepare(
        "INSERT INTO summary_cache (cache_key,attempt_id,status,lease_expires_at) VALUES (?,?,'running',?) ON CONFLICT(cache_key) DO UPDATE SET attempt_id=excluded.attempt_id,status='running',lease_expires_at=excluded.lease_expires_at,result=NULL,generated_at=NULL,error=NULL",
      )
      .run(input.cacheKey, id, new Date(now + SUMMARY_LEASE_MS).toISOString());
    store.db.exec("COMMIT");
    return { id, articleId, cacheKey: input.cacheKey, request: input.request };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function settleSummary(
  store: Store,
  claim: SummaryClaim,
  result: SummaryResult,
  now = Date.now(),
): boolean {
  if (!validResult(result) || result.model !== claim.request.model)
    throw new Error("Réponse de résumé invalide.");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !store.db
        .prepare(
          "SELECT cache_key FROM summary_cache WHERE cache_key=? AND attempt_id=? AND status='running' AND lease_expires_at>?",
        )
        .get(claim.cacheKey, claim.id, new Date(now).toISOString())
    ) {
      store.db.exec("COMMIT");
      return false;
    }
    const cost = summaryCostNanos(result);
    store.db
      .prepare(
        "UPDATE summary_attempts SET status='success',settled_nanos=?,input_tokens=?,output_tokens=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(
        cost,
        result.inputTokens,
        result.outputTokens,
        new Date(now).toISOString(),
        claim.id,
      );
    const safeResult: SummaryResult = {
      outcome: result.outcome,
      text: result.text,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ...(result.cachedInputTokens !== undefined
        ? { cachedInputTokens: result.cachedInputTokens }
        : {}),
      ...(result.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: result.cacheWriteTokens }
        : {}),
    };
    store.db
      .prepare(
        "UPDATE summary_cache SET status='success',lease_expires_at=NULL,result=?,generated_at=?,error=NULL WHERE cache_key=? AND attempt_id=?",
      )
      .run(
        JSON.stringify(safeResult),
        new Date(now).toISOString(),
        claim.cacheKey,
        claim.id,
      );
    store.db.exec("COMMIT");
    return true;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function failSummary(
  store: Store,
  claim: SummaryClaim,
  message: string,
  beforeRequest = false,
  now = Date.now(),
): boolean {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !store.db
        .prepare(
          "SELECT cache_key FROM summary_cache WHERE cache_key=? AND attempt_id=? AND status='running' AND lease_expires_at>?",
        )
        .get(claim.cacheKey, claim.id, new Date(now).toISOString())
    ) {
      store.db.exec("COMMIT");
      return false;
    }
    store.db
      .prepare(
        "UPDATE summary_attempts SET status='failed',settled_nanos=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(beforeRequest ? 0 : null, new Date(now).toISOString(), claim.id);
    store.db
      .prepare(
        "UPDATE summary_cache SET status='failed',lease_expires_at=NULL,error=? WHERE cache_key=? AND attempt_id=?",
      )
      .run(message.slice(0, 500), claim.cacheKey, claim.id);
    store.db.exec("COMMIT");
    return true;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
