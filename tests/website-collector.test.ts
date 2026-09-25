import assert from "node:assert/strict";
import test from "node:test";
import { collectSources } from "../src/lib/collector";
import { resolveCollection } from "../src/lib/connectors";
import { MonitorStore } from "../src/lib/store";

const brave1 = `<app-news-home-list><app-news-cards-list><app-news-card>
  <h3 class="block__title"><a class="block__title-link" href="/en/news/langPrefix/news/fixture-robot">Fixture robot update</a></h3>
  <time datetime="2026-09-25T09:00:00Z"></time>
</app-news-card></app-news-cards-list></app-news-home-list>`;
const defender = `<article class="one-news">
  <h2 class="entry-title"><a href="/en/2026/09/fixture-robot/">Fixture robot research</a></h2>
  <time class="published" datetime="2026-09-24T12:00:00+03:00"></time>
  <a class="excerpt-link" href="/en/2026/09/fixture-robot/"><p>Synthetic excerpt about robot navigation.</p></a>
</article>`;

test("website connectors collect one page each and persist truthful provenance without duplicate imports", async (t) => {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  const braveId = store.addSource({
    name: "Brave1",
    siteUrl: "https://brave1.gov.ua/en",
    feedUrl: null,
    language: "und",
  });
  store.addSource({
    name: "Defender Media",
    siteUrl: "https://thedefender.media/en/",
    feedUrl: null,
    language: "und",
  });
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    return {
      url,
      status: 200,
      headers: { etag: '"page-v1"' },
      body: url.includes("brave1") ? brave1 : defender,
    };
  };
  assert.equal((await collectSources(store, fetcher)).added, 2);
  assert.deepEqual(requests, [
    "https://brave1.gov.ua/en/news",
    "https://thedefender.media/en/",
  ]);
  const snapshot = store.snapshot();
  assert.ok(
    snapshot.sources.every(
      (s) => s.status === "ok" && s.collectionKind === "website",
    ),
  );
  const metadata = snapshot.articles.find((a) => a.sourceId === braveId)!;
  assert.equal(metadata.contentBasis, "metadata");
  assert.equal(metadata.excerpt, null);
  assert.equal(metadata.language, "en");
  assert.equal(
    snapshot.articles.find((a) => a.id !== metadata.id)?.contentBasis,
    "page_excerpt",
  );
  store.setArticleState(metadata.id, "saved", true);
  store.setArticleState(metadata.id, "is_read", true);
  store.setArticleState(metadata.id, "feedback", "relevant");
  store.db.exec("UPDATE sources SET last_checked_at='2020-01-01T00:00:00Z'");
  const repeated = await collectSources(store, fetcher);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.updated, 0);
  const after = store.snapshot().articles.find((a) => a.id === metadata.id)!;
  assert.equal(after.saved, true);
  assert.equal(after.isRead, true);
  assert.equal(after.feedback, "relevant");
  assert.equal(after.collectedAt, metadata.collectedAt);

  store.db.exec("UPDATE sources SET last_checked_at='2020-01-01T00:00:00Z'");
  const broken = await collectSources(store, async (url) => ({
    url,
    status: 200,
    headers: {},
    body: "<html>Changed page</html>",
  }));
  assert.equal(broken.failed, 2);
  assert.equal(store.snapshot().articles.length, 2);
  assert.ok(
    store
      .sources()
      .every((s) => s.status === "error" && s.lastError && s.lastSuccessAt),
  );
});

test("explicit feeds take precedence and only supported English pages receive website adapters", async () => {
  assert.equal(
    resolveCollection("https://brave1.gov.ua/en", "https://example.com/feed")
      ?.kind,
    "rss",
  );
  assert.equal(
    resolveCollection("https://thedefender.media/en", null)?.kind,
    "website",
  );
  for (const site of [
    "https://brave1.gov.ua.evil.example/en",
    "https://thedefender.media/uk/",
    "https://brave1.gov.ua/en/news/an-article",
    "https://example.com/en/",
    "javascript:alert(1)",
  ]) {
    assert.equal(resolveCollection(site, null), null);
  }
  const target = resolveCollection("https://brave1.gov.ua/en", null)!;
  assert.throws(
    () => target.parse(brave1, "https://brave1.gov.ua/uk/news", "en"),
    /redirigé/,
  );
  assert.throws(
    () => target.parse(brave1, "https://external.example/en/news", "en"),
    /redirigé/,
  );
});

test("source edits preserve identity, articles and disabled state while clearing obsolete validators", () => {
  const store = new MonitorStore(":memory:", false);
  try {
    const siteUrl = "https://brave1.gov.ua/en";
    const id = store.addSource({
      name: "Brave1",
      siteUrl,
      feedUrl: "https://example.com/feed",
      language: "en",
    });
    store.toggleSource(id, false);
    store.db
      .prepare(
        "UPDATE sources SET etag='old',last_feed_count=5,last_success_at='2026-01-01' WHERE id=?",
      )
      .run(id);
    const updatedId = store.addSource({
      name: "My Brave1",
      siteUrl,
      feedUrl: null,
      language: "en",
    });
    assert.equal(id, updatedId);
    assert.equal(store.sources().length, 1);
    assert.equal(store.sources()[0].enabled, false);
    assert.equal(store.sources()[0].collectionKind, "website");
    assert.equal(store.sources()[0].lastSuccessAt, null);
    const cache = store.db
      .prepare("SELECT etag,last_feed_count FROM sources WHERE id=?")
      .get(id);
    assert.equal(cache?.etag, null);
    assert.equal(cache?.last_feed_count, null);
    store.db
      .prepare(
        "UPDATE sources SET status='ok',etag='current',last_success_at='2026-09-25' WHERE id=?",
      )
      .run(id);
    store.addSource({
      name: "Renamed Brave1",
      siteUrl,
      feedUrl: null,
      language: "en",
    });
    assert.equal(store.sources()[0].name, "Renamed Brave1");
    assert.equal(store.sources()[0].enabled, false);
    assert.equal(store.sources()[0].status, "ok");
    assert.equal(store.sources()[0].lastSuccessAt, "2026-09-25");
    assert.equal(
      store.db.prepare("SELECT etag FROM sources WHERE id=?").get(id)?.etag,
      "current",
    );
  } finally {
    store.db.close();
  }
});
