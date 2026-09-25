import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "../src/lib/store";
import type { FeedEntry } from "../src/lib/feed";
import type { Profile } from "../src/lib/types";

const initial: Profile = {
  keywords: ["drone"],
  excludeKeywords: [],
  minScore: 1,
};
function seed(store: MonitorStore) {
  const source = store.addSource({
    name: "Synthetic source",
    siteUrl: "https://fixture.example.test/",
    feedUrl: null,
    language: "en",
  });
  const entries: FeedEntry[] = [
    {
      title: "Synthetic navigation bulletin",
      text: "A prototype drone navigation module. Private test body tail.",
      excerpt: "A prototype navigation module.",
    },
    {
      title: "Synthetic manufacturing report",
      text: "Production capacity is increasing.",
      excerpt: "Production capacity is increasing.",
    },
    {
      title: "Synthetic drone simulator game",
      text: "A drone simulator game.",
      excerpt: "A drone simulator game.",
    },
    { title: "Synthetic drone hardware", text: "", excerpt: null },
  ].map((article, index) => ({
    ...article,
    guid: `fixture-${index}`,
    url: `https://fixture.example.test/${index}`,
    publishedAt: "2026-01-01",
    language: "en",
    format: "article",
    contentHash: `hash-${index}`,
  }));
  store.upsertEntries(source, entries, "2026-01-02T12:00:00.000Z");
  store.setProfile(initial);
  return store.snapshot().articles;
}
function setup(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return { store, articles: seed(store) };
}
function records(store: MonitorStore) {
  return [
    store.db.prepare("SELECT * FROM articles ORDER BY id").all(),
    store.db.prepare("SELECT * FROM settings ORDER BY key").all(),
    store.db.prepare("SELECT * FROM sources ORDER BY id").all(),
  ];
}

test("preview reports entrants and exits without changing profile, feedback or stored content", (t) => {
  const { store, articles } = setup(t);
  const first = articles.find((a) => a.url.endsWith("/0"))!;
  store.setArticleState(first.id, "saved", true);
  store.setArticleState(first.id, "is_read", true);
  store.setArticleState(first.id, "keep_separate", true);
  const before = records(store);
  const snapshot = store.snapshot();
  const draft: Profile = {
    keywords: ["manufacturing"],
    excludeKeywords: [],
    minScore: 1,
    matchScope: "title_excerpt",
  };
  const preview = store.previewProfile(draft);
  assert.equal(preview.currentSelected, 3);
  assert.equal(preview.selected, 1);
  assert.deepEqual(
    preview.entered.map((a) => a.url),
    ["https://fixture.example.test/1"],
  );
  assert.deepEqual(preview.exited.map((a) => a.url).sort(), [
    "https://fixture.example.test/0",
    "https://fixture.example.test/2",
    "https://fixture.example.test/3",
  ]);
  assert.equal(preview.exited.find((a) => a.id === first.id)?.saved, true);
  assert.deepEqual(preview.exited.find((a) => a.id === first.id)?.reasons, [
    "Aucun mot-clé du profil",
  ]);
  assert.deepEqual(records(store), before);
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(preview.evaluation.precision, null);
  assert.equal(preview.evaluation.recall, null);
  assert.ok(!JSON.stringify(preview).includes("Private test body tail"));
  store.setProfile(draft);
  assert.equal(store.snapshot().stats.selected, preview.selected);
  assert.deepEqual(store.snapshot().evaluation, preview.evaluation);
});

test("title and excerpt mode leaves body-only matches out without losing metadata-only articles", (t) => {
  const { store } = setup(t);
  const preview = store.previewProfile({
    ...initial,
    matchScope: "title_excerpt",
  });
  assert.equal(preview.currentSelected, 3);
  assert.equal(preview.selected, 2);
  assert.deepEqual(
    preview.exited.map((a) => a.url),
    ["https://fixture.example.test/0"],
  );
  assert.deepEqual(preview.entered, []);
  assert.equal(store.snapshot().stats.selected, 3);
  assert.deepEqual(store.profile(), initial);
});

test("previews preserve personal overrides while measuring raw rules against relevance feedback", (t) => {
  const { store, articles } = setup(t);
  const byUrl = (suffix: string) =>
    articles.find((a) => a.url.endsWith(suffix))!.id;
  store.setArticleState(byUrl("/1"), "feedback", "relevant");
  store.setArticleState(byUrl("/2"), "feedback", "off_topic");
  store.setArticleState(byUrl("/3"), "feedback", "seen");
  const before = records(store);
  const current = store.snapshot();
  assert.equal(current.stats.selected, 2);
  assert.equal(current.evaluation.missedRelevant, 1);
  assert.equal(current.evaluation.selectedOffTopic, 1);
  assert.equal(current.evaluation.reviewed, 2);
  const draft = {
    keywords: ["manufacturing"],
    excludeKeywords: [],
    minScore: 1,
  };
  const preview = store.previewProfile(draft);
  assert.equal(preview.currentSelected, 2);
  assert.equal(preview.selected, 1);
  // The manually retained publication was already in Pour moi before this draft.
  assert.deepEqual(preview.entered, []);
  assert.deepEqual(
    preview.exited.map((a) => a.url),
    ["https://fixture.example.test/0"],
  );
  assert.equal(preview.evaluation.missedRelevant, 0);
  assert.equal(preview.evaluation.selectedOffTopic, 0);
  assert.equal(preview.evaluation.precision, 1);
  assert.equal(preview.evaluation.recall, 1);
  assert.equal(preview.evaluation.seen, 1);
  assert.deepEqual(records(store), before);
});

test("scope and explicit relevance overrides survive restart, and clearing feedback restores rules", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const store = new MonitorStore(path, false);
  const articles = seed(store);
  const id = articles.find((a) => a.url.endsWith("/2"))!.id;
  const profile: Profile = {
    ...initial,
    excludeKeywords: ["game"],
    matchScope: "title_excerpt",
  };
  store.setProfile(profile);
  store.setArticleState(id, "feedback", "relevant");
  const before = store.snapshot();
  assert.equal(before.articles.find((a) => a.id === id)?.score, 0);
  assert.equal(before.stats.selected, 2);
  assert.equal(before.evaluation.missedRelevant, 1);
  store.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(reopened.snapshot(), before);
    reopened.setArticleState(id, "feedback", null);
    assert.equal(reopened.snapshot().stats.selected, 1);
    assert.equal(reopened.snapshot().evaluation.reviewed, 0);
    assert.deepEqual(reopened.profile(), profile);
  } finally {
    reopened.db.close();
  }
});
