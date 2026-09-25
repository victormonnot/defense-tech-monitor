import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MonitorStore } from "../src/lib/store";
import type { FeedEntry } from "../src/lib/feed";

// Synthetic fixtures stored in isolated in-memory databases; no network requests.
const collectedAt = "2026-01-02T12:00:00.000Z";
function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}
function source(store: MonitorStore, name = "alpha") {
  return store.addSource({
    name: `Fixture ${name}`,
    siteUrl: `https://${name}.example.test/`,
    feedUrl: `https://${name}.example.test/feed`,
    language: "en",
  });
}
function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    guid: "fixture-one",
    url: "https://alpha.example.test/articles/one",
    title: "Synthetic drone article",
    publishedAt: null,
    text: "Fixture text about a drone.",
    excerpt: "Fixture text about a drone.",
    language: "en",
    format: "article",
    contentHash: "fixture-hash-one",
    ...overrides,
  };
}

test("reimporting the same entry is idempotent and preserves its collection time", (t) => {
  const store = storeFor(t);
  const sourceId = source(store);
  assert.deepEqual(store.upsertEntries(sourceId, [entry()], collectedAt), {
    added: 1,
    updated: 0,
  });
  assert.deepEqual(
    store.upsertEntries(sourceId, [entry()], "2026-01-03T12:00:00.000Z"),
    { added: 0, updated: 0 },
  );
  const snapshot = store.snapshot();
  assert.equal(snapshot.articles.length, 1);
  assert.equal(snapshot.articles[0].collectedAt, collectedAt);
  assert.equal(snapshot.articles[0].publishedAt, null);
  assert.equal(snapshot.sources[0].articleCount, 1);
});

test("a corrected article retains saved, read and feedback state", (t) => {
  const store = storeFor(t);
  const sourceId = source(store);
  store.upsertEntries(sourceId, [entry()], collectedAt);
  const originalId = store.snapshot().articles[0].id;
  store.setArticleState(originalId, "saved", true);
  store.setArticleState(originalId, "is_read", true);
  store.setArticleState(originalId, "feedback", "relevant");
  assert.deepEqual(
    store.upsertEntries(
      sourceId,
      [
        entry({
          title: "Corrected synthetic drone article",
          text: "Corrected fixture text",
          contentHash: "fixture-hash-two",
        }),
      ],
      collectedAt,
    ),
    { added: 0, updated: 1 },
  );
  const [article] = store.snapshot().articles;
  assert.equal(article.id, originalId);
  assert.equal(article.title, "Corrected synthetic drone article");
  assert.equal(article.saved, true);
  assert.equal(article.isRead, true);
  assert.equal(article.feedback, "relevant");
});

test("the same URL with a changed feed GUID still represents one article", (t) => {
  const store = storeFor(t);
  const sourceId = source(store);
  store.upsertEntries(sourceId, [entry()], collectedAt);
  store.upsertEntries(
    sourceId,
    [
      entry({
        guid: "fixture-renamed",
        title: "Corrected fixture",
        contentHash: "fixture-renamed-hash",
      }),
    ],
    collectedAt,
  );
  assert.equal(store.snapshot().articles.length, 1);
  assert.equal(store.snapshot().articles[0].title, "Corrected fixture");
});

test("a stable feed GUID updates a publisher's changed article URL", (t) => {
  const store = storeFor(t);
  const sourceId = source(store);
  store.upsertEntries(sourceId, [entry()], collectedAt);
  const updated = entry({
    url: "https://alpha.example.test/articles/renamed",
    contentHash: "fixture-new-url-hash",
  });
  store.upsertEntries(sourceId, [updated], collectedAt);
  store.upsertEntries(sourceId, [updated], collectedAt);
  assert.equal(store.snapshot().articles.length, 1);
  assert.equal(store.snapshot().articles[0].url, updated.url);
});

test("articles from different sources are not merged because they share a theme or GUID", (t) => {
  const store = storeFor(t);
  const first = source(store, "alpha");
  const second = source(store, "beta");
  store.upsertEntries(first, [entry()], collectedAt);
  store.upsertEntries(
    second,
    [
      entry({
        url: "https://beta.example.test/articles/two",
        title: "Another synthetic drone article",
      }),
    ],
    collectedAt,
  );
  const articles = store.snapshot().articles;
  assert.equal(articles.length, 2);
  assert.equal(new Set(articles.map((article) => article.sourceId)).size, 2);
  assert.ok(articles.every((article) => article.themes.includes("Drones")));
});

test("a changed profile immediately reclassifies stored articles without reimporting", (t) => {
  const store = storeFor(t);
  const sourceId = source(store);
  store.upsertEntries(sourceId, [entry()], collectedAt);
  store.setProfile({ keywords: ["funding"], excludeKeywords: [], minScore: 1 });
  const before = store.snapshot();
  assert.equal(before.stats.selected, 0);
  store.setProfile({ keywords: ["drone"], excludeKeywords: [], minScore: 1 });
  const after = store.snapshot();
  assert.equal(after.stats.selected, 1);
  assert.equal(after.articles[0].id, before.articles[0].id);
  assert.deepEqual(after.profile.keywords, ["drone"]);
});

test("evaluation exposes false negatives and false positives before feedback filtering", (t) => {
  const store = storeFor(t);
  const sourceId = source(store);
  store.setProfile({ keywords: ["drone"], excludeKeywords: [], minScore: 1 });
  store.upsertEntries(
    sourceId,
    [
      entry(),
      entry({
        guid: "fixture-two",
        url: "https://alpha.example.test/articles/two",
        title: "Synthetic funding article",
        text: "Investment fixture",
        contentHash: "fixture-two-hash",
      }),
      entry({
        guid: "fixture-three",
        url: "https://alpha.example.test/articles/three",
        title: "Another synthetic drone article",
        contentHash: "fixture-three-hash",
      }),
    ],
    collectedAt,
  );
  const articles = store.snapshot().articles;
  store.setArticleState(
    articles.find((article) => article.url.endsWith("/one"))!.id,
    "feedback",
    "off_topic",
  );
  store.setArticleState(
    articles.find((article) => article.url.endsWith("/two"))!.id,
    "feedback",
    "relevant",
  );
  store.setArticleState(
    articles.find((article) => article.url.endsWith("/three"))!.id,
    "feedback",
    "seen",
  );
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.evaluation, {
    reviewed: 3,
    missedRelevant: 1,
    selectedOffTopic: 1,
  });
  assert.equal(snapshot.stats.total, 3);
  assert.equal(snapshot.stats.selected, 0);
});

test("metadata-only articles expose a missing excerpt rather than fabricated content", (t) => {
  const store = storeFor(t);
  store.upsertEntries(
    source(store),
    [entry({ text: "", excerpt: null })],
    collectedAt,
  );
  const [article] = store.snapshot().articles;
  assert.equal(article.contentBasis, "metadata");
  assert.equal(article.excerpt, null);
  assert.equal(article.publishedAt, null);
});
