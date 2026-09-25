import type { StoryGroup } from "./stories";
import type { Article } from "./types";

export interface FeedItem {
  id: string;
  articles: Article[];
  group: StoryGroup | null;
}

/** Apply presentation grouping only after selection, saved-state and search filters. */
export function buildFeedItems(
  visibleArticles: Article[],
  groups: StoryGroup[],
): FeedItem[] {
  const membership = new Map<string, StoryGroup>();
  for (const group of groups) {
    for (const id of group.articleIds) membership.set(id, group);
  }
  const items: FeedItem[] = [];
  const visibleGroups = new Map<string, FeedItem>();
  for (const article of visibleArticles) {
    const group = membership.get(article.id);
    if (!group) {
      items.push({ id: article.id, articles: [article], group: null });
      continue;
    }
    const existing = visibleGroups.get(group.id);
    if (existing) {
      existing.articles.push(article);
    } else {
      const item = { id: group.id, articles: [article], group };
      visibleGroups.set(group.id, item);
      items.push(item);
    }
  }
  return items.map((item) =>
    item.articles.length === 1
      ? { id: item.articles[0].id, articles: item.articles, group: null }
      : item,
  );
}
