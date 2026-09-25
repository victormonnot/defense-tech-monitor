import type { DatabaseSync } from "node:sqlite";
import { GENERAL_FEED, GENERAL_FEED_ID } from "./custom-feeds";

const CURRENT_VERSION = 8;

export function migrate(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(
      db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
    );
    if (version > CURRENT_VERSION)
      throw new Error(
        "Database schema is newer than this application. Update the application before opening it.",
      );

    if (version < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, site_url TEXT NOT NULL UNIQUE,
          feed_url TEXT, language TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending', last_checked_at TEXT, last_success_at TEXT, last_error TEXT,
          etag TEXT, last_modified TEXT, last_feed_count INTEGER
        );
        CREATE TABLE IF NOT EXISTS articles (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), guid TEXT NOT NULL,
          url TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT, collected_at TEXT NOT NULL,
          text TEXT NOT NULL, excerpt TEXT, language TEXT NOT NULL, format TEXT NOT NULL,
          content_hash TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0,
          feedback TEXT CHECK(feedback IN ('relevant', 'off_topic', 'seen')),
          UNIQUE(source_id, guid), UNIQUE(source_id, url)
        );
        CREATE INDEX IF NOT EXISTS articles_date ON articles(published_at DESC, collected_at DESC);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collection_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }

    if (version < 2) {
      const sourceColumns = db.prepare("PRAGMA table_info(sources)").all();
      if (!sourceColumns.some((column) => column.name === "last_feed_count")) {
        db.exec("ALTER TABLE sources ADD COLUMN last_feed_count INTEGER");
      }
      db.exec(`
        ALTER TABLE articles ADD COLUMN content_basis TEXT NOT NULL DEFAULT 'metadata'
          CHECK(content_basis IN ('metadata', 'feed_text', 'page_excerpt'));
        UPDATE articles SET content_basis='feed_text' WHERE text <> '';
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      db.exec(`
        ALTER TABLE articles ADD COLUMN keep_separate INTEGER NOT NULL DEFAULT 0
          CHECK(keep_separate IN (0, 1));
        PRAGMA user_version = 3;
      `);
    }
    if (version < 4) {
      db.exec(`
        ALTER TABLE articles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
        ALTER TABLE articles ADD COLUMN reviewed_revision INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_revision >= 0);
        ALTER TABLE articles ADD COLUMN updated_at TEXT;
        UPDATE articles SET reviewed_revision=revision;
        PRAGMA user_version = 4;
      `);
      db.prepare(
        "INSERT OR IGNORE INTO settings (key,value) VALUES ('activity_started_at',?)",
      ).run(new Date().toISOString());
    }
    if (version < 5) {
      db.exec(`
        CREATE TABLE folders (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
          created_at TEXT NOT NULL
        );
        CREATE TABLE article_folders (
          article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          PRIMARY KEY(article_id, folder_id)
        );
        CREATE INDEX article_folders_folder ON article_folders(folder_id, article_id);
        PRAGMA user_version = 5;
      `);
    }
    if (version < 6) {
      db.exec(`
        CREATE TABLE collection_schedule (
          id INTEGER PRIMARY KEY CHECK(id=1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
          interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 15 AND 1440),
          next_run_at TEXT
        );
        INSERT INTO collection_schedule (id) VALUES (1);
        CREATE TABLE collection_run (
          id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL UNIQUE,
          trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled','cli')),
          started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed','interrupted')),
          result TEXT, error TEXT
        );
        PRAGMA user_version = 6;
      `);
    }
    if (version < 7) {
      db.exec(`
        INSERT OR IGNORE INTO settings (key,value) VALUES ('jev_mode','off');
        CREATE TABLE jev_attempts (
          id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, month TEXT NOT NULL,
          reserved_nanos INTEGER NOT NULL CHECK(reserved_nanos >= 0),
          settled_nanos INTEGER CHECK(settled_nanos >= 0), input_tokens INTEGER CHECK(input_tokens >= 0),
          started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','success','failed'))
        );
        CREATE INDEX jev_attempts_month ON jev_attempts(month);
        CREATE TABLE jev_cache (
          cache_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES jev_attempts(id),
          status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
          lease_expires_at TEXT, result TEXT, evaluated_at TEXT, error TEXT
        );
        PRAGMA user_version = 7;
      `);
    }
    if (version < 8) {
      db.exec(`
        CREATE TABLE custom_feeds (
          id TEXT PRIMARY KEY, input TEXT NOT NULL,
          is_general INTEGER NOT NULL DEFAULT 0 CHECK(is_general IN (0,1)),
          archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          CHECK(is_general=0 OR archived=0)
        );
        CREATE UNIQUE INDEX custom_feeds_general ON custom_feeds(is_general) WHERE is_general=1;
        CREATE TABLE feed_feedback (
          article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          feed_id TEXT NOT NULL REFERENCES custom_feeds(id) ON DELETE CASCADE,
          feedback TEXT NOT NULL CHECK(feedback IN ('relevant','off_topic','seen')),
          PRIMARY KEY(article_id,feed_id)
        );
        PRAGMA user_version = 8;
      `);
      db.prepare(
        "INSERT INTO custom_feeds (id,input,is_general) VALUES (?,?,1)",
      ).run(GENERAL_FEED_ID, JSON.stringify(GENERAL_FEED));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
