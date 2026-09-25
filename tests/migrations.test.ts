import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "../src/lib/store";
import { migrate } from "../src/lib/migrations";

function removeActivitySchema(db: DatabaseSync) {
  removeFolderSchema(db);
  db.exec(`
    ALTER TABLE articles DROP COLUMN revision;
    ALTER TABLE articles DROP COLUMN reviewed_revision;
    ALTER TABLE articles DROP COLUMN updated_at;
    DELETE FROM settings WHERE key IN ('activity_started_at', 'activity_last_reviewed_at');
  `);
}

function removeFolderSchema(db: DatabaseSync) {
  removeCollectionSchema(db);
  db.exec("DROP TABLE article_folders; DROP TABLE folders;");
}

function removeCollectionSchema(db: DatabaseSync) {
  removeJevSchema(db);
  db.exec("DROP TABLE collection_run; DROP TABLE collection_schedule;");
}

function removeJevSchema(db: DatabaseSync) {
  db.exec(
    "DROP TABLE jev_cache; DROP TABLE jev_attempts; DELETE FROM settings WHERE key IN ('jev_mode','jev_worker_error');",
  );
}

test("version 1 upgrades preserve publications, personal state, profile and source choices", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const old = new MonitorStore(path);
  old.upsertEntries(
    "militarnyi",
    [
      {
        guid: "fixture-one",
        url: "https://example.com/fixture",
        title: "Fixture robot",
        publishedAt: null,
        text: "Synthetic feed excerpt",
        excerpt: "Synthetic feed excerpt",
        language: "en",
        format: "article",
        contentHash: "fixture-hash",
      },
    ],
    "2026-01-01T00:00:00.000Z",
  );
  const id = old.snapshot().articles[0].id;
  old.setArticleState(id, "saved", true);
  old.setArticleState(id, "is_read", true);
  old.setArticleState(id, "feedback", "relevant");
  const profile = {
    keywords: ["fixture"],
    excludeKeywords: ["unwanted"],
    minScore: 1,
  };
  old.setProfile(profile);
  old.db
    .prepare(
      "UPDATE sources SET name='My Brave1',enabled=0,status='unsupported',last_error='No connector' WHERE id='brave1'",
    )
    .run();
  old.db
    .prepare(
      "UPDATE sources SET feed_url='https://example.com/custom-rss',enabled=0 WHERE id='defender-media'",
    )
    .run();
  const before = old.snapshot().articles.map((article) => ({
    ...article,
    changeKind: null,
  }));
  // Reconstruct the schema shipped before provenance and versioned migrations.
  removeActivitySchema(old.db);
  old.db.exec(
    "ALTER TABLE articles DROP COLUMN content_basis; ALTER TABLE articles DROP COLUMN keep_separate; ALTER TABLE sources DROP COLUMN last_feed_count; PRAGMA user_version=1;",
  );
  old.db.close();

  const upgraded = new MonitorStore(path);
  assert.equal(
    upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
    7,
  );
  assert.deepEqual(upgraded.snapshot().articles, before);
  assert.equal(upgraded.snapshot().activity.newCount, 0);
  assert.equal(upgraded.snapshot().activity.lastReviewedAt, null);
  assert.deepEqual(upgraded.profile(), profile);
  const sources = upgraded.sources();
  const brave1 = sources.find((s) => s.id === "brave1")!;
  assert.equal(brave1.name, "My Brave1");
  assert.equal(brave1.enabled, false);
  assert.equal(brave1.status, "pending");
  assert.equal(brave1.collectionKind, "website");
  assert.equal(brave1.lastError, null);
  assert.equal(
    sources.find((s) => s.id === "defender-media")?.collectionUrl,
    "https://example.com/custom-rss",
  );
  upgraded.db.close();

  const reopened = new MonitorStore(path);
  assert.deepEqual(reopened.snapshot().articles, before);
  assert.deepEqual(reopened.profile(), profile);
  assert.equal(reopened.sources().length, 4);
  reopened.db.close();
});

test("fresh migrations are idempotent and reject newer schemas without downgrading them", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 7);
    const startedAt = db
      .prepare("SELECT value FROM settings WHERE key='activity_started_at'")
      .get()?.value;
    assert.ok(
      typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt)),
    );
    migrate(db);
    assert.equal(
      db
        .prepare("SELECT value FROM settings WHERE key='activity_started_at'")
        .get()?.value,
      startedAt,
    );
    db.exec("PRAGMA user_version=99");
    assert.throws(() => migrate(db), /newer than/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 99);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE name='articles'").get(),
    );
  } finally {
    db.close();
  }
});

test("version 2 upgrades add reversible grouping preferences without changing existing records", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-migration-v2-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const old = new MonitorStore(path);
  old.upsertEntries(
    "brave1",
    [
      {
        guid: "synthetic-metadata",
        url: "https://example.test/metadata",
        title: "Synthetic metadata publication",
        publishedAt: "2026-01-01",
        text: "",
        excerpt: null,
        contentBasis: "metadata",
        language: "en",
        format: "article",
        contentHash: "synthetic-hash",
      },
    ],
    "2026-01-02T12:00:00.000Z",
  );
  const id = old.snapshot().articles[0].id;
  old.setArticleState(id, "saved", true);
  old.setArticleState(id, "feedback", "seen");
  old.toggleSource("brave1", false);
  const before = old.snapshot();
  removeActivitySchema(old.db);
  old.db.exec(
    "ALTER TABLE articles DROP COLUMN keep_separate; PRAGMA user_version=2;",
  );
  old.db.close();
  const upgraded = new MonitorStore(path);
  try {
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      7,
    );
    const after = upgraded.snapshot();
    assert.deepEqual(
      { ...after, activity: undefined },
      {
        ...before,
        articles: before.articles.map((article) => ({
          ...article,
          changeKind: null,
        })),
        activity: undefined,
      },
    );
    assert.deepEqual(
      { ...after.activity, startedAt: undefined },
      {
        startedAt: undefined,
        lastReviewedAt: null,
        newCount: 0,
        updatedCount: 0,
      },
    );
    assert.equal(upgraded.snapshot().articles[0].keepSeparate, false);
  } finally {
    upgraded.db.close();
  }
});

test("version 3 upgrades baseline existing articles without changing personal or source preferences", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-migration-v3-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const old = new MonitorStore(path);
  old.upsertEntries(
    "brave1",
    [
      {
        guid: "synthetic-existing",
        url: "https://example.test/existing",
        title: "Existing synthetic drone publication",
        publishedAt: "2026-01-01",
        text: "Synthetic excerpt",
        excerpt: "Synthetic excerpt",
        contentBasis: "page_excerpt",
        language: "en",
        format: "article",
        contentHash: "synthetic-existing-hash",
      },
    ],
    "2026-01-02T12:00:00.000Z",
  );
  const id = old.snapshot().articles[0].id;
  old.setArticleState(id, "saved", true);
  old.setArticleState(id, "is_read", true);
  old.setArticleState(id, "feedback", "off_topic");
  old.setArticleState(id, "keep_separate", true);
  old.toggleSource("brave1", false);
  const profile = { keywords: ["synthetic"], excludeKeywords: [], minScore: 1 };
  old.setProfile(profile);
  const before = old.snapshot();
  removeActivitySchema(old.db);
  old.db.exec("PRAGMA user_version=3");
  old.db.close();
  const upgraded = new MonitorStore(path);
  try {
    const after = upgraded.snapshot();
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      7,
    );
    assert.deepEqual(
      { ...after, activity: undefined },
      {
        ...before,
        articles: before.articles.map((article) => ({
          ...article,
          changeKind: null,
        })),
        activity: undefined,
      },
    );
    assert.equal(after.activity.lastReviewedAt, null);
    assert.equal(after.activity.newCount, 0);
    assert.equal(after.activity.updatedCount, 0);
    assert.ok(!Number.isNaN(Date.parse(after.activity.startedAt)));
    assert.equal(
      upgraded.db
        .prepare("SELECT reviewed_revision FROM articles WHERE id=?")
        .get(id)?.reviewed_revision,
      1,
    );
    migrate(upgraded.db);
    assert.deepEqual(upgraded.snapshot(), after);
  } finally {
    upgraded.db.close();
  }
});

test("version 4 upgrades preserve publications, activity and preferences without creating folders", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-migration-v4-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const old = new MonitorStore(path);
  const entry = {
    guid: "synthetic-v4",
    url: "https://example.test/v4",
    title: "Synthetic drone trial",
    publishedAt: null,
    text: "Synthetic drone trial report.",
    excerpt: "Synthetic drone trial.",
    language: "en",
    format: "article" as const,
    contentHash: "v4-hash",
  };
  old.upsertEntries("brave1", [entry], "2026-09-01T12:00:00.000Z");
  const article = old.snapshot().articles[0];
  old.setArticleState(article.id, "saved", true);
  old.setArticleState(article.id, "is_read", true);
  old.setArticleState(article.id, "feedback", "relevant");
  old.setArticleState(article.id, "keep_separate", true);
  old.acknowledgeChanges([article]);
  old.upsertEntries(
    "brave1",
    [{ ...entry, title: "Synthetic drone trial correction" }],
    "2026-09-02T12:00:00.000Z",
  );
  old.setProfile({ keywords: ["synthetic"], excludeKeywords: [], minScore: 2 });
  old.toggleSource("brave1", false);
  const before = old.snapshot();
  removeFolderSchema(old.db);
  old.db.exec("PRAGMA user_version=4");
  old.db.close();
  const upgraded = new MonitorStore(path);
  try {
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      7,
    );
    assert.deepEqual(upgraded.snapshot(), before);
    assert.deepEqual(upgraded.snapshot().folders, []);
    assert.deepEqual(upgraded.snapshot().articles[0].folderIds, []);
    assert.equal(upgraded.snapshot().articles[0].changeKind, "updated");
    migrate(upgraded.db);
    assert.deepEqual(upgraded.snapshot(), before);
  } finally {
    upgraded.db.close();
  }
});

test("version 5 upgrades add a paused schedule without changing articles, dossiers or activity", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-migration-v5-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const old = new MonitorStore(path);
  old.upsertEntries(
    "brave1",
    [
      {
        guid: "synthetic-v5",
        url: "https://example.test/v5",
        title: "Synthetic drone publication",
        publishedAt: null,
        text: "Synthetic excerpt",
        excerpt: "Synthetic excerpt",
        language: "en",
        format: "article",
        contentHash: "v5-hash",
      },
    ],
    "2026-09-25T12:00:00.000Z",
  );
  const article = old.snapshot().articles[0];
  old.setArticleState(article.id, "saved", true);
  old.setArticleState(article.id, "feedback", "off_topic");
  old.acknowledgeChanges([article]);
  const folder = old.createFolder("Synthetic dossier");
  old.setArticleFolder(article.id, folder, true);
  old.setFolderArchived(folder, true);
  const before = old.snapshot();
  removeCollectionSchema(old.db);
  old.db.exec("PRAGMA user_version=5");
  old.db.close();
  const upgraded = new MonitorStore(path);
  try {
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      7,
    );
    assert.deepEqual(upgraded.snapshot(), before);
    assert.deepEqual(upgraded.snapshot().collection, {
      enabled: false,
      intervalMinutes: 60,
      nextRunAt: null,
      running: false,
      lastRun: null,
    });
    migrate(upgraded.db);
    assert.deepEqual(upgraded.snapshot(), before);
  } finally {
    upgraded.db.close();
  }
});

test("version 6 upgrades default Jev to off without changing existing data or starting paid work", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-migration-v6-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const old = new MonitorStore(path);
  old.upsertEntries(
    "brave1",
    [
      {
        guid: "synthetic-v6",
        url: "https://example.test/v6",
        title: "Synthetic drone publication",
        publishedAt: null,
        text: "Synthetic excerpt",
        excerpt: "Synthetic excerpt",
        language: "en",
        format: "article",
        contentHash: "v6-hash",
      },
    ],
    "2026-09-25T12:00:00.000Z",
  );
  const article = old.snapshot().articles[0];
  old.setArticleState(article.id, "saved", true);
  old.setArticleState(article.id, "feedback", "relevant");
  old.acknowledgeChanges([article]);
  const folder = old.createFolder("Synthetic dossier");
  old.setArticleFolder(article.id, folder, true);
  old.updateCollectionSchedule(true, 120);
  const before = old.snapshot();
  removeJevSchema(old.db);
  old.db.exec("PRAGMA user_version=6");
  old.db.close();
  const upgraded = new MonitorStore(path);
  try {
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      7,
    );
    assert.deepEqual(upgraded.snapshot(), before);
    assert.equal(upgraded.snapshot().jev?.mode, "off");
    assert.equal(upgraded.snapshot().jev?.pending, 1);
    assert.equal(
      upgraded.db.prepare("SELECT COUNT(*) AS count FROM jev_attempts").get()
        ?.count,
      0,
    );
    migrate(upgraded.db);
    assert.deepEqual(upgraded.snapshot(), before);
  } finally {
    upgraded.db.close();
  }
});
