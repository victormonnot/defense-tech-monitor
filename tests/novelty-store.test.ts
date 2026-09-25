import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { FeedEntry } from "../src/lib/feed";
import { MonitorStore } from "../src/lib/store";

const collectedAt = "2026-09-25T12:00:00.000Z";
const updatedAt = "2026-09-26T12:00:00.000Z";

function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}

function addSource(store: MonitorStore, name = "alpha") {
  return store.addSource({
    name,
    siteUrl: `https://${name}.example.test/`,
    feedUrl: `https://${name}.example.test/feed`,
    language: "en",
  });
}

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    guid: "fixture-one",
    url: "https://alpha.example.test/one",
    title: "Synthetic drone trial",
    publishedAt: "2025-01-01T12:00:00.000Z",
    text: "Full synthetic drone trial report.",
    excerpt: "Synthetic drone trial.",
    language: "en",
    format: "article",
    contentHash: "fixture-one-hash",
    ...overrides,
  };
}

test("newness follows first collection rather than publication date and snapshots do not acknowledge it", (t) => {
  const store = storeFor(t);
  const empty = store.snapshot();
  assert.equal(empty.activity.newCount, 0);
  assert.equal(empty.activity.updatedCount, 0);
  assert.equal(empty.activity.lastReviewedAt, null);
  assert.ok(!Number.isNaN(Date.parse(empty.activity.startedAt)));
  store.upsertEntries(addSource(store), [entry()], collectedAt);
  const first = store.snapshot();
  const article = first.articles[0];
  assert.equal(article.publishedAt, "2025-01-01T12:00:00.000Z");
  assert.equal(article.collectedAt, collectedAt);
  assert.equal(article.changeKind, "new");
  assert.equal(article.revision, 1);
  assert.equal(article.updatedAt, null);
  assert.equal(first.activity.newCount, 1);
  assert.equal(first.activity.startedAt, empty.activity.startedAt);
  assert.deepEqual(store.snapshot(), first);
  assert.equal(Object.hasOwn(article, "text"), false);
});

test("repeated collection and hash-only changes leave revision and acknowledgement unchanged", (t) => {
  const store = storeFor(t);
  const source = addSource(store);
  store.upsertEntries(source, [entry()], collectedAt);
  const article = store.snapshot().articles[0];
  store.acknowledgeChanges([article]);
  const before = store.snapshot();
  assert.deepEqual(store.upsertEntries(source, [entry()], updatedAt), {
    added: 0,
    updated: 0,
  });
  store.upsertEntries(
    source,
    [entry({ contentHash: "different-hash" })],
    updatedAt,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(
    store.db
      .prepare("SELECT content_hash FROM articles WHERE id=?")
      .get(article.id)?.content_hash,
    "different-hash",
  );
});

test("every changed collected field advances revision even when a feed reuses its hash", async (t) => {
  const changes: Partial<FeedEntry>[] = [
    { url: "https://alpha.example.test/renamed" },
    { title: "Corrected synthetic trial" },
    { publishedAt: null },
    { text: "Corrected full synthetic trial report." },
    { excerpt: "Corrected synthetic excerpt." },
    { language: "uk" },
    { format: "video" },
    { contentBasis: "page_excerpt" },
  ];
  for (const change of changes) {
    await t.test(Object.keys(change)[0], (t) => {
      const store = storeFor(t);
      const source = addSource(store);
      store.upsertEntries(source, [entry()], collectedAt);
      const original = store.snapshot().articles[0];
      store.acknowledgeChanges([original]);
      store.upsertEntries(source, [entry(change)], updatedAt);
      const article = store.snapshot().articles[0];
      assert.equal(article.id, original.id);
      assert.equal(article.revision, 2);
      assert.equal(article.changeKind, "updated");
      assert.equal(article.collectedAt, collectedAt);
      assert.equal(article.updatedAt, updatedAt);
      assert.equal(store.snapshot().activity.newCount, 0);
      assert.equal(store.snapshot().activity.updatedCount, 1);
      store.upsertEntries(source, [entry(change)], updatedAt);
      assert.equal(store.snapshot().articles[0].revision, 2);
    });
  }
});

test("a publication remains new when it changes before the first explicit acknowledgement", (t) => {
  const store = storeFor(t);
  const source = addSource(store);
  store.upsertEntries(source, [entry()], collectedAt);
  store.upsertEntries(source, [entry({ title: "Revised title" })], updatedAt);
  const snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].revision, 2);
  assert.equal(snapshot.articles[0].changeKind, "new");
  assert.equal(snapshot.activity.newCount, 1);
  assert.equal(snapshot.activity.updatedCount, 0);
  assert.equal(snapshot.activity.lastReviewedAt, null);
});

test("acknowledging a stale snapshot cannot hide a concurrent change with the same collection timestamp", (t) => {
  const store = storeFor(t);
  const source = addSource(store);
  store.upsertEntries(source, [entry()], collectedAt);
  const captured = store.snapshot().articles[0];
  store.upsertEntries(
    source,
    [entry({ title: "A later correction" })],
    collectedAt,
  );
  assert.equal(store.acknowledgeChanges([captured]), 1);
  const latest = store.snapshot();
  assert.equal(latest.articles[0].changeKind, "updated");
  assert.equal(latest.articles[0].revision, 2);
  assert.equal(latest.articles[0].updatedAt, collectedAt);
  assert.equal(latest.activity.updatedCount, 1);
  assert.equal(store.acknowledgeChanges(latest.articles), 1);
  const acknowledged = store.snapshot();
  assert.equal(acknowledged.articles[0].changeKind, null);
  assert.equal(store.acknowledgeChanges([captured]), 0);
  assert.deepEqual(store.snapshot(), acknowledged);
});

test("acknowledgement is limited to the submitted source or filtered articles", (t) => {
  const store = storeFor(t);
  const firstSource = addSource(store);
  const secondSource = addSource(store, "beta");
  store.upsertEntries(
    firstSource,
    [entry(), entry({ guid: "two", url: "https://alpha.example.test/two" })],
    collectedAt,
  );
  store.upsertEntries(
    secondSource,
    [entry({ url: "https://beta.example.test/one" })],
    collectedAt,
  );
  const all = store.snapshot().articles;
  const first = all.find((article) => article.sourceId === firstSource)!;
  assert.equal(store.acknowledgeChanges([first]), 1);
  const after = store.snapshot();
  assert.equal(after.activity.newCount, 2);
  assert.equal(
    after.articles.find((article) => article.id === first.id)?.changeKind,
    null,
  );
  assert.ok(
    after.articles
      .filter((article) => article.id !== first.id)
      .every((article) => article.changeKind === "new"),
  );
});

test("duplicate acknowledgement items advance each article once and stale acknowledgements are monotonic", (t) => {
  const store = storeFor(t);
  const source = addSource(store);
  store.upsertEntries(source, [entry()], collectedAt);
  const initial = store.snapshot().articles[0];
  store.upsertEntries(source, [entry({ title: "Revised title" })], updatedAt);
  const revised = store.snapshot().articles[0];
  assert.equal(
    store.acknowledgeChanges([initial, revised, initial, revised]),
    1,
  );
  const after = store.snapshot();
  assert.ok(after.activity.lastReviewedAt);
  assert.equal(after.articles[0].changeKind, null);
  assert.equal(store.acknowledgeChanges([initial, initial]), 0);
  assert.equal(store.acknowledgeChanges([]), 0);
  assert.deepEqual(store.snapshot(), after);
});

test("unknown articles and future revisions roll back the entire acknowledgement batch", async (t) => {
  for (const kind of ["unknown", "future"] as const) {
    await t.test(kind, (t) => {
      const store = storeFor(t);
      const source = addSource(store);
      store.upsertEntries(
        source,
        [
          entry(),
          entry({ guid: "two", url: "https://alpha.example.test/two" }),
        ],
        collectedAt,
      );
      const before = store.snapshot();
      const [first, second] = before.articles;
      const invalid =
        kind === "unknown"
          ? { id: "missing", revision: 1 }
          : { id: second.id, revision: 2 };
      assert.throws(
        () => store.acknowledgeChanges([first, invalid]),
        /Publication inconnue ou version plus récente/,
      );
      assert.deepEqual(store.snapshot(), before);
      assert.equal(store.acknowledgeChanges([first]), 1);
    });
  }
});

test("invalid acknowledgement bounds are rejected without writing metadata", (t) => {
  const store = storeFor(t);
  const source = addSource(store);
  store.upsertEntries(source, [entry()], collectedAt);
  const before = store.snapshot();
  const article = before.articles[0];
  for (const revision of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => store.acknowledgeChanges([{ id: article.id, revision }]),
      /Publications à valider invalides/,
    );
  }
  assert.throws(
    () => store.acknowledgeChanges([{ id: "", revision: 1 }]),
    /Publications à valider invalides/,
  );
  assert.throws(
    () => store.acknowledgeChanges(Array.from({ length: 201 }, () => article)),
    /Publications à valider invalides/,
  );
  assert.deepEqual(store.snapshot(), before);
});

test("reading, saving, feedback, grouping choices and profile previews never acknowledge activity", (t) => {
  const store = storeFor(t);
  const source = addSource(store);
  store.upsertEntries(source, [entry()], collectedAt);
  const initial = store.snapshot();
  const id = initial.articles[0].id;
  store.setArticleState(id, "is_read", true);
  store.setArticleState(id, "saved", true);
  store.setArticleState(id, "feedback", "seen");
  store.setArticleState(id, "keep_separate", true);
  const profile = { keywords: ["radar"], excludeKeywords: [], minScore: 1 };
  store.previewProfile(profile);
  store.setProfile(profile);
  store.toggleSource(source, false);
  assert.deepEqual(store.snapshot().activity, initial.activity);
  assert.equal(store.snapshot().articles[0].changeKind, "new");
  store.upsertEntries(
    source,
    [entry({ title: "Corrected synthetic trial" })],
    updatedAt,
  );
  const beforeAck = store.snapshot().articles[0];
  assert.equal(beforeAck.isRead, true);
  assert.equal(beforeAck.saved, true);
  assert.equal(beforeAck.feedback, "seen");
  assert.equal(beforeAck.keepSeparate, true);
  store.acknowledgeChanges([beforeAck]);
  const afterAck = store.snapshot().articles[0];
  assert.deepEqual({ ...afterAck, changeKind: "new" }, beforeAck);
  assert.deepEqual(store.profile(), profile);
});

test("activity revisions and acknowledgement metadata survive reopening the database", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-activity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const original = new MonitorStore(path, false);
  const source = addSource(original);
  original.upsertEntries(source, [entry()], collectedAt);
  original.acknowledgeChanges(original.snapshot().articles);
  original.upsertEntries(
    source,
    [entry({ title: "Corrected synthetic trial" })],
    updatedAt,
  );
  const before = original.snapshot();
  original.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(reopened.snapshot(), before);
    assert.equal(reopened.snapshot().articles[0].changeKind, "updated");
  } finally {
    reopened.db.close();
  }
});
