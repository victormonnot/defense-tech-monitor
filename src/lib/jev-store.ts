import { randomUUID } from "node:crypto";
import {
  buildJevInput,
  getJevConfig,
  JEV_MAX_INPUT_TOKENS,
  JEV_MODEL,
  JEV_NANODOLLARS_PER_TOKEN,
} from "./jev-client";
import type { JevAnalysis, JevMode, JevResult, JevState } from "./jev-types";
import type { MonitorStore } from "./store";
import type { ContentBasis, Feedback, Profile } from "./types";
import {
  GENERAL_FEED_ID,
  parseFeedInput,
  type CustomFeed,
  type FeedInput,
} from "./custom-feeds";

export const JEV_LEASE_MS = 120000;
export const JEV_RESERVATION_NANOS =
  JEV_MAX_INPUT_TOKENS * JEV_NANODOLLARS_PER_TOKEN;
type Store = Pick<MonitorStore, "db" | "profile">;
type Config = ReturnType<typeof getJevConfig>;
type Input = ReturnType<typeof buildJevInput>;
type CacheRow = {
  cache_key: string;
  attempt_id: string;
  status: "running" | "success" | "failed";
  lease_expires_at: string | null;
  result: string | null;
  evaluated_at: string | null;
  error: string | null;
};
export interface JevArticleInput {
  id: string;
  title: string;
  text: string;
  excerpt: string | null;
  language: string;
  contentBasis: ContentBasis;
}
export interface JevClaim {
  id: string;
  feedId: string;
  cacheKey: string;
  request: Input["request"];
}

function storedFeeds(store: Store): CustomFeed[] {
  return store.db
    .prepare("SELECT * FROM custom_feeds ORDER BY is_general DESC,id")
    .all()
    .map((row) => ({
      ...parseFeedInput(JSON.parse(String(row.input))),
      id: String(row.id),
      isGeneral: !!row.is_general,
      archived: !!row.archived,
      revision: Number(row.revision),
      analysis: { ready: 0, pending: 0, failed: 0 },
    }));
}

export function listCustomFeeds(store: Store): CustomFeed[] {
  return jevSnapshot(store).feeds;
}

export function saveCustomFeed(
  store: Store,
  id: string | null,
  value: FeedInput,
  expectedRevision?: number,
): string {
  const input = parseFeedInput(value);
  if (id !== null && (typeof id !== "string" || !id || id !== id.trim()))
    throw new Error("Fil inconnu.");
  if (
    id !== null &&
    (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
  )
    throw new Error("Version du fil invalide.");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    if (id === null) {
      const created = randomUUID();
      store.db
        .prepare("INSERT INTO custom_feeds (id,input) VALUES (?,?)")
        .run(created, JSON.stringify(input));
      store.db.exec("COMMIT");
      return created;
    }
    const existing = store.db
      .prepare("SELECT * FROM custom_feeds WHERE id=?")
      .get(id);
    if (!existing) throw new Error("Fil inconnu.");
    if (Number(existing.revision) !== expectedRevision)
      throw new Error(
        "Ce fil a été modifié ailleurs. Actualisez-le avant d’enregistrer vos changements.",
      );
    const current = parseFeedInput(JSON.parse(String(existing.input)));
    if (existing.is_general && input.name !== current.name)
      throw new Error("Le fil général Pour moi ne peut pas être renommé.");
    store.db
      .prepare("UPDATE custom_feeds SET input=?,revision=revision+1 WHERE id=?")
      .run(JSON.stringify(input), id);
    store.db.exec("COMMIT");
    return id;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function setCustomFeedArchived(
  store: Store,
  id: string,
  value: boolean,
): void {
  if (typeof id !== "string" || !id || id !== id.trim())
    throw new Error("Fil inconnu.");
  if (typeof value !== "boolean") throw new Error("État du fil invalide.");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const existing = store.db
      .prepare("SELECT * FROM custom_feeds WHERE id=?")
      .get(id);
    if (!existing) throw new Error("Fil inconnu.");
    if (existing.is_general)
      throw new Error("Le fil général Pour moi ne peut pas être archivé.");
    if (!!existing.archived !== value)
      store.db
        .prepare(
          "UPDATE custom_feeds SET archived=?,revision=revision+1 WHERE id=?",
        )
        .run(Number(value), id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function setFeedFeedback(
  store: Store,
  articleId: string,
  feedId: string,
  value: Feedback | null,
): void {
  if (typeof articleId !== "string" || typeof feedId !== "string")
    throw new Error("Publication ou fil inconnu.");
  if (value !== null && !["relevant", "off_topic", "seen"].includes(value))
    throw new Error("Retour invalide.");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    if (!store.db.prepare("SELECT id FROM articles WHERE id=?").get(articleId))
      throw new Error("Publication inconnue.");
    if (!store.db.prepare("SELECT id FROM custom_feeds WHERE id=?").get(feedId))
      throw new Error("Fil inconnu.");
    if (feedId === GENERAL_FEED_ID)
      store.db
        .prepare("UPDATE articles SET feedback=? WHERE id=?")
        .run(value, articleId);
    else if (value === null)
      store.db
        .prepare("DELETE FROM feed_feedback WHERE article_id=? AND feed_id=?")
        .run(articleId, feedId);
    else
      store.db
        .prepare(
          "INSERT INTO feed_feedback (article_id,feed_id,feedback) VALUES (?,?,?) ON CONFLICT(article_id,feed_id) DO UPDATE SET feedback=excluded.feedback",
        )
        .run(articleId, feedId, value);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function setting(store: Store, key: string) {
  return store.db.prepare("SELECT value FROM settings WHERE key=?").get(key)
    ?.value as string | undefined;
}
function setSetting(store: Store, key: string, value: string) {
  store.db
    .prepare(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, value);
}
function mode(store: Store): JevMode {
  const value = setting(store, "jev_mode");
  return value === "compare" || value === "personal" ? value : "off";
}
function configured(config: Config) {
  return (
    !!config.apiKey &&
    !config.error &&
    Number.isFinite(config.monthlyBudgetUsd) &&
    config.monthlyBudgetUsd > 0 &&
    Number.isSafeInteger(Math.floor(config.monthlyBudgetUsd * 1e9))
  );
}
function month(now: number) {
  return new Date(now).toISOString().slice(0, 7);
}
function budget(store: Store, currentMonth: string) {
  return store.db
    .prepare(
      "SELECT COALESCE(SUM(settled_nanos),0) AS spent, COALESCE(SUM(CASE WHEN settled_nanos IS NULL THEN reserved_nanos ELSE 0 END),0) AS reserved, COALESCE(SUM(input_tokens),0) AS tokens FROM jev_attempts WHERE month=?",
    )
    .get(currentMonth) as { spent: number; reserved: number; tokens: number };
}
function rawInputs(store: Store): JevArticleInput[] {
  return store.db
    .prepare(
      "SELECT id,title,text,excerpt,language,content_basis FROM articles ORDER BY COALESCE(updated_at,collected_at) DESC,id",
    )
    .all()
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      text: String(row.text),
      excerpt: row.excerpt as string | null,
      language: String(row.language),
      contentBasis: row.content_basis as ContentBasis,
    }));
}
function validResult(value: unknown): value is JevResult {
  if (!value || typeof value !== "object") return false;
  const result = value as JevResult;
  return (
    result.model === JEV_MODEL &&
    Number.isFinite(result.score) &&
    result.score >= 0 &&
    result.score <= 3 &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    Number.isFinite(result.kindConfidence) &&
    result.kindConfidence >= 0 &&
    result.kindConfidence <= 1 &&
    [
      "technical",
      "field_report",
      "research",
      "business",
      "general",
      "unknown",
    ].includes(result.kind) &&
    Number.isSafeInteger(result.inputTokens) &&
    result.inputTokens >= 0 &&
    result.inputTokens <= JEV_MAX_INPUT_TOKENS
  );
}
function cachedResult(row: CacheRow): JevResult | null {
  try {
    const result: unknown = JSON.parse(row.result ?? "null");
    return validResult(result) ? result : null;
  } catch {
    return null;
  }
}

export function setJevMode(
  store: Store,
  value: JevMode,
  config: Config = getJevConfig(),
): void {
  if (!["off", "compare", "personal"].includes(value))
    throw new Error("Mode Jev invalide.");
  if (value !== "off" && !configured(config))
    throw new Error(
      config.error ||
        "Configurez la clé Jev et un plafond mensuel positif avant l’activation.",
    );
  store.db.exec("BEGIN IMMEDIATE");
  try {
    setSetting(store, "jev_mode", value);
    if (value !== "off")
      store.db
        .prepare("DELETE FROM settings WHERE key='jev_worker_error'")
        .run();
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function jevSnapshot(
  store: Store,
  inputs: JevArticleInput[] = rawInputs(store),
  profile: Profile = store.profile(),
  config: Config = getJevConfig(),
  now = Date.now(),
): {
  state: JevState;
  analyses: Map<string, JevAnalysis>;
  feeds: CustomFeed[];
  feedAnalyses: Map<string, Record<string, JevAnalysis>>;
  feedFeedback: Map<string, Record<string, Feedback>>;
} {
  const currentMode = mode(store);
  const cache = new Map(
    (store.db.prepare("SELECT * FROM jev_cache").all() as CacheRow[]).map(
      (row) => [row.cache_key, row],
    ),
  );
  const analyses = new Map<string, JevAnalysis>();
  const feeds = storedFeeds(store);
  const feedAnalyses = new Map<string, Record<string, JevAnalysis>>();
  const feedFeedback = new Map<string, Record<string, Feedback>>();
  for (const row of store.db.prepare("SELECT * FROM feed_feedback").all()) {
    const id = String(row.article_id);
    const feedback = feedFeedback.get(id) ?? {};
    feedback[String(row.feed_id)] = row.feedback as Feedback;
    feedFeedback.set(id, feedback);
  }
  let ready = 0,
    failed = 0,
    pending = 0,
    needsRequest = 0;
  const expired = [...cache.values()].some(
    (row) =>
      row.status === "running" && Date.parse(row.lease_expires_at ?? "") <= now,
  );
  for (const feed of feeds) {
    const active = feed.enabled && !feed.archived;
    for (const article of inputs) {
      const input = buildJevInput(article, profile, feed);
      const row = cache.get(input.cacheKey);
      const result = row?.status === "success" ? cachedResult(row) : null;
      if (result && row?.evaluated_at) {
        feed.analysis.ready++;
        if (active) ready++;
        const { inputTokens: _tokens, ...analysis } = result;
        const evaluated: JevAnalysis = {
          ...analysis,
          scope: input.request.state.article.scope as
            | "all_text"
            | "title_excerpt",
          truncated: input.request.state.article.truncated,
          evaluatedAt: row.evaluated_at,
          applied: feed.isGeneral ? currentMode === "personal" : true,
          minScore: feed.minScore,
          minConfidence: feed.minConfidence,
        };
        if (feed.isGeneral) analyses.set(article.id, evaluated);
        const results = feedAnalyses.get(article.id) ?? {};
        results[feed.id] = evaluated;
        feedAnalyses.set(article.id, results);
      } else if (
        row?.status === "failed" ||
        (row?.status === "running" &&
          Date.parse(row.lease_expires_at ?? "") <= now) ||
        row?.status === "success"
      ) {
        feed.analysis.failed++;
        if (active) failed++;
      } else {
        feed.analysis.pending++;
        if (active) {
          pending++;
          if (!row) needsRequest++;
        }
      }
    }
  }
  const totals = budget(store, month(now));
  const running = [...cache.values()].some(
    (row) =>
      row.status === "running" && Date.parse(row.lease_expires_at ?? "") > now,
  );
  const safeBudget =
    Number.isFinite(config.monthlyBudgetUsd) && config.monthlyBudgetUsd > 0
      ? config.monthlyBudgetUsd
      : 0;
  return {
    analyses,
    feeds,
    feedAnalyses,
    feedFeedback,
    state: {
      mode: currentMode,
      configured: configured(config),
      configurationError: config.error,
      model: JEV_MODEL,
      month: month(now),
      monthlyBudgetUsd: safeBudget,
      spentUsd: totals.spent / 1e9,
      reservedUsd: totals.reserved / 1e9,
      inputTokens: totals.tokens,
      ready,
      pending,
      failed,
      running,
      lastError:
        setting(store, "jev_worker_error") ??
        (expired
          ? "Une analyse Jev a été interrompue. Une reprise explicite est nécessaire."
          : null),
      budgetBlocked:
        configured(config) &&
        needsRequest > 0 &&
        Math.floor(safeBudget * 1e9) - totals.spent - totals.reserved <
          JEV_RESERVATION_NANOS,
    },
  };
}

function recoverExpired(store: Store, now: number) {
  const rows = store.db
    .prepare(
      "SELECT * FROM jev_cache WHERE status='running' AND lease_expires_at<=?",
    )
    .all(new Date(now).toISOString()) as CacheRow[];
  if (!rows.length) return;
  const message =
    "Une analyse Jev a été interrompue. Une reprise explicite est nécessaire.";
  for (const row of rows) {
    store.db
      .prepare(
        "UPDATE jev_cache SET status='failed',lease_expires_at=NULL,error=? WHERE cache_key=? AND attempt_id=?",
      )
      .run(message, row.cache_key, row.attempt_id);
    store.db
      .prepare(
        "UPDATE jev_attempts SET status='failed',finished_at=? WHERE id=? AND status='running'",
      )
      .run(new Date(now).toISOString(), row.attempt_id);
  }
  setSetting(store, "jev_worker_error", message);
}

export function retryJevFailures(store: Store, now = Date.now()): number {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    recoverExpired(store, now);
    const count = Number(
      store.db.prepare("DELETE FROM jev_cache WHERE status='failed'").run()
        .changes,
    );
    store.db.prepare("DELETE FROM settings WHERE key='jev_worker_error'").run();
    store.db.exec("COMMIT");
    return count;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function claimJev(
  store: Store,
  config: Config = getJevConfig(),
  now = Date.now(),
): JevClaim | null {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    recoverExpired(store, now);
    if (
      mode(store) === "off" ||
      !configured(config) ||
      setting(store, "jev_worker_error") ||
      store.db
        .prepare("SELECT cache_key FROM jev_cache WHERE status='running'")
        .get()
    ) {
      store.db.exec("COMMIT");
      return null;
    }
    const totals = budget(store, month(now));
    if (
      Math.floor(config.monthlyBudgetUsd * 1e9) -
        totals.spent -
        totals.reserved <
      JEV_RESERVATION_NANOS
    ) {
      store.db.exec("COMMIT");
      return null;
    }
    const profile = store.profile();
    const feeds = storedFeeds(store).filter(
      (feed) => feed.enabled && !feed.archived,
    );
    const find = store.db.prepare(
      "SELECT cache_key FROM jev_cache WHERE cache_key=?",
    );
    for (const article of rawInputs(store)) {
      for (const feed of feeds) {
        const input = buildJevInput(article, profile, feed);
        if (find.get(input.cacheKey)) continue;
        const id = randomUUID();
        store.db
          .prepare(
            "INSERT INTO jev_attempts (id,cache_key,month,reserved_nanos,started_at,status) VALUES (?,?,?,?,?,'running')",
          )
          .run(
            id,
            input.cacheKey,
            month(now),
            JEV_RESERVATION_NANOS,
            new Date(now).toISOString(),
          );
        store.db
          .prepare(
            "INSERT INTO jev_cache (cache_key,attempt_id,status,lease_expires_at) VALUES (?,?,'running',?)",
          )
          .run(input.cacheKey, id, new Date(now + JEV_LEASE_MS).toISOString());
        store.db.exec("COMMIT");
        return {
          id,
          feedId: feed.id,
          cacheKey: input.cacheKey,
          request: input.request,
        };
      }
    }
    store.db.exec("COMMIT");
    return null;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function settleJev(
  store: Store,
  claim: JevClaim,
  result: JevResult,
  now = Date.now(),
): boolean {
  if (!validResult(result)) throw new Error("Réponse Jev invalide.");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const row = store.db
      .prepare(
        "SELECT * FROM jev_cache WHERE cache_key=? AND attempt_id=? AND status='running' AND lease_expires_at>?",
      )
      .get(claim.cacheKey, claim.id, new Date(now).toISOString());
    if (!row) {
      store.db.exec("COMMIT");
      return false;
    }
    store.db
      .prepare(
        "UPDATE jev_attempts SET status='success',settled_nanos=?,input_tokens=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(
        result.inputTokens * JEV_NANODOLLARS_PER_TOKEN,
        result.inputTokens,
        new Date(now).toISOString(),
        claim.id,
      );
    store.db
      .prepare(
        "UPDATE jev_cache SET status='success',lease_expires_at=NULL,result=?,evaluated_at=?,error=NULL WHERE cache_key=? AND attempt_id=?",
      )
      .run(
        JSON.stringify(result),
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

export function failJev(
  store: Store,
  claim: JevClaim,
  message: string,
  beforeRequest = false,
  now = Date.now(),
): boolean {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const row = store.db
      .prepare(
        "SELECT * FROM jev_cache WHERE cache_key=? AND attempt_id=? AND status='running' AND lease_expires_at>?",
      )
      .get(claim.cacheKey, claim.id, new Date(now).toISOString());
    if (!row) {
      store.db.exec("COMMIT");
      return false;
    }
    store.db
      .prepare(
        "UPDATE jev_attempts SET status='failed',settled_nanos=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(beforeRequest ? 0 : null, new Date(now).toISOString(), claim.id);
    store.db
      .prepare(
        "UPDATE jev_cache SET status='failed',lease_expires_at=NULL,error=? WHERE cache_key=? AND attempt_id=?",
      )
      .run(message.slice(0, 500), claim.cacheKey, claim.id);
    setSetting(store, "jev_worker_error", message.slice(0, 500));
    store.db.exec("COMMIT");
    return true;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
