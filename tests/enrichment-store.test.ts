import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  saveArticleContent,
  type ArticleContentResult,
} from "../src/lib/article-content-store";
import { GENERAL_FEED } from "../src/lib/custom-feeds";
import type { FeedEntry } from "../src/lib/feed";
import { JEV_MODEL } from "../src/lib/jev-client";
import {
  claimJev,
  jevSnapshot,
  setJevMode,
  settleJev,
} from "../src/lib/jev-store";
import { DEFAULT_SUMMARY_MODEL } from "../src/lib/summary-models";
import {
  claimSummary,
  settleSummary,
  summaryArticle,
  summarySnapshot,
} from "../src/lib/summary-store";
import { MonitorStore } from "../src/lib/store";

const now = Date.parse("2026-09-26T12:00:00.000Z");
const next = now + 7 * 86400000;
const iso = (time: number) => new Date(time).toISOString();
const body =
  "The public report describes a synthetic platform and explains the scope of the demonstration. Its authors provide contextual observations about the equipment and the working conditions. ".repeat(
    5,
  ) + " A unique full body marker mentions synthetic-navigation.";
const config = {
  apiKey: "synthetic-never-sent",
  monthlyBudgetUsd: 3,
  error: null,
};
const result: ArticleContentResult = {
  text: body,
  status: "success",
  error: null,
  etag: '"synthetic-v1"',
  lastModified: "Sat, 26 Sep 2026 10:00:00 GMT",
};

function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}

function fixture(
  store: MonitorStore,
  changes: Partial<FeedEntry> = {},
  defender = false,
) {
  const sourceId = store.addSource({
    name: defender ? "Synthetic Defender" : "Synthetic Brave1",
    siteUrl: defender
      ? "https://thedefender.media/en/"
      : "https://brave1.gov.ua/en",
    feedUrl: null,
    language: "en",
  });
  const entry: FeedEntry = {
    guid: "synthetic-one",
    url: defender
      ? "https://thedefender.media/en/2026/09/synthetic-platform/"
      : "https://brave1.gov.ua/en/news/synthetic-platform",
    title: "Acme unveils Orion synthetic platform",
    publishedAt: "2026-09-26T10:00:00.000Z",
    text: "",
    excerpt: null,
    contentBasis: "metadata",
    language: "en",
    format: "article",
    contentHash: "synthetic-metadata-hash",
    ...changes,
  };
  store.upsertEntries(sourceId, [entry], iso(now - 1000));
  const row = store.db
    .prepare("SELECT id FROM articles WHERE source_id=? AND guid=?")
    .get(sourceId, entry.guid)!;
  const id = String(row.id);
  return {
    id,
    sourceId,
    entry,
    expected: { url: entry.url, language: entry.language },
  };
}

test("enriched text drives rule selection and the input view without replacing raw listing data or exposing the body", (t) => {
  const store = storeFor(t);
  const article = fixture(store);
  store.setProfile({
    keywords: ["synthetic-navigation"],
    excludeKeywords: [],
    minScore: 1,
    matchScope: "all_text",
  });
  const before = store.db
    .prepare("SELECT * FROM articles WHERE id=?")
    .get(article.id)!;
  assert.equal(store.snapshot().articles[0].score, 0);
  assert.equal(
    saveArticleContent(store, article.id, article.expected, result, now, next),
    true,
  );
  const current = store.snapshot();
  const enriched = current.articles[0];
  assert.equal(enriched.contentBasis, "page_text");
  assert.equal(enriched.excerpt, body.slice(0, 480));
  assert.equal(enriched.score, 1);
  assert.equal(enriched.revision, Number(before.revision) + 1);
  assert.equal(enriched.updatedAt, iso(now));
  assert.equal(enriched.collectedAt, before.collected_at);
  assert.equal(JSON.stringify(current).includes(body), false);
  assert.equal(
    JSON.stringify(current).includes("A unique full body marker"),
    false,
  );
  assert.equal("text" in enriched, false);
  assert.deepEqual(
    {
      ...store.db.prepare("SELECT * FROM articles WHERE id=?").get(article.id),
    },
    { ...before, revision: Number(before.revision) + 1, updated_at: iso(now) },
  );
  assert.equal(
    store.db
      .prepare("SELECT text FROM article_inputs WHERE id=?")
      .get(article.id)?.text,
    body,
  );
  assert.deepEqual(current.sources[0].content, {
    available: 1,
    pending: 0,
    failed: 0,
  });
  const writes = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  store.snapshot();
  store.previewProfile({ ...store.profile(), matchScope: "title_excerpt" });
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    writes,
  );
});

test("listing refreshes, unchanged successful fetches and failed attempts preserve enriched content and personal state", (t) => {
  const store = storeFor(t);
  const article = fixture(store);
  store.setArticleState(article.id, "is_read", true);
  store.setArticleState(article.id, "saved", true);
  store.setArticleState(article.id, "feedback", "off_topic");
  store.setArticleState(article.id, "keep_separate", true);
  const folder = store.createFolder("Synthetic dossier");
  store.setArticleFolder(article.id, folder, true);
  const feed = store.saveCustomFeed(null, {
    ...GENERAL_FEED,
    name: "Synthetic feed",
  });
  store.setFeedFeedback(article.id, feed, "relevant");
  store.acknowledgeChanges(store.snapshot().articles);
  const initial = store.db
    .prepare("SELECT * FROM articles WHERE id=?")
    .get(article.id)!;
  saveArticleContent(store, article.id, article.expected, result, now, next);
  const after = store.db
    .prepare("SELECT * FROM articles WHERE id=?")
    .get(article.id)!;
  assert.deepEqual(
    { ...after },
    {
      ...initial,
      revision: Number(initial.revision) + 1,
      updated_at: iso(now),
    },
  );
  const personal = store.snapshot().articles[0];
  assert.equal(personal.isRead, true);
  assert.equal(personal.saved, true);
  assert.equal(personal.feedback, "off_topic");
  assert.equal(personal.keepSeparate, true);
  assert.deepEqual(personal.folderIds, [folder]);
  assert.equal(personal.feedFeedback?.[feed], "relevant");
  assert.equal(personal.changeKind, "updated");
  assert.deepEqual(
    store.upsertEntries(article.sourceId, [article.entry], iso(now + 1000)),
    { added: 0, updated: 0 },
  );
  saveArticleContent(
    store,
    article.id,
    article.expected,
    result,
    now + 2000,
    next + 2000,
  );
  assert.deepEqual(
    store.db.prepare("SELECT * FROM articles WHERE id=?").get(article.id),
    after,
  );
  const success = store.db
    .prepare("SELECT * FROM article_content WHERE article_id=?")
    .get(article.id)!;
  assert.equal(success.retrieved_at, iso(now + 2000));
  saveArticleContent(
    store,
    article.id,
    article.expected,
    {
      text: null,
      status: "error",
      error: "Synthetic transient failure",
      etag: null,
      lastModified: null,
    },
    now + 3000,
    next + 3000,
  );
  const failed = store.db
    .prepare("SELECT * FROM article_content WHERE article_id=?")
    .get(article.id)!;
  assert.equal(failed.text, body);
  assert.equal(failed.retrieved_at, success.retrieved_at);
  assert.equal(failed.etag, success.etag);
  assert.equal(failed.last_modified, success.last_modified);
  assert.equal(failed.checked_at, iso(now + 3000));
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "Synthetic transient failure");
  assert.deepEqual(
    store.db.prepare("SELECT * FROM articles WHERE id=?").get(article.id),
    after,
  );
  assert.deepEqual(store.snapshot().sources[0].content, {
    available: 1,
    pending: 0,
    failed: 1,
  });
  assert.equal(store.snapshot().articles[0].contentBasis, "page_text");
});

test("URL and language changes hide incompatible content and obsolete completions do not write", (t) => {
  const store = storeFor(t);
  const article = fixture(store);
  saveArticleContent(store, article.id, article.expected, result, now, next);
  for (const changed of [
    { ...article.entry, url: "https://brave1.gov.ua/en/news/changed-platform" },
    { ...article.entry, language: "uk" },
  ]) {
    store.upsertEntries(article.sourceId, [changed], iso(now + 1000));
    const before = store.db
      .prepare("SELECT total_changes() AS count")
      .get()?.count;
    assert.equal(
      saveArticleContent(
        store,
        article.id,
        article.expected,
        result,
        now + 2000,
        next,
      ),
      false,
    );
    assert.equal(
      store.db.prepare("SELECT total_changes() AS count").get()?.count,
      before,
    );
    assert.equal(store.snapshot().articles[0].contentBasis, "metadata");
    assert.equal(summaryArticle(store, article.id).text, "");
    assert.equal(
      summarySnapshot(store, undefined, config, now).state.eligible,
      0,
    );
  }
  const latest = { url: article.entry.url, language: "uk" };
  saveArticleContent(
    store,
    article.id,
    latest,
    {
      text: null,
      status: "unavailable",
      error: "No matching public content",
      etag: null,
      lastModified: null,
    },
    now + 3000,
    next,
  );
  assert.equal(
    store.db
      .prepare("SELECT text FROM article_content WHERE article_id=?")
      .get(article.id)?.text,
    null,
  );
  assert.equal(store.snapshot().articles[0].contentBasis, "metadata");
  assert.equal(
    saveArticleContent(
      store,
      "deleted-article",
      article.expected,
      result,
      now,
      next,
    ),
    false,
  );
});

test("matching raw text still advances the revision when enrichment changes its provenance or excerpt", (t) => {
  const store = storeFor(t);
  const article = fixture(store, {
    text: body,
    excerpt: "Synthetic shorter listing excerpt",
    contentBasis: "page_excerpt",
  });
  const before = store.snapshot().articles[0];
  saveArticleContent(store, article.id, article.expected, result, now, next);
  const current = store.snapshot().articles[0];
  assert.equal(current.revision, before.revision + 1);
  assert.equal(current.contentBasis, "page_text");
  assert.equal(current.excerpt, body.slice(0, 480));
  saveArticleContent(
    store,
    article.id,
    article.expected,
    result,
    now + 1,
    next,
  );
  assert.equal(store.snapshot().articles[0].revision, current.revision);
});

test("Jev and summary claims use enriched content and cached outputs stop applying after the body changes", (t) => {
  const store = storeFor(t);
  const article = fixture(store);
  setJevMode(store, "personal", config);
  const old = claimJev(store, config, now)!;
  assert.equal(old.request.state.article.content, "");
  settleJev(
    store,
    old,
    {
      score: 2,
      confidence: 0.9,
      kind: "technical",
      kindConfidence: 0.9,
      model: JEV_MODEL,
      inputTokens: 100,
    },
    now,
  );
  assert.equal(
    jevSnapshot(store, undefined, undefined, config, now).state.ready,
    1,
  );
  assert.equal(claimSummary(store, article.id, config, now), null);
  saveArticleContent(
    store,
    article.id,
    article.expected,
    result,
    now + 1,
    next,
  );
  assert.equal(
    jevSnapshot(store, undefined, undefined, config, now).state.ready,
    0,
  );
  const jev = claimJev(store, config, now)!;
  assert.equal(jev.request.state.article.content, body);
  assert.equal(jev.request.state.article.basis, "page_text");
  const summary = claimSummary(store, article.id, config, now)!;
  const sent = JSON.parse(summary.request.input[0].content);
  assert.equal(sent.content, body);
  assert.equal(sent.basis, "page_text");
  settleJev(
    store,
    jev,
    {
      score: 3,
      confidence: 0.9,
      kind: "technical",
      kindConfidence: 0.9,
      model: JEV_MODEL,
      inputTokens: 200,
    },
    now,
  );
  settleSummary(
    store,
    summary,
    {
      outcome: "summary",
      text: "Un résultat synthétique strictement utilisé par ce test local.",
      model: DEFAULT_SUMMARY_MODEL,
      inputTokens: 300,
      outputTokens: 30,
    },
    now,
  );
  assert.equal(
    jevSnapshot(store, undefined, undefined, config, now).state.ready,
    1,
  );
  assert.equal(summarySnapshot(store, undefined, config, now).state.ready, 1);
  saveArticleContent(
    store,
    article.id,
    article.expected,
    { ...result, text: `${body} New synthetic information appears here.` },
    now + 2,
    next,
  );
  assert.equal(
    jevSnapshot(store, undefined, undefined, config, now).state.ready,
    0,
  );
  assert.equal(summarySnapshot(store, undefined, config, now).state.ready, 0);
  assert.equal(store.snapshot().articles[0].jev, undefined);
  assert.equal(store.snapshot().articles[0].summary?.text, undefined);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jev_cache").get()?.count,
    2,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_cache").get()
      ?.count,
    1,
  );
});

test("grouping compares full enriched bodies even when visible excerpts match", (t) => {
  const store = storeFor(t);
  const a = fixture(store);
  const b = fixture(store, {}, true);
  assert.equal(store.snapshot().stories.groups.length, 1);
  saveArticleContent(store, a.id, a.expected, result, now, next);
  saveArticleContent(store, b.id, b.expected, result, now, next);
  assert.equal(store.snapshot().stories.groups.length, 1);
  saveArticleContent(
    store,
    b.id,
    b.expected,
    {
      ...result,
      text: `${body} Distinct source detail at the end of the available report.`,
    },
    now + 1,
    next,
  );
  const snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].excerpt, snapshot.articles[1].excerpt);
  assert.equal(snapshot.stories.groups.length, 0);
  assert.equal(snapshot.stories.related.length, 1);
});

test("source coverage counts only eligible article URLs and treats incompatible cached keys as pending", (t) => {
  const store = storeFor(t);
  const a = fixture(store);
  const b = fixture(store, {
    guid: "two",
    url: "https://brave1.gov.ua/en/news/second-platform",
  });
  fixture(store, {
    guid: "video",
    url: "https://brave1.gov.ua/en/news/video-platform",
    format: "video",
  });
  fixture(store, {
    guid: "language",
    url: "https://brave1.gov.ua/en/news/translated-platform",
    language: "uk",
  });
  fixture(store, { guid: "external", url: "https://example.test/external" });
  assert.deepEqual(store.sources()[0].content, {
    available: 0,
    pending: 2,
    failed: 0,
  });
  saveArticleContent(store, a.id, a.expected, result, now, next);
  saveArticleContent(
    store,
    b.id,
    b.expected,
    {
      text: null,
      status: "unavailable",
      error: null,
      etag: null,
      lastModified: null,
    },
    now,
    next,
  );
  assert.deepEqual(store.sources()[0].content, {
    available: 1,
    pending: 0,
    failed: 1,
  });
  store.upsertEntries(
    a.sourceId,
    [{ ...a.entry, url: "https://brave1.gov.ua/en/news/revised-platform" }],
    iso(now + 1),
  );
  assert.deepEqual(store.sources()[0].content, {
    available: 0,
    pending: 1,
    failed: 1,
  });
  const rss = store.addSource({
    name: "Synthetic RSS",
    siteUrl: "https://example.test",
    feedUrl: "https://example.test/rss",
    language: "en",
  });
  assert.equal(
    store.sources().find((source) => source.id === rss)?.content,
    undefined,
  );
});

test("invalid results and a failed in-transaction guard leave article content and revisions untouched", (t) => {
  const store = storeFor(t);
  const article = fixture(store);
  const before = store.db.prepare("SELECT * FROM articles").all();
  for (const invalid of [
    { ...result, text: "Short" },
    { ...result, text: "x".repeat(20001) },
    { ...result, text: null },
    { ...result, status: "error" as const },
    { ...result, error: "x".repeat(501) },
  ])
    assert.throws(() =>
      saveArticleContent(
        store,
        article.id,
        article.expected,
        invalid,
        now,
        next,
      ),
    );
  for (const dates of [
    [NaN, next],
    [now, Infinity],
    [now, now - 1],
  ])
    assert.throws(() =>
      saveArticleContent(
        store,
        article.id,
        article.expected,
        result,
        dates[0],
        dates[1],
      ),
    );
  assert.throws(
    () =>
      saveArticleContent(
        store,
        article.id,
        article.expected,
        result,
        now,
        next,
        () => {
          store.db
            .prepare(
              "INSERT INTO settings VALUES ('synthetic_guard_marker','rollback')",
            )
            .run();
          throw new Error("Collection lease lost");
        },
      ),
    /lease lost/,
  );
  assert.equal(
    store.db
      .prepare("SELECT value FROM settings WHERE key='synthetic_guard_marker'")
      .get(),
    undefined,
  );
  assert.deepEqual(store.db.prepare("SELECT * FROM articles").all(), before);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM article_content").get()
      ?.count,
    0,
  );
});

test("enrichment survives reopening and is removed with its article", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-enrichment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const original = new MonitorStore(path, false);
  const article = fixture(original);
  saveArticleContent(original, article.id, article.expected, result, now, next);
  const before = original.db.prepare("SELECT * FROM article_content").all();
  original.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(
      reopened.db.prepare("SELECT * FROM article_content").all(),
      before,
    );
    assert.equal(summaryArticle(reopened, article.id).text, body);
    reopened.db.prepare("DELETE FROM articles WHERE id=?").run(article.id);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM article_content").get()
        ?.count,
      0,
    );
  } finally {
    reopened.db.close();
  }
});
