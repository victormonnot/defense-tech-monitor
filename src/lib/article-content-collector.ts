import { articleContentTarget, sameArticleUrl } from "./article-content";
import { saveArticleContent } from "./article-content-store";
import type { MonitorStore } from "./store";
import type { Source } from "./types";
import type { FetchResource } from "./collector";

const DAY_MS = 86400000;
export const ARTICLE_CONTENT_PER_SOURCE = 10;
const validator = (value: string | undefined) =>
  value && value.length <= 2000 && !/[\r\n]/.test(value) ? value : null;

/** Run within the collection lease; a page failure never loses listing data. */
export async function collectArticleContent(
  store: MonitorStore,
  source: Source,
  fetcher: FetchResource,
  guard: () => void,
  now: () => number,
  deadline: number,
  maxRequests = ARTICLE_CONTENT_PER_SOURCE,
  onProgress: (delta: {
    checked: number;
    updated: number;
    failed: number;
  }) => void = () => {},
) {
  const result = { checked: 0, updated: 0, failed: 0 };
  const candidates = store.db
    .prepare(
      `
    SELECT a.id,a.url,a.language,a.revision,c.text,c.etag,c.last_modified
    FROM articles a LEFT JOIN article_content c
      ON c.article_id=a.id AND c.url=a.url AND c.language=a.language
    WHERE a.source_id=? AND a.format='article' AND a.language='en'
      AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=?)
    ORDER BY c.checked_at IS NOT NULL,COALESCE(a.published_at,a.collected_at) DESC,a.id
  `,
    )
    .all(source.id, new Date(now()).toISOString());
  for (const row of candidates) {
    if (
      result.checked >= Math.min(ARTICLE_CONTENT_PER_SOURCE, maxRequests) ||
      Date.now() >= deadline
    )
      break;
    const target = articleContentTarget(
      source.siteUrl,
      source.feedUrl,
      String(row.url),
    );
    if (!target) continue;
    guard();
    result.checked++;
    onProgress({ checked: 1, updated: 0, failed: 0 });
    const headers: Record<string, string> = {};
    if (row.text && row.etag) headers["if-none-match"] = String(row.etag);
    if (row.text && row.last_modified)
      headers["if-modified-since"] = String(row.last_modified);
    let text: string | null = null;
    let status: "success" | "unavailable" | "error" = "error";
    let error: string | null = null;
    let etag: string | null = null;
    let lastModified: string | null = null;
    try {
      const response = await fetcher(target.url, headers, (url) =>
        sameArticleUrl(target.url, url),
      );
      if (!sameArticleUrl(target.url, response.url))
        throw new Error("La page a redirigé vers une autre publication.");
      if (response.status === 304 && row.text) {
        text = String(row.text);
        etag = row.etag as string | null;
        lastModified = row.last_modified as string | null;
      } else {
        if (response.status !== 200)
          throw new Error(`La page répond HTTP ${response.status}.`);
        const type = response.headers["content-type"];
        if (
          type &&
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)
        )
          throw new Error("La page ne renvoie pas de contenu HTML.");
        text = target.extract(response.body, response.url);
        etag = validator(response.headers.etag);
        lastModified = validator(response.headers["last-modified"]);
      }
      status = text ? "success" : "unavailable";
      if (!text)
        error =
          "Aucun texte d’article public suffisamment long n’a été reconnu.";
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message.slice(0, 300)
          : "Lecture de la page impossible.";
    }
    // Recheck after every await and again inside the write transaction.
    guard();
    const time = now();
    const applied = saveArticleContent(
      store,
      String(row.id),
      { url: String(row.url), language: String(row.language) },
      { text, status, error, etag, lastModified },
      time,
      time + (status === "success" ? 7 : 1) * DAY_MS,
      guard,
    );
    if (!applied) continue;
    const failed = status !== "success" ? 1 : 0;
    result.failed += failed;
    const current = store.db
      .prepare("SELECT revision FROM articles WHERE id=?")
      .get(row.id);
    const updated = current?.revision !== row.revision ? 1 : 0;
    result.updated += updated;
    onProgress({ checked: 0, updated, failed });
  }
  return result;
}
