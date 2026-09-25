import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "../src/lib/store";
import { migrate } from "../src/lib/migrations";

function removeActivitySchema(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE articles DROP COLUMN revision;
    ALTER TABLE articles DROP COLUMN reviewed_revision;
    ALTER TABLE articles DROP COLUMN updated_at;
    DELETE FROM settings WHERE key IN ('activity_started_at', 'activity_last_reviewed_at');
  `);
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
    4,
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
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 4);
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
      4,
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
      4,
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
