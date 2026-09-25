import type { DatabaseSync } from "node:sqlite";

const CURRENT_VERSION = 3;

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
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
