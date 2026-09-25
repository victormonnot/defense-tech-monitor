import type { StoryGroup, StoryRelation } from "./stories";
import type { JevAnalysis, JevMode, JevState } from "./jev-types";
import type { CustomFeed, FeedInput } from "./custom-feeds";

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
  updatedAt: string | null;
  revision: number;
  changeKind: "new" | "updated" | null;
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
  folderIds: string[];
  jev?: JevAnalysis;
  feedAnalyses?: Record<string, JevAnalysis>;
  feedFeedback?: Record<string, Feedback | null>;
}

export interface Folder {
  id: string;
  name: string;
  archived: boolean;
  articleCount: number;
  createdAt: string;
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

export interface CollectionResult {
  added: number;
  updated: number;
  failed: number;
  skipped: number;
  checked: number;
}

export interface CollectionRun {
  id: string;
  trigger: "manual" | "scheduled" | "cli";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed" | "interrupted";
  result: CollectionResult | null;
  error: string | null;
}

export interface CollectionState {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  running: boolean;
  lastRun: CollectionRun | null;
}

export interface Snapshot {
  articles: Article[];
  sources: Source[];
  folders: Folder[];
  profile: Profile;
  stories: { groups: StoryGroup[]; related: StoryRelation[] };
  stats: { total: number; selected: number; unread: number; saved: number };
  evaluation: Evaluation;
  collection: CollectionState;
  jev?: JevState;
  customFeeds?: CustomFeed[];
  activity: {
    startedAt: string;
    lastReviewedAt: string | null;
    newCount: number;
    updatedCount: number;
  };
  lastCollectionAt: string | null;
}

export interface ActivityReview {
  id: string;
  revision: number;
}

export type MonitorAction =
  | { action: "collect" }
  | { action: "createCustomFeed"; feed: FeedInput }
  | {
      action: "updateCustomFeed";
      id: string;
      feed: FeedInput;
      revision: number;
    }
  | { action: "setCustomFeedArchived"; id: string; value: boolean }
  | {
      action: "setFeedFeedback";
      id: string;
      feedId: string;
      value: Feedback | null;
    }
  | { action: "setJevMode"; mode: JevMode }
  | { action: "retryJevFailures" }
  | {
      action: "updateCollectionSchedule";
      enabled: boolean;
      intervalMinutes: number;
    }
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
  | { action: "acknowledgeChanges"; articles: ActivityReview[] }
  | { action: "createFolder"; name: string }
  | { action: "renameFolder"; id: string; name: string }
  | { action: "setFolderArchived"; id: string; value: boolean }
  | { action: "setArticleFolder"; id: string; folderId: string; value: boolean }
  | { action: "previewProfile"; profile: Profile }
  | { action: "updateProfile"; profile: Profile };
