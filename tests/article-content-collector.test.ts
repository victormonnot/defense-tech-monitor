import assert from "node:assert/strict";
import test from "node:test";
import { MonitorStore } from "../src/lib/store";
import { collectSources, type FetchResource } from "../src/lib/collector";
import {
  articleContentTarget,
  sameArticleUrl,
} from "../src/lib/article-content";
import { fetchResource } from "../src/lib/network";

const site = "https://thedefender.media/en/";
const url = "https://thedefender.media/en/2026/09/fixture-robot/";
const start = Date.parse("2026-09-26T10:00:00Z");
const prose =
  "The company is testing a new robot with the research team. The report explains the design and its limitations, and the tests are still in progress. ".repeat(
    5,
  );
const page = (body = prose) =>
  `<html lang="en"><body><section class="blog-post"><div class="blog-post-data"><h1>Robot research</h1></div><div class="blog-post-container"><div class="single-article"><p>${body}</p></div></div></section></body></html>`;
const response = (url: string, body = page(), status = 200) => ({
  url,
  body,
  status,
  headers: { "content-type": "text/html", etag: '"body-v1"' },
});

function setup(count = 1) {
  const store = new MonitorStore(":memory:", false);
  const sourceId = store.addSource({
    name: "Defender",
    siteUrl: site,
    feedUrl: null,
    language: "en",
  });
  store.upsertEntries(
    sourceId,
    Array.from({ length: count }, (_, i) => ({
      guid: `fixture-${i}`,
      url: i ? url.replace("fixture-robot", `fixture-${i}`) : url,
      title: `Fixture robot ${i}`,
      publishedAt: null,
      text: "",
      excerpt: null,
      contentBasis: "metadata" as const,
      contentHash: `metadata-${i}`,
      language: "en",
      format: "article" as const,
    })),
    new Date(start).toISOString(),
  );
  store.db
    .prepare(
      "UPDATE sources SET last_checked_at=?,etag='listing-v1',last_feed_count=? WHERE id=?",
    )
    .run(new Date(start).toISOString(), count, sourceId);
  return { store, sourceId };
}

test("only supported public article URLs qualify, with identity preserved across redirects", async () => {
  assert.ok(articleContentTarget(site, null, url));
  assert.ok(
    articleContentTarget(
      "https://brave1.gov.ua/en",
      null,
      "https://brave1.gov.ua/en/news/robot",
    ),
  );
  for (const candidate of [
    "http://thedefender.media/en/2026/09/robot/",
    "https://thedefender.media.evil.test/en/2026/09/robot/",
    "https://thedefender.media/uk/2026/09/robot/",
    "https://thedefender.media/en/",
    `${url}?preview=true`,
    "https://user:pass@thedefender.media/en/2026/09/robot/",
  ])
    assert.equal(articleContentTarget(site, null, candidate), null);
  assert.equal(
    articleContentTarget(site, "https://example.org/feed", url),
    null,
  );
  assert.equal(articleContentTarget("https://example.org", null, url), null);
  assert.ok(sameArticleUrl(url, `${url.slice(0, -1)}?utm_source=feed`));
  assert.ok(!sameArticleUrl(url, url.replace("fixture-robot", "another")));
  assert.ok(!sameArticleUrl(url, "http://127.0.0.1/"));
  // Reject before robots.txt, DNS resolution or the outbound article request.
  await assert.rejects(
    fetchResource(url, {}, () => false),
    /redirigé/,
  );
});

test("article enrichment fills a bounded backlog despite a recently checked listing", async (t) => {
  const { store } = setup(12);
  t.after(() => store.db.close());
  const requests: string[] = [];
  const fetcher: FetchResource = async (u, _, acceptUrl) => {
    requests.push(u);
    assert.ok(acceptUrl?.(u));
    assert.equal(acceptUrl?.(u.replace("fixture", "wrong")), false);
    return response(u);
  };
  const first = await collectSources(store, fetcher, 15, { now: () => start });
  assert.equal(first.checked, 0);
  assert.equal(first.contentChecked, 10);
  assert.equal(first.contentUpdated, 10);
  assert.equal(first.contentFailed, 0);
  assert.deepEqual(store.sources()[0].content, {
    available: 10,
    pending: 2,
    failed: 0,
  });
  const second = await collectSources(store, fetcher, 15, { now: () => start });
  assert.equal(second.contentChecked, 2);
  assert.equal(new Set(requests).size, 12);
  const after = store.snapshot();
  assert.ok(after.articles.every((a) => a.contentBasis === "page_text"));
  assert.ok(after.articles.every((a) => !Object.hasOwn(a, "text")));
  const third = await collectSources(
    store,
    async () => assert.fail("Cached bodies must not be fetched again"),
    15,
    { now: () => start },
  );
  assert.equal(third.contentChecked, undefined);
});

test("unchanged listings still refresh due articles conditionally and 304 preserves revisions", async (t) => {
  const { store } = setup();
  t.after(() => store.db.close());
  await collectSources(store, async (u) => response(u), 15, {
    now: () => start,
  });
  const before = store.snapshot().articles[0];
  const requests: string[] = [];
  const result = await collectSources(
    store,
    async (u, headers) => {
      requests.push(u);
      assert.equal(
        headers?.["if-none-match"],
        u === site ? "listing-v1" : '"body-v1"',
      );
      return response(u, "", 304);
    },
    15,
    { now: () => start + 8 * 86400000 },
  );
  assert.deepEqual(requests, [site, url]);
  assert.equal(result.contentChecked, 1);
  assert.equal(result.contentUpdated, 0);
  const after = store.snapshot().articles[0];
  assert.equal(after.revision, before.revision);
  assert.equal(after.excerpt, before.excerpt);
});

test("failed or unrecognized pages retain source metadata, respect retry delay and do not fail listing ingestion", async (t) => {
  for (const value of [
    response(url, "Unavailable", 503),
    response(url, "<html>Login required</html>"),
    response(url.replace("fixture-robot", "another")),
    { ...response(url), headers: { "content-type": "application/json" } },
  ]) {
    const { store } = setup();
    t.after(() => store.db.close());
    const result = await collectSources(store, async () => value, 15, {
      now: () => start,
    });
    assert.equal(result.failed, 0);
    assert.equal(result.contentFailed, 1);
    assert.equal(store.snapshot().articles[0].contentBasis, "metadata");
    assert.equal(store.snapshot().collection.lastRun?.status, "partial");
    assert.deepEqual(store.sources()[0].content, {
      available: 0,
      pending: 0,
      failed: 1,
    });
    await collectSources(
      store,
      async () => assert.fail("Retry must wait until the next day"),
      15,
      { now: () => start },
    );
  }
});

test("disabled and reconfigured sources reject an in-flight article response", async (t) => {
  for (const change of ["disable", "language", "url"] as const) {
    const { store, sourceId } = setup();
    t.after(() => store.db.close());
    await collectSources(
      store,
      async (u) => {
        if (change === "disable") store.toggleSource(sourceId, false);
        else if (change === "language")
          store.db
            .prepare("UPDATE sources SET language='uk' WHERE id=?")
            .run(sourceId);
        else
          store.db
            .prepare(
              "UPDATE sources SET site_url='https://example.org' WHERE id=?",
            )
            .run(sourceId);
        return response(u);
      },
      15,
      { now: () => start },
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM article_content").get()?.n,
      0,
    );
    assert.equal(store.snapshot().articles[0].contentBasis, "metadata");
  }
});

test("an expired collection owner cannot persist enriched text", async (t) => {
  const { store } = setup();
  t.after(() => store.db.close());
  await assert.rejects(
    collectSources(
      store,
      async (u) => {
        store.db.exec("UPDATE collection_lock SET owner='another-owner'");
        return response(u);
      },
      15,
      { now: () => start },
    ),
    /verrou/,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM article_content").get()?.n,
    0,
  );
});

test("oversized remote cache validators are ignored without losing extracted text", async (t) => {
  const { store } = setup();
  t.after(() => store.db.close());
  const result = await collectSources(
    store,
    async (u) => ({
      ...response(u),
      headers: { etag: "x".repeat(2001), "last-modified": "x".repeat(2001) },
    }),
    15,
    { now: () => start },
  );
  assert.equal(result.contentUpdated, 1);
  assert.equal(result.contentFailed, 0);
  const row = store.db
    .prepare("SELECT etag,last_modified FROM article_content")
    .get();
  assert.equal(row?.etag, null);
  assert.equal(row?.last_modified, null);
});

for (const disableDuringFetch of [false, true]) {
  test(`the article request limit stays global${disableDuringFetch ? " when a source is disabled during retrieval" : " across supported sources"}`, async (t) => {
    const { store, sourceId } = setup(10);
    t.after(() => store.db.close());
    for (const suffix of ["?edition=second", "?edition=third"]) {
      const id = store.addSource({
        name: suffix,
        siteUrl: site + suffix,
        feedUrl: null,
        language: "en",
      });
      store.db
        .prepare(
          "INSERT INTO articles (id,source_id,guid,url,title,published_at,collected_at,text,excerpt,language,format,content_hash,content_basis) SELECT id||?, ?,guid,url,title,published_at,collected_at,text,excerpt,language,format,content_hash,content_basis FROM articles WHERE source_id=?",
        )
        .run(id, id, sourceId);
      store.db
        .prepare("UPDATE sources SET last_checked_at=? WHERE id=?")
        .run(new Date(start).toISOString(), id);
    }
    const firstSourceId = store.sources()[0].id;
    let requests = 0;
    const result = await collectSources(
      store,
      async (u) => {
        requests += 1;
        if (disableDuringFetch && requests === 10) {
          store.toggleSource(firstSourceId, false);
        }
        return response(u);
      },
      15,
      { now: () => start },
    );
    const expectedUpdates = disableDuringFetch ? 19 : 20;
    assert.equal(requests, 20);
    assert.equal(result.contentChecked, 20);
    assert.equal(result.contentUpdated, expectedUpdates);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM article_content").get()?.n,
      expectedUpdates,
    );
  });
}
