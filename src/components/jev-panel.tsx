"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CircleAlert,
  Gauge,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { jevDecision, matchesRules } from "@/lib/selection";
import type { JevContentKind, JevMode, JevState } from "@/lib/jev-types";
import type { Article, MonitorAction, Profile } from "@/lib/types";

const modeLabels: Record<JevMode, string> = {
  off: "Désactivé",
  compare: "Comparer aux règles",
  personal: "Utiliser dans Pour moi",
};

const kindLabels: Record<JevContentKind, string> = {
  technical: "Analyse technique",
  field_report: "Retour de terrain",
  research: "Recherche",
  business: "Entreprise et industrie",
  general: "Général",
  unknown: "Type non précisé",
};

function dollars(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function confidence(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

export function JevPanel({
  state,
  articles,
  profile,
  busy,
  onAction,
}: {
  state?: JevState;
  articles: Article[];
  profile: Profile;
  busy: boolean;
  onAction: (action: MonitorAction) => Promise<boolean>;
}) {
  const [draftMode, setDraftMode] = useState<JevMode | null>(null);
  const comparison = useMemo(() => {
    const cached = articles.filter((article) => article.jev);
    const comparable = cached.filter(
      (article) => jevDecision(article) !== null,
    );
    return {
      cached: cached.length,
      comparable: comparable.length,
      lowConfidence: cached.length - comparable.length,
      jevOnly: comparable.filter(
        (article) => jevDecision(article) && !matchesRules(article, profile),
      ),
      rulesOnly: comparable.filter(
        (article) => !jevDecision(article) && matchesRules(article, profile),
      ),
    };
  }, [articles, profile]);
  if (!state) return null;
  const selectedMode = draftMode ?? state.mode;
  const currentMode = state.mode;
  const unavailable = !state.configured && selectedMode !== "off";

  async function changeMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || unavailable || selectedMode === currentMode) return;
    if (await onAction({ action: "setJevMode", mode: selectedMode }))
      setDraftMode(null);
  }

  return (
    <section className="panel jev-panel" aria-labelledby="jev-title">
      <div className="panel-heading">
        <span className="panel-icon">
          <Gauge size={19} />
        </span>
        <h2 id="jev-title">Jev · intérêt pour votre veille</h2>
      </div>
      <p className="muted">
        Jev attribue un niveau d’intérêt de 0 à 3 à partir du contenu disponible
        et de votre profil. Ce score ne vérifie pas les affirmations des
        sources.
      </p>
      <div className="jev-mode-status">
        <span
          className={`jev-mode-tag ${state.mode !== "off" ? "is-active" : ""}`}
        >
          {modeLabels[state.mode]}
        </span>
        <span>{state.model}</span>
      </div>

      {!state.configured && (
        <div className="jev-configuration" role="status">
          <CircleAlert size={16} />
          <div>
            <strong>Configuration locale requise</strong>
            {state.configurationError && <p>{state.configurationError}</p>}
            <p>
              Définissez <code>TYPESAFE_API_KEY</code> et le plafond mensuel
              choisi dans <code>DTM_JEV_MONTHLY_BUDGET_USD</code>, dans votre
              fichier local <code>.env.local</code>, puis redémarrez le serveur.
            </p>
          </div>
        </div>
      )}

      <form
        className="jev-mode-form"
        onSubmit={(event) => void changeMode(event)}
      >
        <label htmlFor="jev-mode">Mode de sélection</label>
        <div className="jev-mode-controls">
          <select
            id="jev-mode"
            value={selectedMode}
            onChange={(event) => setDraftMode(event.target.value as JevMode)}
            disabled={busy}
            aria-describedby="jev-transmission jev-mode-help"
          >
            {Object.entries(modeLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="button button-secondary"
            disabled={busy || unavailable || selectedMode === state.mode}
          >
            {selectedMode === "off"
              ? "Désactiver Jev"
              : selectedMode === "compare"
                ? "Activer la comparaison"
                : "Utiliser Jev dans Pour moi"}
          </button>
        </div>
        <p id="jev-mode-help" className="jev-help">
          {selectedMode === "off"
            ? "Les prochaines analyses sont arrêtées. Les résultats déjà obtenus restent consultables et les règles pilotent la sélection."
            : selectedMode === "compare"
              ? "Les analyses alimentent la comparaison. Les règles continuent de piloter Pour moi."
              : "Jev pilote la sélection quand sa confiance atteint 60 %. Sinon, les règles prennent le relais. Vos retours restent prioritaires."}
        </p>
        <p id="jev-transmission" className="jev-transmission">
          Activer Jev envoie à TypeSafe le texte collecté des publications et
          les mots-clés de votre profil, dans la limite du budget local.
        </p>
      </form>

      <div className="jev-budget" aria-label="Budget mensuel Jev">
        <div className="jev-budget-heading">
          <strong>Budget local · {state.month} UTC</strong>
          <span>
            {state.monthlyBudgetUsd > 0
              ? `${dollars(state.monthlyBudgetUsd)} maximum`
              : "Plafond à définir"}
          </span>
        </div>
        {state.monthlyBudgetUsd > 0 && (
          <progress
            value={Math.min(
              state.monthlyBudgetUsd,
              state.spentUsd + state.reservedUsd,
            )}
            max={state.monthlyBudgetUsd}
            aria-label="Budget consommé et réservé"
          />
        )}
        <dl className="jev-budget-values">
          <div>
            <dt>Consommé estimé</dt>
            <dd>{dollars(state.spentUsd)}</dd>
          </div>
          <div>
            <dt>Réservé</dt>
            <dd>{dollars(state.reservedUsd)}</dd>
          </div>
          <div>
            <dt>Tokens d’entrée comptabilisés</dt>
            <dd>{new Intl.NumberFormat("fr-FR").format(state.inputTokens)}</dd>
          </div>
        </dl>
        <details className="jev-budget-help">
          <summary>Comprendre ce budget</summary>
          <p>
            Ce plafond est propre à cette application et indépendant du solde de
            votre compte TypeSafe. Le coût consommé est une estimation. Les
            réservations couvrent les requêtes en cours ou dont le coût reste
            incertain et comptent dans le plafond.
          </p>
        </details>
      </div>

      <div className="jev-processing" role="status">
        <p>
          {state.running && <LoaderCircle className="spin" size={15} />}
          {state.running
            ? "Analyses en cours"
            : state.mode === "off"
              ? "Analyses désactivées"
              : !state.configured
                ? "Analyses indisponibles"
                : state.lastError
                  ? "Analyses en pause après une erreur"
                  : "Analyses automatiques activées"}{" "}
          · {state.ready} disponible{state.ready > 1 ? "s" : ""} ·{" "}
          {state.pending} en attente
          {state.failed > 0 && ` · ${state.failed} en échec`}
        </p>
        {state.budgetBlocked && (
          <p className="jev-warning">
            Budget disponible insuffisant : les prochaines analyses attendent.
          </p>
        )}
        {state.lastError && <p className="jev-warning">{state.lastError}</p>}
      </div>
      {(state.failed > 0 || state.lastError) && (
        <button
          type="button"
          className="button button-secondary jev-retry"
          disabled={
            busy ||
            state.running ||
            !state.configured ||
            state.mode === "off" ||
            state.budgetBlocked
          }
          onClick={() => void onAction({ action: "retryJevFailures" })}
        >
          <RefreshCw size={14} />{" "}
          {state.lastError
            ? "Reprendre les analyses"
            : "Réessayer les analyses en échec"}
        </button>
      )}

      <details className="jev-comparison">
        <summary>
          Comparer Jev et les règles{" "}
          <span>
            {comparison.comparable} publication
            {comparison.comparable > 1 ? "s" : ""}
          </span>
        </summary>
        <p className="jev-help">
          {comparison.cached} résultat{comparison.cached > 1 ? "s" : ""}{" "}
          disponible{comparison.cached > 1 ? "s" : ""} sur {articles.length}{" "}
          publications. La comparaison retient les résultats avec au moins 60 %
          de confiance, avant vos retours : intérêt Jev d’au moins 2/3, contre
          le seuil de vos règles.
        </p>
        {comparison.lowConfidence > 0 && (
          <p className="jev-help">
            {comparison.lowConfidence} résultat
            {comparison.lowConfidence > 1 ? "s" : ""} de confiance inférieure :
            les règles restent utilisées.
          </p>
        )}
        {comparison.comparable === 0 && (
          <p className="jev-comparison-empty">
            Aucun résultat suffisamment confiant pour comparer les deux
            sélections.
          </p>
        )}
        <div className="jev-comparison-lists">
          <ComparisonList
            title="Retenues uniquement par Jev"
            articles={comparison.jevOnly}
          />
          <ComparisonList
            title="Retenues uniquement par les règles"
            articles={comparison.rulesOnly}
          />
        </div>
      </details>
    </section>
  );
}

function ComparisonList({
  title,
  articles,
}: {
  title: string;
  articles: Article[];
}) {
  return (
    <div className="jev-comparison-list">
      <h3>
        {title} <span>{articles.length}</span>
      </h3>
      {articles.length > 0 ? (
        <ul>
          {articles.slice(0, 5).map((article) => (
            <li key={article.id}>
              <a href={article.url} target="_blank" rel="noreferrer">
                {article.title} <ArrowUpRight size={13} />
              </a>
              <span>{article.sourceName}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>Aucune parmi les résultats comparables.</p>
      )}
      {articles.length > 5 && (
        <p>
          {articles.length - 5} autre{articles.length - 5 > 1 ? "s" : ""}{" "}
          publication{articles.length - 5 > 1 ? "s" : ""}.
        </p>
      )}
    </div>
  );
}

export function JevArticleIndicator({ article }: { article: Article }) {
  const analysis = article.jev;
  if (!analysis) return null;
  const usable = jevDecision(article) !== null;
  const applied = analysis.applied && usable && article.feedback === null;
  const label = !usable
    ? "règles conservées"
    : analysis.applied && article.feedback !== null
      ? "votre retour prioritaire"
      : applied
        ? "appliqué"
        : "non appliqué";
  return (
    <details className={`jev-article ${applied ? "is-applied" : ""}`}>
      <summary>
        <Gauge size={13} /> Jev · intérêt {analysis.score}/3{" "}
        <span>{label}</span>
      </summary>
      <div className="jev-article-details">
        <p>
          Intérêt estimé pour votre profil : {analysis.score}/3. Confiance du
          modèle : {confidence(analysis.confidence)}.
        </p>
        {analysis.kindConfidence >= 0.6 && (
          <p>
            Type estimé : {kindLabels[analysis.kind]} (
            {confidence(analysis.kindConfidence)} de confiance).
          </p>
        )}
        <p>
          {!usable
            ? "Confiance inférieure au seuil de 60 % : les règles et vos retours prennent le relais."
            : applied
              ? "Cette analyse participe à la sélection Pour moi ; vos retours restent prioritaires."
              : "Ce résultat reste consultable sans piloter la sélection de cette publication."}
        </p>
        <p>
          Texte utilisé :{" "}
          {article.contentBasis === "metadata"
            ? "titre et métadonnées uniquement"
            : analysis.scope === "title_excerpt"
              ? article.excerpt
                ? "titre et extrait disponible"
                : "titre uniquement, aucun extrait disponible"
              : article.contentBasis === "feed_text"
                ? "titre et texte fourni par le flux"
                : "titre et extrait de la page publique"}
          .{analysis.truncated && " Texte raccourci pour l’analyse."} Le contenu
          intégral de l’article n’est pas toujours disponible. Le score mesure
          l’intérêt, sans vérifier les faits.
        </p>
        <p className="jev-article-model">
          {analysis.model} ·{" "}
          {new Intl.DateTimeFormat("fr-FR", {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(analysis.evaluatedAt))}
        </p>
      </div>
    </details>
  );
}
