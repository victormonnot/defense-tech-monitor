import type { MonitorStore } from "./store";
import type { Source } from "./types";
import { fetchXPosts, lookupXUser, XApiError, type XFetch } from "./x-client";
import {
  reserveXRequest,
  settleXRequest,
  xConfig,
  type XConfig,
} from "./x-store";

interface Cursor {
  user_id: string;
  username: string;
  since_id: string | null;
  next_token: string | null;
  sweep_newest_id: string | null;
}

function newest(...ids: (string | null)[]) {
  return ids.reduce<string | null>(
    (largest, id) =>
      id && (!largest || BigInt(id) > BigInt(largest)) ? id : largest,
    null,
  );
}

export async function collectXSource(
  store: MonitorStore,
  source: Source,
  username: string,
  guards: { assert: () => void; write: <T>(callback: () => T) => T },
  options: { fetcher?: XFetch; config?: XConfig; now?: () => number } = {},
) {
  const config = options.config ?? xConfig();
  const now = options.now ?? Date.now;
  let cursor = store.db
    .prepare("SELECT * FROM x_sources WHERE source_id=?")
    .get(source.id) as unknown as Cursor | undefined;
  if (!cursor) {
    guards.assert();
    const reservation = reserveXRequest(store.db, "user", config, now());
    let user: Awaited<ReturnType<typeof lookupXUser>>;
    try {
      user = await lookupXUser(username, config.apiKey, options.fetcher);
      settleXRequest(store.db, reservation, 1, now());
    } catch (error) {
      settleXRequest(
        store.db,
        reservation,
        error instanceof XApiError && error.beforeRequest ? 0 : null,
        now(),
      );
      throw error;
    }
    guards.write(() =>
      store.db
        .prepare(
          "INSERT INTO x_sources (source_id,user_id,username) VALUES (?,?,?)",
        )
        .run(source.id, user.id, user.username),
    );
    cursor = {
      user_id: user.id,
      username: user.username,
      since_id: null,
      next_token: null,
      sweep_newest_id: null,
    };
  }
  guards.assert();
  const reservation = reserveXRequest(store.db, "posts", config, now());
  let page: Awaited<ReturnType<typeof fetchXPosts>>;
  try {
    page = await fetchXPosts(
      {
        userId: cursor.user_id,
        username: cursor.username,
        apiKey: config.apiKey,
        maxResults: reservation.count,
        sinceId: cursor.since_id ?? undefined,
        paginationToken: cursor.next_token ?? undefined,
      },
      options.fetcher,
    );
    settleXRequest(store.db, reservation, page.resourceCount, now());
  } catch (error) {
    settleXRequest(
      store.db,
      reservation,
      error instanceof XApiError && error.beforeRequest ? 0 : null,
      now(),
    );
    throw error;
  }
  guards.assert();
  const checkedAt = new Date(now()).toISOString();
  // Persist publications before advancing the cursor. An interrupted write can
  // be replayed idempotently; advancing first could permanently lose posts.
  const changes = store.upsertEntries(
    source.id,
    page.entries,
    checkedAt,
    guards.assert,
  );
  const sweepNewest = newest(
    cursor.sweep_newest_id,
    page.newestId,
    cursor.since_id,
  );
  // The first import intentionally starts at the latest page. Later sweeps
  // keep their original since_id until all pages have been stored.
  const nextToken = cursor.since_id ? page.nextToken : null;
  guards.write(() => {
    store.db
      .prepare(
        "UPDATE x_sources SET since_id=?,next_token=?,sweep_newest_id=? WHERE source_id=?",
      )
      .run(
        nextToken ? cursor!.since_id : sweepNewest,
        nextToken,
        nextToken ? sweepNewest : null,
        source.id,
      );
    store.db
      .prepare(
        "UPDATE sources SET status=?,last_success_at=?,last_error=NULL,last_feed_count=? WHERE id=?",
      )
      .run(
        page.entries.length || source.articleCount ? "ok" : "empty",
        checkedAt,
        page.entries.length,
        source.id,
      );
  });
  return changes;
}
