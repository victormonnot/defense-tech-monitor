import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import seeds from "../../config/sources.json";
import { defaultProfile, rulesClassifier, type Classifier } from "./classifier";
import type { FeedEntry } from "./feed";
import { migrate } from "./migrations";
import { resolveCollection } from "./connectors";
import { buildStories } from "./stories";
import { evaluateSelection, matchesProfile } from "./selection";
import { classificationText } from "./profile";
import { MAX_ACTIVITY_BATCH } from "./activity";
import type {
  ActivityReview,
  Article,
  Feedback,
  Profile,
  ProfilePreview,
  Snapshot,
  Source,
} from "./types";

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
    `);
    try {
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES ('profile', ?)")
      .run(JSON.stringify(defaultProfile));
    if (seed) {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO sources (id,name,site_url,feed_url,language,status,last_error) VALUES (?,?,?,?,?,?,?)",
      );
      for (const source of seeds) {
        const supported = !!resolveCollection(source.siteUrl, source.feedUrl);
        insert.run(
          source.id,
          source.name,
          source.siteUrl,
          source.feedUrl,
          source.language,
          supported ? "pending" : "unsupported",
          supported
            ? null
            : "Aucun flux ni connecteur disponible pour cette source.",
        );
      }
    }
    // Newly supported websites become collectible without replacing personal configuration.
    for (const source of this.sources()) {
      if (
        source.status === "unsupported" &&
        source.collectionKind !== "unsupported"
      ) {
        this.db
          .prepare(
            "UPDATE sources SET status='pending',last_error=NULL WHERE id=?",
          )
          .run(source.id);
      }
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
      collectionKind:
        resolveCollection(String(r.site_url), r.feed_url as string | null)
          ?.kind ?? "unsupported",
      collectionUrl:
        resolveCollection(String(r.site_url), r.feed_url as string | null)
          ?.url ?? null,
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
    const supported = !!resolveCollection(input.siteUrl, input.feedUrl);
    const existing = this.db
      .prepare("SELECT id,feed_url,language FROM sources WHERE site_url=?")
      .get(input.siteUrl) as Row | undefined;
    if (existing) {
      if (
        existing.feed_url === input.feedUrl &&
        existing.language === input.language
      ) {
        this.db
          .prepare("UPDATE sources SET name=? WHERE id=?")
          .run(input.name, existing.id);
        return String(existing.id);
      }
      this.db
        .prepare(
          "UPDATE sources SET name=?,feed_url=?,language=?,status=?,last_error=?,etag=NULL,last_modified=NULL,last_checked_at=NULL,last_success_at=NULL,last_feed_count=NULL WHERE id=?",
        )
        .run(
          input.name,
          input.feedUrl,
          input.language,
          supported ? "pending" : "unsupported",
          supported
            ? null
            : "Aucun flux ni connecteur disponible pour cette source.",
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
        supported ? "pending" : "unsupported",
        supported
          ? null
          : "Aucun flux ni connecteur disponible pour cette source.",
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
    field: "is_read" | "saved" | "feedback" | "keep_separate",
    value: boolean | Feedback | null,
  ) {
    this.db
      .prepare(`UPDATE articles SET ${field}=? WHERE id=?`)
      .run(typeof value === "boolean" ? Number(value) : value, id);
  }

  acknowledgeChanges(items: ActivityReview[]): number {
    if (
      !Array.isArray(items) ||
      items.length > MAX_ACTIVITY_BATCH ||
      items.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof item.id !== "string" ||
          !item.id.trim() ||
          item.id !== item.id.trim() ||
          item.id.length > 200 ||
          !Number.isSafeInteger(item.revision) ||
          item.revision < 1,
      )
    ) {
      throw new Error("Publications à valider invalides.");
    }
    const revisions = new Map<string, number>();
    for (const item of items)
      revisions.set(
        item.id,
        Math.max(revisions.get(item.id) ?? 0, item.revision),
      );
    let advanced = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const find = this.db.prepare(
        "SELECT revision,reviewed_revision FROM articles WHERE id=?",
      );
      const acknowledge = this.db.prepare(
        "UPDATE articles SET reviewed_revision=? WHERE id=? AND reviewed_revision<?",
      );
      for (const [id, revision] of revisions) {
        const article = find.get(id) as Row | undefined;
        if (!article || revision > Number(article.revision))
          throw new Error(
            "Publication inconnue ou version plus récente que celle enregistrée.",
          );
        advanced += Number(acknowledge.run(revision, id, revision).changes);
      }
      if (advanced > 0)
        this.db
          .prepare(
            "INSERT INTO settings (key,value) VALUES ('activity_last_reviewed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return advanced;
  }

  upsertEntries(sourceId: string, entries: FeedEntry[], collectedAt: string) {
    let added = 0;
    let updated = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const existing = this.db
          .prepare(
            "SELECT id,url,title,published_at,text,excerpt,language,format,content_hash,content_basis FROM articles WHERE source_id=? AND (guid=? OR url=?) LIMIT 1",
          )
          .get(sourceId, entry.guid, entry.url) as Row | undefined;
        const contentBasis =
          entry.contentBasis ?? (entry.text ? "feed_text" : "metadata");
        if (existing) {
          const contentChanged =
            existing.url !== entry.url ||
            existing.title !== entry.title ||
            existing.published_at !== entry.publishedAt ||
            existing.text !== entry.text ||
            existing.excerpt !== entry.excerpt ||
            existing.language !== entry.language ||
            existing.format !== entry.format ||
            existing.content_basis !== contentBasis;
          if (!contentChanged) {
            if (existing.content_hash !== entry.contentHash) {
              this.db
                .prepare("UPDATE articles SET content_hash=? WHERE id=?")
                .run(entry.contentHash, existing.id);
              updated++;
            }
            continue;
          }
          this.db
            .prepare(
              "UPDATE articles SET url=?,title=?,published_at=?,text=?,excerpt=?,language=?,format=?,content_hash=?,content_basis=?,revision=revision+1,updated_at=? WHERE id=?",
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
              contentBasis,
              collectedAt,
              existing.id,
            );
          updated++;
        } else {
          this.db
            .prepare(
              "INSERT INTO articles (id,source_id,guid,url,title,published_at,collected_at,text,excerpt,language,format,content_hash,content_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
              contentBasis,
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

  previewProfile(profile: Profile): ProfilePreview {
    const current = this.snapshot();
    const preview = this.snapshot(profile);
    const currentIds = new Set(
      current.articles
        .filter((article) => matchesProfile(article, current.profile))
        .map((article) => article.id),
    );
    const previewIds = new Set(
      preview.articles
        .filter((article) => matchesProfile(article, profile))
        .map((article) => article.id),
    );
    return {
      profile,
      selected: preview.stats.selected,
      currentSelected: current.stats.selected,
      evaluation: preview.evaluation,
      entered: preview.articles.filter(
        (article) => previewIds.has(article.id) && !currentIds.has(article.id),
      ),
      exited: preview.articles.filter(
        (article) => currentIds.has(article.id) && !previewIds.has(article.id),
      ),
    };
  }

  snapshot(profileOverride?: Profile): Snapshot {
    const sources = this.sources();
    const profile = profileOverride ?? this.profile();
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
      revision: Number(r.revision),
      changeKind:
        Number(r.reviewed_revision) === 0
          ? "new"
          : Number(r.reviewed_revision) < Number(r.revision)
            ? "updated"
            : null,
      updatedAt: r.updated_at as string | null,
      language: String(r.language),
      format: r.format as Article["format"],
      excerpt: r.excerpt as string | null,
      contentBasis: r.content_basis as Article["contentBasis"],
      isRead: !!r.is_read,
      saved: !!r.saved,
      feedback: r.feedback as Feedback | null,
      keepSeparate: !!r.keep_separate,
      ...this.classifier.classify(
        classificationText(
          {
            title: String(r.title),
            text: String(r.text),
            excerpt: r.excerpt as string | null,
          },
          profile,
        ),
        profile,
      ),
    }));
    const selected = articles.filter((article) =>
      matchesProfile(article, profile),
    );
    return {
      articles,
      sources,
      profile,
      stories: buildStories(
        articles.map((article, index) => ({
          ...article,
          comparisonText: String(rows[index].text),
        })),
        new Set(
          articles
            .filter((article) => article.keepSeparate)
            .map((article) => article.id),
        ),
      ),
      stats: {
        total: articles.length,
        selected: selected.length,
        unread: articles.filter((a) => !a.isRead).length,
        saved: articles.filter((a) => a.saved).length,
      },
      evaluation: evaluateSelection(articles, profile),
      activity: {
        startedAt: String(
          this.db
            .prepare(
              "SELECT value FROM settings WHERE key='activity_started_at'",
            )
            .get()!.value,
        ),
        lastReviewedAt:
          (this.db
            .prepare(
              "SELECT value FROM settings WHERE key='activity_last_reviewed_at'",
            )
            .get()?.value as string | undefined) ?? null,
        newCount: articles.filter((article) => article.changeKind === "new")
          .length,
        updatedCount: articles.filter(
          (article) => article.changeKind === "updated",
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
