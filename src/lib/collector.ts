import { discoverFeed } from "./feed";
import { resolveCollection } from "./connectors";
import { fetchResource, type HttpResult } from "./network";
import { getStore, type MonitorStore } from "./store";
import {
  COLLECTION_HEARTBEAT_MS,
  CollectionLeaseError,
  finishCollection,
  renewCollectionLease,
  reserveCollection,
  withCollectionLease,
} from "./collection-state";
import type { CollectionResult, CollectionRun } from "./types";

export type { CollectionResult } from "./types";
class SourceChangedError extends Error {}
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
  options: { trigger?: "manual" | "cli"; now?: () => number } = {},
): Promise<CollectionResult> {
  return (await runCollection(
    store,
    fetcher,
    intervalMinutes,
    options.trigger ?? "manual",
    options.now ?? Date.now,
  ))!;
}

export async function collectScheduledSources(
  store: MonitorStore = getStore(),
  fetcher: FetchResource = fetchResource,
  intervalMinutes = Number(process.env.DTM_COLLECTION_INTERVAL_MINUTES ?? 15),
  now: () => number = Date.now,
): Promise<CollectionResult | null> {
  return runCollection(store, fetcher, intervalMinutes, "scheduled", now);
}

async function runCollection(
  store: MonitorStore,
  fetcher: FetchResource,
  intervalMinutes: number,
  trigger: CollectionRun["trigger"],
  now: () => number,
): Promise<CollectionResult | null> {
  const validInterval =
    Number.isFinite(intervalMinutes) && intervalMinutes >= 1;
  if (!validInterval && trigger !== "scheduled")
    throw new Error(
      "DTM_COLLECTION_INTERVAL_MINUTES doit être un nombre supérieur ou égal à 1.",
    );
  const owner = reserveCollection(store.db, trigger, now());
  if (!owner) return null;
  let leaseLost = false;
  const assertLease = () => {
    if (leaseLost) throw new CollectionLeaseError();
    renewCollectionLease(store.db, owner, now());
  };
  const write = <T>(callback: () => T) =>
    withCollectionLease(store.db, owner, callback, now());
  const heartbeat = setInterval(() => {
    try {
      assertLease();
    } catch {
      leaseLost = true;
    }
  }, COLLECTION_HEARTBEAT_MS);
  heartbeat.unref();
  const result: CollectionResult = {
    added: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    checked: 0,
  };
  try {
    if (!validInterval)
      throw new Error(
        "DTM_COLLECTION_INTERVAL_MINUTES doit être un nombre supérieur ou égal à 1.",
      );
    for (const queued of store.sources()) {
      assertLease();
      const source = store
        .sources()
        .find((current) => current.id === queued.id);
      if (!source) {
        result.skipped++;
        continue;
      }
      const target = resolveCollection(source.siteUrl, source.feedUrl);
      if (
        !source.enabled ||
        !target ||
        (source.lastCheckedAt &&
          now() - Date.parse(source.lastCheckedAt) < intervalMinutes * 60000)
      ) {
        result.skipped++;
        continue;
      }
      const assertSource = () => {
        const current = store.db
          .prepare(
            "SELECT enabled,site_url,feed_url,language FROM sources WHERE id=?",
          )
          .get(source.id);
        if (
          !current?.enabled ||
          current.site_url !== source.siteUrl ||
          current.feed_url !== source.feedUrl ||
          current.language !== source.language
        )
          throw new SourceChangedError();
      };
      const writeSource = <T>(callback: () => T) =>
        write(() => {
          assertSource();
          return callback();
        });
      const checkedAt = new Date(now()).toISOString();
      try {
        writeSource(() =>
          store.db
            .prepare("UPDATE sources SET last_checked_at=? WHERE id=?")
            .run(checkedAt, source.id),
        );
        result.checked++;
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
        const response = await fetcher(target.url, headers);
        assertLease();
        assertSource();
        if (response.status === 304) {
          writeSource(() =>
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
              ),
          );
          continue;
        }
        if (response.status !== 200)
          throw new Error(`La source répond HTTP ${response.status}.`);
        const entries = await target.parse(
          response.body,
          response.url,
          source.language,
        );
        assertLease();
        assertSource();
        const changes = store.upsertEntries(
          source.id,
          entries,
          checkedAt,
          () => {
            assertLease();
            assertSource();
          },
        );
        result.added += changes.added;
        result.updated += changes.updated;
        writeSource(() =>
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
            ),
        );
      } catch (error) {
        if (error instanceof CollectionLeaseError) throw error;
        if (error instanceof SourceChangedError) {
          result.skipped++;
          continue;
        }
        const message =
          error instanceof Error ? error.message : "Échec de collecte.";
        try {
          writeSource(() =>
            store.db
              .prepare(
                "UPDATE sources SET status='error',last_error=? WHERE id=?",
              )
              .run(message.slice(0, 500), source.id),
          );
        } catch (writeError) {
          if (writeError instanceof SourceChangedError) {
            result.skipped++;
            continue;
          }
          throw writeError;
        }
        result.failed++;
      }
    }
    finishCollection(store.db, owner, result, null, now());
    return result;
  } catch (error) {
    try {
      finishCollection(
        store.db,
        owner,
        result,
        error instanceof Error ? error.message : "Échec de collecte.",
        now(),
      );
    } catch (finishError) {
      if (!(finishError instanceof CollectionLeaseError)) throw finishError;
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
