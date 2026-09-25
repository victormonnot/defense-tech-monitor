import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import seeds from "../../config/sources.json";
import { defaultProfile, rulesClassifier, type Classifier } from "./classifier";
import type { FeedEntry } from "./feed";
import type { Article, Feedback, Profile, Snapshot, Source } from "./types";

type Row = Record<string, string | number | null>;

export class MonitorStore {
  readonly db: DatabaseSync;

  constructor(
    path: string,
    seed = true,
    private classifier: Classifier = rulesClassifier,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
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
    const sourceColumns = this.db
      .prepare("PRAGMA table_info(sources)")
      .all() as Row[];
    if (!sourceColumns.some((column) => column.name === "last_feed_count")) {
      this.db.exec("ALTER TABLE sources ADD COLUMN last_feed_count INTEGER");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES ('profile', ?)")
      .run(JSON.stringify(defaultProfile));
    if (seed) {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO sources (id,name,site_url,feed_url,language,status,last_error) VALUES (?,?,?,?,?,?,?)",
      );
      for (const source of seeds)
        insert.run(
          source.id,
          source.name,
          source.siteUrl,
          source.feedUrl,
          source.language,
          source.feedUrl ? "pending" : "unsupported",
          source.feedUrl
            ? null
            : "Aucun flux RSS confirmé. Un connecteur dédié reste à ajouter.",
        );
    }
  }

  sources(): Source[] {
    const rows = this.db
      .prepare(
        "SELECT s.*, (SELECT COUNT(*) FROM articles a WHERE a.source_id=s.id) AS article_count FROM sources s ORDER BY s.name COLLATE NOCASE",
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      siteUrl: String(r.site_url),
      feedUrl: r.feed_url as string | null,
      language: String(r.language),
      enabled: !!r.enabled,
      status: r.status as Source["status"],
      lastCheckedAt: r.last_checked_at as string | null,
      lastSuccessAt: r.last_success_at as string | null,
      lastError: r.last_error as string | null,
      articleCount: Number(r.article_count),
    }));
  }

  profile(): Profile {
    return JSON.parse(
      String(
        (
          this.db
            .prepare("SELECT value FROM settings WHERE key='profile'")
            .get() as Row
        ).value,
      ),
    );
  }

  setProfile(profile: Profile) {
    this.db
      .prepare("UPDATE settings SET value=? WHERE key='profile'")
      .run(JSON.stringify(profile));
  }

  addSource(input: {
    name: string;
    siteUrl: string;
    feedUrl: string | null;
    language: string;
  }) {
    const existing = this.db
      .prepare("SELECT id FROM sources WHERE site_url=?")
      .get(input.siteUrl) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE sources SET name=?,feed_url=?,language=?,status=?,last_error=?,etag=NULL,last_modified=NULL,last_checked_at=NULL WHERE id=?",
        )
        .run(
          input.name,
          input.feedUrl,
          input.language,
          input.feedUrl ? "pending" : "unsupported",
          input.feedUrl ? null : "Aucun flux RSS/Atom annoncé sur cette page.",
          existing.id,
        );
      return String(existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sources (id,name,site_url,feed_url,language,status,last_error) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.name,
        input.siteUrl,
        input.feedUrl,
        input.language,
        input.feedUrl ? "pending" : "unsupported",
        input.feedUrl ? null : "Aucun flux RSS/Atom annoncé sur cette page.",
      );
    return id;
  }

  toggleSource(id: string, enabled: boolean) {
    this.db
      .prepare("UPDATE sources SET enabled=? WHERE id=?")
      .run(Number(enabled), id);
  }

  setArticleState(
    id: string,
    field: "is_read" | "saved" | "feedback",
    value: boolean | Feedback | null,
  ) {
    this.db
      .prepare(`UPDATE articles SET ${field}=? WHERE id=?`)
      .run(typeof value === "boolean" ? Number(value) : value, id);
  }

  upsertEntries(sourceId: string, entries: FeedEntry[], collectedAt: string) {
    let added = 0;
    let updated = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const existing = this.db
          .prepare(
            "SELECT id,content_hash FROM articles WHERE source_id=? AND (guid=? OR url=?) LIMIT 1",
          )
          .get(sourceId, entry.guid, entry.url) as Row | undefined;
        if (existing?.content_hash === entry.contentHash) continue;
        if (existing) {
          this.db
            .prepare(
              "UPDATE articles SET url=?,title=?,published_at=?,text=?,excerpt=?,language=?,format=?,content_hash=? WHERE id=?",
            )
            .run(
              entry.url,
              entry.title,
              entry.publishedAt,
              entry.text,
              entry.excerpt,
              entry.language,
              entry.format,
              entry.contentHash,
              existing.id,
            );
          updated++;
        } else {
          this.db
            .prepare(
              "INSERT INTO articles (id,source_id,guid,url,title,published_at,collected_at,text,excerpt,language,format,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              sourceId,
              entry.guid,
              entry.url,
              entry.title,
              entry.publishedAt,
              collectedAt,
              entry.text,
              entry.excerpt,
              entry.language,
              entry.format,
              entry.contentHash,
            );
          added++;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { added, updated };
  }

  snapshot(): Snapshot {
    const sources = this.sources();
    const profile = this.profile();
    const rows = this.db
      .prepare(
        "SELECT a.*,s.name AS source_name FROM articles a JOIN sources s ON s.id=a.source_id ORDER BY COALESCE(a.published_at,a.collected_at) DESC",
      )
      .all() as Row[];
    const articles: Article[] = rows.map((r) => ({
      id: String(r.id),
      sourceId: String(r.source_id),
      sourceName: String(r.source_name),
      title: String(r.title),
      url: String(r.url),
      publishedAt: r.published_at as string | null,
      collectedAt: String(r.collected_at),
      language: String(r.language),
      format: r.format as Article["format"],
      excerpt: r.excerpt as string | null,
      contentBasis: r.text ? "feed_text" : "metadata",
      isRead: !!r.is_read,
      saved: !!r.saved,
      feedback: r.feedback as Feedback | null,
      ...this.classifier.classify(`${r.title}\n${r.text}`, profile),
    }));
    const selected = articles.filter(
      (a) =>
        a.score >= profile.minScore &&
        a.feedback !== "off_topic" &&
        a.feedback !== "seen",
    );
    return {
      articles,
      sources,
      profile,
      stats: {
        total: articles.length,
        selected: selected.length,
        unread: articles.filter((a) => !a.isRead).length,
        saved: articles.filter((a) => a.saved).length,
      },
      evaluation: {
        reviewed: articles.filter((a) => a.feedback).length,
        missedRelevant: articles.filter(
          (a) => a.feedback === "relevant" && a.score < profile.minScore,
        ).length,
        selectedOffTopic: articles.filter(
          (a) => a.feedback === "off_topic" && a.score >= profile.minScore,
        ).length,
      },
      lastCollectionAt:
        sources
          .map((s) => s.lastCheckedAt)
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ?? null,
    };
  }
}

const globals = globalThis as typeof globalThis & {
  monitorStore?: MonitorStore;
};
export function getStore() {
  return (globals.monitorStore ??= new MonitorStore(
    process.env.DTM_DATABASE_PATH || "data/monitor.sqlite",
  ));
}
export function getSnapshot() {
  return getStore().snapshot();
}
