import type { StoryGroup, StoryRelation } from "./stories";

export type Feedback = "relevant" | "off_topic" | "seen";
export type SourceStatus = "pending" | "ok" | "empty" | "error" | "unsupported";
export type ContentBasis = "feed_text" | "page_excerpt" | "metadata";

export interface Source {
  id: string;
  name: string;
  siteUrl: string;
  feedUrl: string | null;
  collectionKind: "rss" | "website" | "unsupported";
  collectionUrl: string | null;
  language: string;
  enabled: boolean;
  status: SourceStatus;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  articleCount: number;
}

export interface Article {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string | null;
  collectedAt: string;
  language: string;
  format: "article" | "video";
  themes: string[];
  excerpt: string | null;
  contentBasis: ContentBasis;
  score: number;
  reasons: string[];
  isRead: boolean;
  saved: boolean;
  feedback: Feedback | null;
  keepSeparate: boolean;
}

export interface Profile {
  keywords: string[];
  excludeKeywords: string[];
  minScore: number;
  matchScope?: "all_text" | "title_excerpt";
}

export interface Evaluation {
  reviewed: number;
  relevant: number;
  offTopic: number;
  seen: number;
  matchedRelevant: number;
  missedRelevant: number;
  selectedOffTopic: number;
  excludedOffTopic: number;
  precision: number | null;
  recall: number | null;
}

export interface ProfilePreview {
  profile: Profile;
  selected: number;
  currentSelected: number;
  evaluation: Evaluation;
  entered: Article[];
  exited: Article[];
}

export interface Snapshot {
  articles: Article[];
  sources: Source[];
  profile: Profile;
  stories: { groups: StoryGroup[]; related: StoryRelation[] };
  stats: { total: number; selected: number; unread: number; saved: number };
  evaluation: Evaluation;
  lastCollectionAt: string | null;
}

export type MonitorAction =
  | { action: "collect" }
  | {
      action: "addSource";
      name: string;
      siteUrl: string;
      feedUrl?: string;
      language?: string;
    }
  | { action: "toggleSource"; id: string; enabled: boolean }
  | { action: "setRead"; id: string; value: boolean }
  | { action: "setSaved"; id: string; value: boolean }
  | { action: "setSeparate"; id: string; value: boolean }
  | { action: "setFeedback"; id: string; value: Feedback | null }
  | { action: "previewProfile"; profile: Profile }
  | { action: "updateProfile"; profile: Profile };
