import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { FeedEntry } from "../src/lib/feed";
import { MonitorStore } from "../src/lib/store";

const collectedAt = "2026-09-25T12:00:00.000Z";

function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}

function entry(guid = "one", overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    guid,
    url: `https://source.example.test/${guid}`,
    title: `Synthetic drone trial ${guid}`,
    publishedAt: null,
    text: "Synthetic drone trial report.",
    excerpt: "Synthetic drone trial.",
    language: "en",
    format: "article",
    contentHash: `hash-${guid}`,
    ...overrides,
  };
}

function addArticles(store: MonitorStore, count = 1) {
  const sourceId = store.addSource({
    name: "Synthetic source",
    siteUrl: "https://source.example.test/",
    feedUrl: "https://source.example.test/feed",
    language: "en",
  });
  store.upsertEntries(
    sourceId,
    Array.from({ length: count }, (_, i) => entry(String(i + 1))),
    collectedAt,
  );
  return { sourceId, articles: store.snapshot().articles };
}

test("folder names are normalized and duplicate names include archived folders", (t) => {
  const store = storeFor(t);
  const id = store.createFolder("  De\u0301fense   navale  ");
  const folder = store.snapshot().folders[0];
  assert.equal(folder.name, "Défense navale");
  assert.equal(folder.id, id);
  assert.equal(folder.archived, false);
  assert.equal(folder.articleCount, 0);
  assert.ok(!Number.isNaN(Date.parse(folder.createdAt)));
  assert.throws(() => store.createFolder("DÉFENSE NAVALE"), /déjà ce nom/);
  store.setFolderArchived(id, true);
  assert.throws(() => store.createFolder("Défense navale"), /déjà ce nom/);
  const other = store.createFolder("Autonomie");
  assert.throws(
    () => store.renameFolder(other, "  défense   navale  "),
    /déjà ce nom/,
  );
  assert.equal(
    store.snapshot().folders.find((value) => value.id === other)?.name,
    "Autonomie",
  );
  store.renameFolder(id, "DÉFENSE NAVALE");
  assert.equal(
    store.snapshot().folders.find((value) => value.id === id)?.name,
    "DÉFENSE NAVALE",
  );
});

test("invalid names and unknown folders leave all data unchanged", (t) => {
  const store = storeFor(t);
  const id = store.createFolder("Valid");
  const before = store.snapshot();
  for (const value of [
    "",
    "   ",
    "x".repeat(81),
    "bad\nname",
    "bad\u0000name",
    null,
    42,
  ]) {
    assert.throws(() => store.createFolder(value as string));
    assert.throws(() => store.renameFolder(id, value as string));
  }
  for (const missing of ["", "missing", " ", "x".repeat(201)]) {
    assert.throws(
      () => store.renameFolder(missing, "Renamed"),
      /Dossier inconnu/,
    );
    assert.throws(
      () => store.setFolderArchived(missing, true),
      /Dossier inconnu/,
    );
  }
  assert.throws(
    () => store.setFolderArchived(id, 1 as unknown as boolean),
    /invalide/,
  );
  assert.deepEqual(store.snapshot(), before);
});

test("publications can belong to multiple folders and counts include every personal state", (t) => {
  const store = storeFor(t);
  const { articles } = addArticles(store, 3);
  const first = store.createFolder("Naval");
  const second = store.createFolder("Autonomie");
  store.setArticleState(articles[0].id, "saved", true);
  store.setArticleState(articles[1].id, "feedback", "off_topic");
  store.setArticleState(articles[2].id, "feedback", "seen");
  store.setArticleFolder(articles[0].id, first, true);
  store.setArticleFolder(articles[0].id, second, true);
  store.setArticleFolder(articles[1].id, first, true);
  store.setArticleFolder(articles[2].id, first, true);
  store.setArticleFolder(articles[0].id, first, true);
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.articles[0].folderIds, [second, first]);
  assert.deepEqual(
    snapshot.folders.map((folder) => [folder.id, folder.articleCount]),
    [
      [second, 1],
      [first, 3],
    ],
  );
  assert.equal(snapshot.stats.saved, 1);
  store.setArticleFolder(articles[0].id, first, false);
  store.setArticleFolder(articles[0].id, first, false);
  assert.deepEqual(store.snapshot().articles[0].folderIds, [second]);
  assert.equal(
    store.snapshot().folders.find((folder) => folder.id === first)
      ?.articleCount,
    2,
  );
});

test("archiving keeps assignments while blocking additions until restoration", (t) => {
  const store = storeFor(t);
  const { articles } = addArticles(store, 2);
  const id = store.createFolder("Archived collection");
  store.setArticleFolder(articles[0].id, id, true);
  store.setFolderArchived(id, true);
  const archived = store.snapshot();
  assert.equal(archived.folders[0].archived, true);
  assert.equal(archived.folders[0].articleCount, 1);
  assert.deepEqual(archived.articles[0].folderIds, [id]);
  store.setFolderArchived(id, true);
  store.setArticleFolder(articles[0].id, id, true);
  assert.deepEqual(store.snapshot(), archived);
  assert.throws(
    () => store.setArticleFolder(articles[1].id, id, true),
    /Restaurez le dossier/,
  );
  assert.deepEqual(store.snapshot(), archived);
  store.setArticleFolder(articles[0].id, id, false);
  assert.equal(store.snapshot().folders[0].articleCount, 0);
  store.setFolderArchived(id, false);
  store.setArticleFolder(articles[1].id, id, true);
  assert.deepEqual(store.snapshot().articles[1].folderIds, [id]);
});

test("unknown articles, unknown folders and invalid membership values cannot create orphan assignments", (t) => {
  const store = storeFor(t);
  const { articles } = addArticles(store);
  const folderId = store.createFolder("Collection");
  const before = store.snapshot();
  for (const value of [false, true]) {
    assert.throws(
      () => store.setArticleFolder("missing", folderId, value),
      /Publication inconnue/,
    );
    assert.throws(
      () => store.setArticleFolder(articles[0].id, "missing", value),
      /Dossier inconnu/,
    );
    assert.throws(
      () => store.setArticleFolder("", folderId, value),
      /Publication inconnue/,
    );
    assert.throws(
      () => store.setArticleFolder(articles[0].id, " ", value),
      /Dossier inconnu/,
    );
  }
  assert.throws(
    () =>
      store.setArticleFolder(
        articles[0].id,
        folderId,
        "true" as unknown as boolean,
      ),
    /Classement invalide/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.throws(
    () =>
      store.db
        .prepare("INSERT INTO article_folders VALUES (?,?)")
        .run("missing", folderId),
    /FOREIGN KEY/,
  );
  assert.throws(
    () =>
      store.db
        .prepare("INSERT INTO article_folders VALUES (?,?)")
        .run(articles[0].id, "missing"),
    /FOREIGN KEY/,
  );
  store.setArticleFolder(articles[0].id, folderId, true);
  assert.equal(store.snapshot().folders[0].articleCount, 1);
});

test("folder actions never mark publications read, saved, reviewed or change classification", (t) => {
  const store = storeFor(t);
  const { sourceId, articles } = addArticles(store);
  const articleId = articles[0].id;
  store.setArticleState(articleId, "is_read", true);
  store.setArticleState(articleId, "saved", true);
  store.setArticleState(articleId, "feedback", "relevant");
  store.setArticleState(articleId, "keep_separate", true);
  store.acknowledgeChanges(articles);
  store.upsertEntries(
    sourceId,
    [entry("1", { title: "Synthetic drone correction" })],
    "2026-09-26T12:00:00.000Z",
  );
  const before = store.snapshot();
  const id = store.createFolder("Collection");
  store.setArticleFolder(articleId, id, true);
  store.renameFolder(id, "Revised collection");
  store.setFolderArchived(id, true);
  store.setFolderArchived(id, false);
  const after = store.snapshot();
  assert.deepEqual({ ...after.articles[0], folderIds: [] }, before.articles[0]);
  assert.deepEqual(after.activity, before.activity);
  assert.deepEqual(after.profile, before.profile);
  assert.deepEqual(after.stats, before.stats);
  assert.deepEqual(after.evaluation, before.evaluation);
  const rawBefore = store.db.prepare("SELECT * FROM article_folders").all();
  store.previewProfile({
    keywords: ["radar"],
    excludeKeywords: ["drone"],
    minScore: 1,
  });
  assert.deepEqual(store.snapshot(), after);
  assert.deepEqual(
    store.db.prepare("SELECT * FROM article_folders").all(),
    rawBefore,
  );
  store.setArticleFolder(articleId, id, false);
  assert.deepEqual(store.snapshot().articles, before.articles);
});

test("updating a collected article preserves folder assignments", (t) => {
  const store = storeFor(t);
  const { sourceId, articles } = addArticles(store);
  const folderId = store.createFolder("Collection");
  store.setArticleFolder(articles[0].id, folderId, true);
  store.upsertEntries(
    sourceId,
    [entry("1", { title: "Corrected report", contentHash: "corrected" })],
    "2026-09-26T12:00:00.000Z",
  );
  const after = store.snapshot();
  assert.equal(after.articles[0].id, articles[0].id);
  assert.deepEqual(after.articles[0].folderIds, [folderId]);
  assert.equal(after.folders[0].articleCount, 1);
});

test("folder ordering is deterministic and active folders precede archives", (t) => {
  const store = storeFor(t);
  const archived = store.createFolder("A archive");
  const tenth = store.createFolder("Projet 10");
  const second = store.createFolder("Projet 2");
  const first = store.createFolder("Autonomie");
  store.setFolderArchived(archived, true);
  assert.deepEqual(
    store.snapshot().folders.map((folder) => folder.id),
    [first, second, tenth, archived],
  );
});

test("folders and memberships survive reopening with empty and archived folders intact", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-folders-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const original = new MonitorStore(path, false);
  const { articles } = addArticles(original);
  const id = original.createFolder("Archived collection");
  original.createFolder("Empty collection");
  original.setArticleFolder(articles[0].id, id, true);
  original.setFolderArchived(id, true);
  const before = original.snapshot();
  original.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(reopened.snapshot(), before);
  } finally {
    reopened.db.close();
  }
});
