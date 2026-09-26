import type { MonitorStore } from "./store";

type Store = Pick<MonitorStore, "db">;

export interface ArticleContentResult {
  text: string | null;
  status: "success" | "unavailable" | "error";
  error: string | null;
  etag: string | null;
  lastModified: string | null;
}

function isoDate(value: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime()))
    throw new Error("Date de collecte du contenu invalide.");
  return new Date(value).toISOString();
}

function nullableString(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= max);
}

export function saveArticleContent(
  store: Store,
  articleId: string,
  expected: { url: string; language: string },
  result: ArticleContentResult,
  now: number,
  nextAttemptAt: number,
  beforeWrite?: () => void,
): boolean {
  if (
    typeof articleId !== "string" ||
    !articleId ||
    articleId !== articleId.trim() ||
    articleId.length > 200 ||
    typeof expected?.url !== "string" ||
    !expected.url ||
    typeof expected.language !== "string" ||
    !expected.language
  )
    throw new Error("Publication à enrichir invalide.");
  const checkedAt = isoDate(now);
  const next = isoDate(nextAttemptAt);
  if (nextAttemptAt < now)
    throw new Error("La prochaine tentative ne peut pas précéder la collecte.");
  if (
    !result ||
    !["success", "unavailable", "error"].includes(result.status) ||
    !nullableString(result.error, 500) ||
    !nullableString(result.etag, 2000) ||
    !nullableString(result.lastModified, 2000)
  )
    throw new Error("Résultat de collecte du contenu invalide.");
  const text = typeof result.text === "string" ? result.text.trim() : null;
  if (
    (result.status === "success" &&
      (text === null || text.length < 400 || text.length > 20000)) ||
    (result.status !== "success" && result.text !== null)
  )
    throw new Error(
      "Le texte collecté doit contenir entre 400 et 20 000 caractères.",
    );

  store.db.exec("BEGIN IMMEDIATE");
  try {
    beforeWrite?.();
    const article = store.db
      .prepare(
        "SELECT url,language,text,excerpt,content_basis FROM article_inputs WHERE id=?",
      )
      .get(articleId);
    if (
      !article ||
      article.url !== expected.url ||
      article.language !== expected.language
    ) {
      store.db.exec("COMMIT");
      return false;
    }
    const previous = store.db
      .prepare(
        "SELECT text,retrieved_at,etag,last_modified FROM article_content WHERE article_id=? AND url=? AND language=?",
      )
      .get(articleId, expected.url, expected.language);
    const preserved = text === null && previous;
    const effectiveText =
      text ?? (previous?.text as string | null | undefined) ?? null;
    store.db
      .prepare(
        `
        INSERT INTO article_content (article_id,url,language,text,retrieved_at,checked_at,next_attempt_at,status,error,etag,last_modified)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(article_id) DO UPDATE SET url=excluded.url,language=excluded.language,text=excluded.text,
          retrieved_at=excluded.retrieved_at,checked_at=excluded.checked_at,next_attempt_at=excluded.next_attempt_at,
          status=excluded.status,error=excluded.error,etag=excluded.etag,last_modified=excluded.last_modified
      `,
      )
      .run(
        articleId,
        expected.url,
        expected.language,
        effectiveText,
        text === null ? (previous?.retrieved_at ?? null) : checkedAt,
        checkedAt,
        next,
        result.status,
        result.error,
        preserved ? previous.etag : result.etag,
        preserved ? previous.last_modified : result.lastModified,
      );
    const current = store.db
      .prepare(
        "SELECT text,excerpt,content_basis FROM article_inputs WHERE id=?",
      )
      .get(articleId)!;
    if (
      current.text !== article.text ||
      current.excerpt !== article.excerpt ||
      current.content_basis !== article.content_basis
    )
      store.db
        .prepare(
          "UPDATE articles SET revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(checkedAt, articleId);
    store.db.exec("COMMIT");
    return true;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
