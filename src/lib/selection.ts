import type { Article, Evaluation, Profile } from "./types";

type SelectionArticle = Pick<Article, "score" | "feedback" | "jev">;

export const JEV_MIN_CONFIDENCE = 0.6;
export const JEV_MIN_RELEVANCE = 2;

/** A classification is an interest judgment, never a source reliability score. */
export function jevDecision(article: Pick<Article, "jev">): boolean | null {
  const result = article.jev;
  if (
    !result ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 3 ||
    !Number.isFinite(result.confidence) ||
    result.confidence < JEV_MIN_CONFIDENCE ||
    result.confidence > 1
  )
    return null;
  return result.score >= JEV_MIN_RELEVANCE;
}

/** Explicit feedback leads; unclassified/uncertain items retain chronological order. */
export function comparePersonalPriority(a: Article, b: Article): number {
  const priority = (article: Article) =>
    article.feedback === "relevant"
      ? 4
      : article.jev?.applied && jevDecision(article) !== null
        ? article.jev.score
        : JEV_MIN_RELEVANCE;
  const date = (article: Article) => {
    const value = Date.parse(article.publishedAt ?? article.collectedAt);
    return Number.isFinite(value) ? value : 0;
  };
  return (
    priority(b) - priority(a) || date(b) - date(a) || a.id.localeCompare(b.id)
  );
}

export type EvaluationFilter =
  | "unreviewed"
  | "missed"
  | "off_topic"
  | "reviewed";

export function matchesRules(
  article: Pick<Article, "score">,
  profile: Profile,
): boolean {
  return article.score >= profile.minScore;
}

export function matchesProfile(
  article: SelectionArticle,
  profile: Profile,
): boolean {
  if (article.feedback === "relevant") return true;
  if (article.feedback === "off_topic" || article.feedback === "seen")
    return false;
  if (article.jev?.applied) {
    const decision = jevDecision(article);
    if (decision !== null) return decision;
  }
  return matchesRules(article, profile);
}

export function evaluateSelection(
  articles: SelectionArticle[],
  profile: Profile,
): Evaluation {
  const evaluation: Evaluation = {
    reviewed: 0,
    relevant: 0,
    offTopic: 0,
    seen: 0,
    matchedRelevant: 0,
    missedRelevant: 0,
    selectedOffTopic: 0,
    excludedOffTopic: 0,
    precision: null,
    recall: null,
  };

  for (const article of articles) {
    if (article.feedback === "seen") {
      evaluation.seen++;
      continue;
    }
    if (article.feedback === null) continue;

    evaluation.reviewed++;
    const selected = matchesRules(article, profile);
    if (article.feedback === "relevant") {
      evaluation.relevant++;
      if (selected) evaluation.matchedRelevant++;
      else evaluation.missedRelevant++;
    } else {
      evaluation.offTopic++;
      if (selected) evaluation.selectedOffTopic++;
      else evaluation.excludedOffTopic++;
    }
  }

  const selectedReviewed =
    evaluation.matchedRelevant + evaluation.selectedOffTopic;
  if (selectedReviewed > 0) {
    evaluation.precision = evaluation.matchedRelevant / selectedReviewed;
  }
  if (evaluation.relevant > 0) {
    evaluation.recall = evaluation.matchedRelevant / evaluation.relevant;
  }
  return evaluation;
}

export function matchesEvaluation(
  article: SelectionArticle,
  profile: Profile,
  filter: EvaluationFilter,
): boolean {
  switch (filter) {
    case "unreviewed":
      return article.feedback === null;
    case "missed":
      return article.feedback === "relevant" && !matchesRules(article, profile);
    case "off_topic":
      return article.feedback === "off_topic" && matchesRules(article, profile);
    case "reviewed":
      return article.feedback !== null;
  }
}
