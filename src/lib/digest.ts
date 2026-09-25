import { matchesProfile } from "./selection";
import { buildFeedItems } from "./story-feed";
import type { Article, Snapshot, Source } from "./types";

export type DigestPeriod = 24 | 168;
export type DigestScope = "personal" | "all";

export interface DigestEntry {
  article: Article;
  kind: "new" | "updated";
  detectedAt: string;
}

export interface DigestItem {
  id: string;
  entries: DigestEntry[];
}

export interface DigestSection {
  theme: string;
  items: DigestItem[];
  publicationCount: number;
}

export interface Digest {
  generatedAt: string;
  from: string;
  to: string;
  periodHours: DigestPeriod;
  scope: DigestScope;
  sections: DigestSection[];
  total: number;
  shown: number;
  omitted: number;
  newCount: number;
  updatedCount: number;
  sourceCount: number;
  groupCount: number;
  sourceIssues: Source[];
}

const MAX_PUBLICATIONS = 100;

function compareId(a: { id: string }, b: { id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Collection timestamps must be complete ISO datetimes with an explicit timezone. */
function timestamp(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return null;
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(hourValue) > 23 ||
    Number(minuteValue) > 59 ||
    Number(secondValue) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  )
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Builds a view of the captured current content, never a reconstruction of past revisions. */
export function buildDigest(
  snapshot: Snapshot,
  options: { periodHours: DigestPeriod; scope: DigestScope; now: number },
): Digest {
  if (
    !options ||
    (options.periodHours !== 24 && options.periodHours !== 168) ||
    (options.scope !== "personal" && options.scope !== "all") ||
    !Number.isFinite(options.now)
  )
    throw new Error("Options de briefing invalides.");
  const end = new Date(options.now).getTime();
  const start = end - options.periodHours * 60 * 60 * 1000;
  if (!Number.isFinite(end) || !Number.isFinite(new Date(start).getTime()))
    throw new Error("Période de briefing invalide.");
  const entries: DigestEntry[] = [];
  for (const article of snapshot.articles) {
    if (
      options.scope === "personal" &&
      !matchesProfile(article, snapshot.profile)
    )
      continue;
    const collected = timestamp(article.collectedAt);
    if (collected === null || collected > end) continue;
    const updated = timestamp(article.updatedAt);
    // A future revision may have supplied the current text, so its article cannot
    // be represented as content available at this captured anchor.
    if (updated !== null && updated > end) continue;
    if (collected >= start) {
      entries.push({
        article,
        kind: "new",
        detectedAt: new Date(collected).toISOString(),
      });
    } else if (updated !== null && updated >= collected && updated >= start) {
      // Invalid or chronologically impossible update timestamps never qualify.
      entries.push({
        article,
        kind: "updated",
        detectedAt: new Date(updated).toISOString(),
      });
    }
  }
  entries.sort(
    (a, b) =>
      Date.parse(b.detectedAt) - Date.parse(a.detectedAt) ||
      compareId(a.article, b.article),
  );
  const included = entries.slice(0, MAX_PUBLICATIONS);
  const byId = new Map(included.map((entry) => [entry.article.id, entry]));
  const items = buildFeedItems(
    included.map((entry) => entry.article),
    snapshot.stories.groups,
  ).map((item) => ({
    id: item.id,
    entries: item.articles.map((article) => byId.get(article.id)!),
  }));
  const byTheme = new Map<string, DigestSection>();
  for (const item of items) {
    const theme = item.entries[0].article.themes[0]?.trim() || "Autres sujets";
    const section = byTheme.get(theme) ?? {
      theme,
      items: [],
      publicationCount: 0,
    };
    section.items.push(item);
    section.publicationCount += item.entries.length;
    byTheme.set(theme, section);
  }
  const sections = [...byTheme.values()].sort(
    (a, b) =>
      b.publicationCount - a.publicationCount ||
      a.theme.localeCompare(b.theme, "fr"),
  );
  const sourceIssues = snapshot.sources
    .filter((source) => {
      if (!source.enabled) return false;
      const checked = timestamp(source.lastCheckedAt);
      return (
        source.status === "error" ||
        source.status === "unsupported" ||
        source.status === "pending" ||
        checked === null ||
        checked < start ||
        checked > end
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name, "fr") || compareId(a, b));
  return {
    generatedAt: new Date(end).toISOString(),
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    periodHours: options.periodHours,
    scope: options.scope,
    sections,
    total: entries.length,
    shown: included.length,
    omitted: entries.length - included.length,
    newCount: included.filter((entry) => entry.kind === "new").length,
    updatedCount: included.filter((entry) => entry.kind === "updated").length,
    sourceCount: new Set(included.map((entry) => entry.article.sourceId)).size,
    groupCount: items.filter((item) => item.entries.length > 1).length,
    sourceIssues,
  };
}

/** Labels sources already identified as lacking reliable coverage for this digest. */
export function digestSourceIssueLabel(source: Source, _from: string): string {
  if (source.status === "error") return "Erreur de collecte";
  if (source.status === "unsupported") return "Connecteur indisponible";
  if (source.status === "pending" || !source.lastCheckedAt)
    return "Source non encore consultée";
  return "Aucune consultation dans la période";
}

/** Ignores unrelated personal actions and scheduler heartbeats for refresh notices. */
export function digestSnapshotKey(snapshot: Snapshot): string {
  const articles = snapshot.articles
    .map((article) => ({
      id: article.id,
      sourceId: article.sourceId,
      sourceName: article.sourceName,
      title: article.title,
      url: article.url,
      publishedAt: article.publishedAt,
      collectedAt: article.collectedAt,
      updatedAt: article.updatedAt,
      revision: article.revision,
      language: article.language,
      format: article.format,
      themes: article.themes,
      excerpt: article.excerpt,
      contentBasis: article.contentBasis,
      jev: article.jev,
      score: article.score,
      reasons: article.reasons,
      feedback: article.feedback,
    }))
    .sort(compareId);
  const groups = snapshot.stories.groups
    .map((group) => ({
      id: group.id,
      articleIds: [...group.articleIds].sort(),
    }))
    .sort(compareId);
  return JSON.stringify({
    articles,
    profile: snapshot.profile,
    groups,
    sources: [...snapshot.sources].sort(compareId),
  });
}
