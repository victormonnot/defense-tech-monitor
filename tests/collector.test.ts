import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { collectSources, type FetchResource } from "../src/lib/collector";
import type { HttpResult } from "../src/lib/network";
import { MonitorStore } from "../src/lib/store";

const FEED_URL = "https://example.com/feed";
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel><title>Test publications</title><link>https://example.com/</link>
    <description>Synthetic collector test fixture</description><language>en</language>
    <item><guid>test-article-1</guid><title>Robot navigation test publication</title>
      <link>https://example.com/articles/test-1</link><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate>
      <description>A synthetic article about autonomous robot navigation.</description>
    </item>
  </channel></rss>`;
const EMPTY_FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Empty test feed</title><link>https://example.com/</link><description>Test fixture</description>
  </channel></rss>`;

function createStore(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}

function addSource(
  store: MonitorStore,
  name = "Test source",
  feedUrl: string | null = FEED_URL,
) {
  return store.addSource({
    name,
    siteUrl: `https://example.com/${encodeURIComponent(name)}`,
    feedUrl,
    language: "en",
  });
}

function response(
  body = FEED,
  status = 200,
  headers: Record<string, string> = {},
): HttpResult {
  return { url: FEED_URL, status, headers, body };
}

function expireCheck(store: MonitorStore, id: string) {
  store.db
    .prepare("UPDATE sources SET last_checked_at=? WHERE id=?")
    .run(new Date(Date.now() - 3600000).toISOString(), id);
}

test("collection ingests real feed structure once and observes the minimum interval", async (t) => {
  const store = createStore(t);
  addSource(store);
  let requests = 0;
  const fetcher: FetchResource = async (url, headers) => {
    requests++;
    assert.equal(url, FEED_URL);
    assert.deepEqual(headers, {});
    return response();
  };

  assert.deepEqual(await collectSources(store, fetcher, 15), {
    added: 1,
    updated: 0,
    failed: 0,
    skipped: 0,
    checked: 1,
  });
  const [article] = store.snapshot().articles;
  assert.equal(article.title, "Robot navigation test publication");
  assert.equal(article.url, "https://example.com/articles/test-1");
  assert.equal(article.publishedAt, "2026-06-01T10:00:00.000Z");
  assert.ok(article.collectedAt);
  assert.notEqual(article.collectedAt, article.publishedAt);
  const [source] = store.sources();
  assert.equal(source.status, "ok");
  assert.equal(source.articleCount, 1);
  assert.equal(source.lastSuccessAt, source.lastCheckedAt);
  assert.equal(source.lastError, null);

  assert.deepEqual(await collectSources(store, fetcher, 15), {
    added: 0,
    updated: 0,
    failed: 0,
    skipped: 1,
    checked: 0,
  });
  assert.equal(requests, 1);
  assert.deepEqual(store.snapshot().articles, [article]);
});

test("conditional revalidation sends cache headers and 304 preserves articles and user state", async (t) => {
  const store = createStore(t);
  const sourceId = addSource(store);
  const validators = {
    etag: '"test-version-1"',
    "last-modified": "Mon, 01 Jun 2026 10:00:00 GMT",
  };
  await collectSources(store, async () => response(FEED, 200, validators), 15);
  const [{ id }] = store.snapshot().articles;
  store.setArticleState(id, "saved", true);
  store.setArticleState(id, "is_read", true);
  store.setArticleState(id, "feedback", "relevant");
  const before = store.snapshot().articles;
  expireCheck(store, sourceId);
  store.db
    .prepare(
      "UPDATE sources SET status='error',last_error='Previous request failed' WHERE id=?",
    )
    .run(sourceId);

  let requests = 0;
  const result = await collectSources(
    store,
    async (url, headers) => {
      requests++;
      assert.equal(url, FEED_URL);
      assert.deepEqual(headers, {
        "if-none-match": validators.etag,
        "if-modified-since": validators["last-modified"],
      });
      return response("", 304);
    },
    15,
  );

  assert.equal(requests, 1);
  assert.deepEqual(result, {
    added: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    checked: 1,
  });
  assert.deepEqual(store.snapshot().articles, before);
  const [source] = store.sources();
  assert.equal(source.status, "ok");
  assert.equal(source.lastError, null);
  assert.equal(source.lastSuccessAt, source.lastCheckedAt);
  const cached = store.db
    .prepare("SELECT etag,last_modified FROM sources WHERE id=?")
    .get(sourceId);
  assert.equal(cached?.etag, validators.etag);
  assert.equal(cached?.last_modified, validators["last-modified"]);
});

test("empty feeds remain explicitly empty through 304 revalidation", async (t) => {
  const store = createStore(t);
  const sourceId = addSource(store);
  assert.deepEqual(
    await collectSources(store, async () => response(EMPTY_FEED), 15),
    { added: 0, updated: 0, failed: 0, skipped: 0, checked: 1 },
  );
  assert.equal(store.sources()[0].status, "empty");
  assert.equal(store.sources()[0].lastError, null);
  assert.equal(store.snapshot().articles.length, 0);

  expireCheck(store, sourceId);
  await collectSources(store, async () => response("", 304), 15);
  assert.equal(store.sources()[0].status, "empty");
});

test("304 restores an empty feed status after an error while retaining historical articles", async (t) => {
  const store = createStore(t);
  const sourceId = addSource(store);
  await collectSources(
    store,
    async () => response(FEED, 200, { etag: '"populated"' }),
    15,
  );
  const articles = store.snapshot().articles;
  assert.equal(articles.length, 1);

  expireCheck(store, sourceId);
  await collectSources(
    store,
    async () => response(EMPTY_FEED, 200, { etag: '"empty"' }),
    15,
  );
  assert.equal(store.sources()[0].status, "empty");
  assert.deepEqual(store.snapshot().articles, articles);

  expireCheck(store, sourceId);
  await collectSources(
    store,
    async (_url, headers) => {
      assert.equal(headers?.["if-none-match"], '"empty"');
      return response("", 304);
    },
    15,
  );
  assert.equal(store.sources()[0].status, "empty");

  expireCheck(store, sourceId);
  await collectSources(store, async () => response("Unavailable", 503), 15);
  assert.equal(store.sources()[0].status, "error");

  expireCheck(store, sourceId);
  await collectSources(
    store,
    async (_url, headers) => {
      assert.equal(headers?.["if-none-match"], '"empty"');
      return response("", 304);
    },
    15,
  );
  assert.equal(store.sources()[0].status, "empty");
  assert.equal(store.sources()[0].lastError, null);
  assert.equal(store.sources()[0].articleCount, 1);
  assert.deepEqual(store.snapshot().articles, articles);
});

test("HTTP and HTML responses surface source errors without stopping later sources", async (t) => {
  const store = createStore(t);
  const httpId = addSource(
    store,
    "A HTTP failure",
    "https://example.com/http-error",
  );
  const htmlId = addSource(
    store,
    "B HTML response",
    "https://example.com/html",
  );
  const validId = addSource(store, "C Valid source");
  const requests: string[] = [];
  const result = await collectSources(
    store,
    async (url) => {
      requests.push(url);
      if (url.endsWith("http-error")) return response("Unavailable", 503);
      if (url.endsWith("html"))
        return response(
          "<!doctype html><html><body>Subscription page</body></html>",
        );
      return response();
    },
    15,
  );

  assert.deepEqual(result, {
    added: 1,
    updated: 0,
    failed: 2,
    skipped: 0,
    checked: 3,
  });
  assert.deepEqual(requests, [
    "https://example.com/http-error",
    "https://example.com/html",
    FEED_URL,
  ]);
  const sources = new Map(store.sources().map((source) => [source.id, source]));
  assert.equal(sources.get(httpId)?.status, "error");
  assert.match(sources.get(httpId)?.lastError ?? "", /HTTP 503/);
  assert.equal(sources.get(htmlId)?.status, "error");
  assert.ok(sources.get(htmlId)?.lastError);
  assert.equal(sources.get(httpId)?.lastSuccessAt, null);
  assert.ok(sources.get(httpId)?.lastCheckedAt);
  assert.equal(sources.get(validId)?.status, "ok");
  assert.equal(sources.get(validId)?.articleCount, 1);
});

test("a failed refresh retains the previous articles and last successful collection", async (t) => {
  const store = createStore(t);
  const sourceId = addSource(store);
  await collectSources(store, async () => response(), 15);
  const articles = store.snapshot().articles;
  const lastSuccess = store.sources()[0].lastSuccessAt;
  expireCheck(store, sourceId);

  const result = await collectSources(
    store,
    async () => {
      throw new Error("Request timed out");
    },
    15,
  );
  assert.equal(result.failed, 1);
  assert.deepEqual(store.snapshot().articles, articles);
  assert.equal(store.sources()[0].lastSuccessAt, lastSuccess);
  assert.equal(store.sources()[0].status, "error");
  assert.equal(store.sources()[0].lastError, "Request timed out");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM collection_lock").get()
      ?.count,
    0,
  );
});

test("disabled sources and sources without a feed are skipped without requests", async (t) => {
  const store = createStore(t);
  const disabledId = addSource(store, "Disabled source");
  addSource(store, "Unsupported source", null);
  store.toggleSource(disabledId, false);
  const result = await collectSources(
    store,
    async () => {
      assert.fail("No request is expected");
    },
    15,
  );
  assert.deepEqual(result, {
    added: 0,
    updated: 0,
    failed: 0,
    skipped: 2,
    checked: 0,
  });
  for (const source of store.sources())
    assert.equal(source.lastCheckedAt, null);
  assert.equal(
    store.sources().find((source) => !source.feedUrl)?.status,
    "unsupported",
  );
});

test("an active collection lease prevents concurrent requests and is released on completion", async (t) => {
  const store = createStore(t);
  addSource(store);
  const entered = Promise.withResolvers<void>();
  const pendingResponse = Promise.withResolvers<HttpResult>();
  const first = collectSources(
    store,
    async () => {
      entered.resolve();
      return pendingResponse.promise;
    },
    15,
  );
  await entered.promise;
  try {
    await assert.rejects(
      collectSources(
        store,
        async () => {
          assert.fail("The concurrent run must not fetch");
        },
        15,
      ),
      /collecte est déjà en cours/,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM collection_lock").get()
        ?.count,
      1,
    );
  } finally {
    pendingResponse.resolve(response());
  }
  assert.equal((await first).added, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM collection_lock").get()
      ?.count,
    0,
  );
  assert.deepEqual(
    await collectSources(
      store,
      async () => {
        assert.fail("The interval still applies");
      },
      15,
    ),
    { added: 0, updated: 0, failed: 0, skipped: 1, checked: 0 },
  );
});

test("an expired collection lease can be reclaimed", async (t) => {
  const store = createStore(t);
  addSource(store);
  store.db
    .prepare("INSERT INTO collection_lock (id,owner,expires_at) VALUES (1,?,?)")
    .run("abandoned-run", new Date(Date.now() - 60000).toISOString());
  assert.equal(
    (await collectSources(store, async () => response(), 15)).added,
    1,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM collection_lock").get()
      ?.count,
    0,
  );
});

test("invalid collection intervals fail before any request or lease", async (t) => {
  const store = createStore(t);
  addSource(store);
  for (const interval of [0, -1, NaN, Infinity]) {
    await assert.rejects(
      collectSources(
        store,
        async () => {
          assert.fail("No request is expected");
        },
        interval,
      ),
      /DTM_COLLECTION_INTERVAL_MINUTES/,
    );
  }
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM collection_lock").get()
      ?.count,
    0,
  );
});
