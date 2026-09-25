"use client";

import {
  ArrowRight,
  CircleAlert,
  FileText,
  Languages,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type { Article } from "@/lib/types";
import type { SummaryState } from "@/lib/summary-types";

function dollars(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function modelLabel(model?: string) {
  return model?.startsWith("gpt-4.1-mini") ? "GPT-4.1 mini" : model;
}

function generatedDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : null;
}

export function SummaryPanel({ state }: { state?: SummaryState }) {
  if (!state) return null;
  return (
    <section
      className="panel summary-settings"
      aria-labelledby="summary-settings-title"
    >
      <div className="panel-heading">
        <span className="panel-icon">
          <Languages size={19} />
        </span>
        <h2 id="summary-settings-title">Résumés en français</h2>
      </div>
      <p className="muted">
        Demandez un résumé depuis une publication. Il est conservé pour être
        réutilisé dans tous vos fils.
      </p>
      <div className="summary-provider">
        <span>OpenAI</span>
        <span>{modelLabel(state.model)}</span>
        <span>À la demande</span>
      </div>
      <p className="summary-transmission">
        Seuls le titre, le nom de la source, la langue et le texte disponible de
        la publication sont envoyés à OpenAI lorsque vous demandez un résumé.
      </p>

      {!state.configured && (
        <div className="summary-configuration" role="status">
          <CircleAlert size={16} />
          <div>
            <strong>Configuration locale requise</strong>
            {state.configurationError && <p>{state.configurationError}</p>}
            <p>
              Renseignez <code>OPENAI_API_KEY</code> et le plafond mensuel
              choisi dans <code>DTM_SUMMARY_MONTHLY_BUDGET_USD</code> dans{" "}
              <code>.env.local</code>, puis redémarrez le serveur.
            </p>
          </div>
        </div>
      )}

      <div
        className="summary-budget"
        aria-label="Budget mensuel des résumés OpenAI"
      >
        <div className="summary-budget-heading">
          <strong>Budget des résumés · {state.month} UTC</strong>
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
            aria-label="Budget des résumés consommé et réservé"
          />
        )}
        <dl className="summary-budget-values">
          <div>
            <dt>Consommé estimé</dt>
            <dd>{dollars(state.spentUsd)}</dd>
          </div>
          <div>
            <dt>Réservé</dt>
            <dd>{dollars(state.reservedUsd)}</dd>
          </div>
        </dl>
        <details className="summary-budget-help">
          <summary>Comprendre ce budget</summary>
          <p>
            Ce plafond local est distinct du budget Jev et du solde de votre
            compte OpenAI. Les réservations couvrent les demandes en cours ou
            dont le coût reste incertain ; elles comptent dans ce plafond.
          </p>
        </details>
      </div>
      <div className="summary-settings-status" role="status">
        <p>
          {state.running && <LoaderCircle className="spin" size={15} />}
          {state.running
            ? "Génération en cours"
            : "Génération uniquement à votre demande"}{" "}
          · {state.ready} résumé{state.ready > 1 ? "s" : ""} disponible
          {state.ready > 1 ? "s" : ""}
        </p>
        <p>
          {state.eligible} publication{state.eligible > 1 ? "s" : ""} avec un
          texte disponible assez long
          {state.failed > 0 &&
            ` · ${state.failed} demande${state.failed > 1 ? "s" : ""} en échec`}
        </p>
        {state.budgetBlocked && (
          <p className="summary-budget-warning">
            Budget disponible insuffisant pour une nouvelle demande. Les résumés
            existants restent consultables.
          </p>
        )}
      </div>
    </section>
  );
}

export function ArticleSummaryPanel({
  article,
  busy,
  pending,
  onGenerate,
  onOpenProfile,
}: {
  article: Article;
  busy: boolean;
  pending: boolean;
  onGenerate: () => void;
  onOpenProfile: () => void;
}) {
  const summary = article.summary;
  if (!summary) return null;
  const loading = pending || summary.status === "pending";
  const date = generatedDate(summary.generatedAt);
  if (loading)
    return (
      <div className="article-summary-pending" role="status">
        <LoaderCircle size={16} className="spin" />
        <span>Résumé en cours…</span>
      </div>
    );

  if (summary.status === "ready" && summary.text)
    return (
      <section
        className="article-summary-ready"
        aria-label="Résumé en français"
      >
        <div className="article-summary-heading">
          <Languages size={16} />
          <strong>Résumé en français</strong>
        </div>
        <p className="article-summary-text">{summary.text}</p>
        <div className="article-summary-provenance">
          <span>Résumé du texte disponible · Généré avec OpenAI</span>
          {date && <time dateTime={summary.generatedAt}>{date}</time>}
        </div>
        <details className="article-summary-details">
          <summary>À partir de quel contenu ?</summary>
          <p>
            {article.contentBasis === "feed_text"
              ? "Texte fourni par le flux."
              : article.contentBasis === "page_excerpt"
                ? "Extrait de la page publique."
                : "Informations disponibles dans la publication collectée."}
            {summary.truncated &&
              " Le texte transmis a été raccourci pour le résumé."}{" "}
            Le contenu intégral de l’article n’est pas nécessairement
            disponible.
          </p>
          {summary.model && <p>{modelLabel(summary.model)}</p>}
          <p>
            Ce résumé reformule la source sans vérification indépendante des
            informations.
          </p>
        </details>
      </section>
    );

  if (summary.status === "insufficient")
    return (
      <p className="article-summary-unavailable">
        <FileText size={14} />
        <span>
          {summary.reason ??
            "Le texte collecté est trop court pour produire un résumé. Consultez la publication originale."}
        </span>
      </p>
    );

  const failed = summary.status === "failed";
  return (
    <div className="article-summary-control">
      <button
        type="button"
        className="article-summary-button"
        disabled={busy || !summary.canGenerate}
        onClick={onGenerate}
      >
        {failed ? <RefreshCw size={15} /> : <Languages size={15} />}
        {failed ? "Réessayer le résumé" : "Résumer en français"}
      </button>
      {summary.reason && (
        <p
          className={`article-summary-reason ${failed ? "is-error" : ""}`}
          role={failed ? "status" : undefined}
        >
          {summary.reason}
        </p>
      )}
      {!summary.canGenerate && (
        <button
          type="button"
          className="article-summary-settings-link"
          onClick={onOpenProfile}
        >
          Voir les réglages des résumés <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
