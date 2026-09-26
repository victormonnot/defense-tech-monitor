import {
  buildSummaryInput,
  callSummary,
  getSummaryConfig,
  SummaryRequestError,
} from "./summary-client";
import {
  claimSummary,
  failSummary,
  settleSummary,
  summaryArticle,
  summarySnapshot,
} from "./summary-store";
import type { MonitorStore } from "./store";
import type { ArticleSummary } from "./summary-types";
import { DEFAULT_SUMMARY_MODEL, isSummaryModel } from "./summary-models";

export async function processArticleSummary(
  store: MonitorStore,
  articleId: string,
  options: {
    call?: typeof callSummary;
    config?: () => ReturnType<typeof getSummaryConfig>;
    now?: () => number;
  } = {},
): Promise<ArticleSummary> {
  const call = options.call ?? callSummary;
  const getConfig = options.config ?? getSummaryConfig;
  const now = options.now ?? Date.now;
  const config = getConfig();
  const claim = claimSummary(store, articleId, config, now());
  if (claim) {
    try {
      const result = await call(claim.request, config.apiKey!);
      settleSummary(store, claim, result, now());
    } catch (error) {
      const known = error instanceof SummaryRequestError;
      failSummary(
        store,
        claim,
        known
          ? error.message
          : "La génération du résumé a échoué. Vous pouvez la relancer explicitement.",
        known && error.beforeRequest,
        now(),
      );
    }
  }
  const current = summaryArticle(store, articleId);
  const currentConfig = getConfig();
  const summary = summarySnapshot(
    store,
    [current],
    currentConfig,
    now(),
  ).summaries.get(articleId)!;
  const model = isSummaryModel(currentConfig.model)
    ? currentConfig.model
    : DEFAULT_SUMMARY_MODEL;
  if (claim && buildSummaryInput(current, model)?.cacheKey !== claim.cacheKey)
    return {
      ...summary,
      reason:
        model !== claim.request.model
          ? "Le modèle de résumé a changé pendant la demande. Le résultat précédent reste associé à son modèle."
          : "Le contenu a changé pendant la demande. Le résumé précédent ne s’applique pas à cette version.",
    };
  return summary;
}
