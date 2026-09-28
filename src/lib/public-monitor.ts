import { getStore } from "./store";
import type { ContentBasis, Snapshot } from "./types";

export interface PublicArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string | null;
  collectedAt: string;
  updatedAt: string | null;
  language: string;
  format: "article" | "video" | "post";
  excerpt: string | null;
  contentBasis: ContentBasis;
  summary?: { text: string; generatedAt: string };
}

export interface PublicSource {
  id: string;
  name: string;
  siteUrl: string;
}

export interface PublicSnapshot {
  articles: PublicArticle[];
  sources: PublicSource[];
  lastCollectionAt: string | null;
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Explicit allowlists keep operational and personal fields out of HTML and JSON. */
export function publicSnapshot(snapshot: Snapshot): PublicSnapshot {
  const articles: PublicArticle[] = [];
  for (const article of snapshot.articles) {
    const url = safeUrl(article.url);
    if (!url) continue;
    const projected: PublicArticle = {
      id: article.id,
      sourceId: article.sourceId,
      sourceName: article.sourceName,
      title: article.title,
      url,
      publishedAt: article.publishedAt,
      collectedAt: article.collectedAt,
      updatedAt: article.updatedAt,
      language: article.language,
      format: article.format,
      excerpt: article.excerpt,
      contentBasis: article.contentBasis,
    };
    const summary = article.summary;
    if (
      summary?.status === "ready" &&
      typeof summary.text === "string" &&
      summary.text.trim() &&
      typeof summary.generatedAt === "string" &&
      Number.isFinite(Date.parse(summary.generatedAt))
    )
      projected.summary = {
        text: summary.text,
        generatedAt: summary.generatedAt,
      };
    articles.push(projected);
  }
  const representedSources = new Set(
    articles.map((article) => article.sourceId),
  );
  const sources: PublicSource[] = [];
  for (const source of snapshot.sources) {
    const siteUrl = safeUrl(source.siteUrl);
    if (siteUrl && representedSources.has(source.id))
      sources.push({ id: source.id, name: source.name, siteUrl });
  }
  return {
    articles,
    sources,
    lastCollectionAt: snapshot.lastCollectionAt,
  };
}

/** Reading the public view never enqueues summaries or provider work. */
export function getPublicSnapshot(): PublicSnapshot {
  return publicSnapshot(getStore().snapshot());
}
