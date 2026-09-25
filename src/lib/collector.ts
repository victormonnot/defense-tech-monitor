import { randomUUID } from "node:crypto";
import { discoverFeed, parseFeed } from "./feed";
import { fetchResource, type HttpResult } from "./network";
import { getStore, type MonitorStore } from "./store";

export interface CollectionResult {
  added: number;
  updated: number;
  failed: number;
  skipped: number;
  checked: number;
}
export type FetchResource = (
  url: string,
  headers?: Record<string, string>,
) => Promise<HttpResult>;

export async function discoverSource(
  siteUrl: string,
  fetcher: FetchResource = fetchResource,
) {
  const response = await fetcher(siteUrl);
  if (response.status !== 200)
    throw new Error(`La page de la source répond HTTP ${response.status}.`);
  if (/<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(response.body.slice(0, 4000)))
    return response.url;
  return discoverFeed(response.body, response.url);
}

export async function collectSources(
  store: MonitorStore = getStore(),
  fetcher: FetchResource = fetchResource,
  intervalMinutes = Number(process.env.DTM_COLLECTION_INTERVAL_MINUTES ?? 15),
): Promise<CollectionResult> {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1)
    throw new Error(
      "DTM_COLLECTION_INTERVAL_MINUTES doit être un nombre supérieur ou égal à 1.",
    );
  const owner = randomUUID();
  const now = new Date().toISOString();
  // A lease prevents overlapping web/CLI runs from fetching the same feeds.
  const lock = store.db
    .prepare(
      "INSERT INTO collection_lock (id,owner,expires_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE collection_lock.expires_at < ?",
    )
    .run(owner, new Date(Date.now() + 600000).toISOString(), now);
  if (!lock.changes) throw new Error("Une collecte est déjà en cours.");
  const result: CollectionResult = {
    added: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    checked: 0,
  };
  try {
    for (const source of store.sources()) {
      if (
        !source.enabled ||
        !source.feedUrl ||
        (source.lastCheckedAt &&
          Date.now() - Date.parse(source.lastCheckedAt) <
            intervalMinutes * 60000)
      ) {
        result.skipped++;
        continue;
      }
      const checkedAt = new Date().toISOString();
      store.db
        .prepare(
          "UPDATE collection_lock SET expires_at=? WHERE id=1 AND owner=?",
        )
        .run(new Date(Date.now() + 600000).toISOString(), owner);
      store.db
        .prepare("UPDATE sources SET last_checked_at=? WHERE id=?")
        .run(checkedAt, source.id);
      result.checked++;
      try {
        const cache = store.db
          .prepare(
            "SELECT etag,last_modified,last_feed_count FROM sources WHERE id=?",
          )
          .get(source.id) as {
          etag: string | null;
          last_modified: string | null;
          last_feed_count: number | null;
        };
        const headers: Record<string, string> = {};
        if (cache.etag) headers["if-none-match"] = cache.etag;
        if (cache.last_modified)
          headers["if-modified-since"] = cache.last_modified;
        const response = await fetcher(source.feedUrl, headers);
        if (response.status === 304) {
          store.db
            .prepare(
              "UPDATE sources SET status=?,last_success_at=?,last_error=NULL WHERE id=?",
            )
            .run(
              (cache.last_feed_count ?? source.articleCount) > 0
                ? "ok"
                : "empty",
              checkedAt,
              source.id,
            );
          continue;
        }
        if (response.status !== 200)
          throw new Error(`La source répond HTTP ${response.status}.`);
        const entries = await parseFeed(
          response.body,
          response.url,
          source.language,
        );
        const changes = store.upsertEntries(source.id, entries, checkedAt);
        result.added += changes.added;
        result.updated += changes.updated;
        store.db
          .prepare(
            "UPDATE sources SET status=?,last_success_at=?,last_error=NULL,etag=?,last_modified=?,last_feed_count=? WHERE id=?",
          )
          .run(
            entries.length ? "ok" : "empty",
            checkedAt,
            response.headers.etag || null,
            response.headers["last-modified"] || null,
            entries.length,
            source.id,
          );
      } catch (error) {
        result.failed++;
        const message =
          error instanceof Error ? error.message : "Échec de collecte.";
        store.db
          .prepare("UPDATE sources SET status='error',last_error=? WHERE id=?")
          .run(message.slice(0, 500), source.id);
      }
    }
  } finally {
    store.db
      .prepare("DELETE FROM collection_lock WHERE id=1 AND owner=?")
      .run(owner);
  }
  return result;
}
