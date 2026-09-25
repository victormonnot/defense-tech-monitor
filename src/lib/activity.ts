import type { ActivityReview, Article } from "./types";

export type ActivityFilter = "all" | "new" | "updated";
export const MAX_ACTIVITY_BATCH = 200;

export function matchesActivity(
  article: Pick<Article, "changeKind">,
  filter: ActivityFilter,
) {
  return filter === "all" || article.changeKind === filter;
}

export function activityOrder(
  a: Pick<Article, "updatedAt" | "collectedAt">,
  b: Pick<Article, "updatedAt" | "collectedAt">,
) {
  return (
    Date.parse(b.updatedAt ?? b.collectedAt) -
    Date.parse(a.updatedAt ?? a.collectedAt)
  );
}

// Call after view/search filters, before presentation grouping. Capture the
// revision shown to the reader so a concurrent import remains pending.
export function reviewBatch(
  articles: Pick<Article, "id" | "revision" | "changeKind">[],
): ActivityReview[] {
  return articles
    .filter((article) => article.changeKind !== null)
    .slice(0, MAX_ACTIVITY_BATCH)
    .map(({ id, revision }) => ({ id, revision }));
}

export function parseActivityBatch(value: unknown): ActivityReview[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ACTIVITY_BATCH
  ) {
    throw new Error(`Indiquez entre 1 et ${MAX_ACTIVITY_BATCH} publications.`);
  }
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Publication invalide.");
    }
    const { id, revision } = item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id !== id.trim() ||
      id.length > 200 ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      throw new Error("Publication ou version invalide.");
    }
    return { id, revision };
  });
}
