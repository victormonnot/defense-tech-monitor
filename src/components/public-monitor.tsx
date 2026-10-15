"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Languages,
  LockKeyhole,
  Radio,
  RefreshCw,
  Search,
  Signal,
  X,
} from "lucide-react";
import type { PublicArticle, PublicSnapshot } from "@/lib/public-monitor";
import { createSearchMatcher } from "@/lib/search";
import styles from "./public-monitor.module.css";

const PAGE_SIZE = 30;

function dateLabel(value: string | null, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Date non fournie";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : "Europe/Paris",
    ...(withTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
  }).format(new Date(value));
}

function languageLabel(value: string) {
  const known: Record<string, string> = {
    en: "Anglais",
    fr: "Français",
    uk: "Ukrainien",
    de: "Allemand",
    es: "Espagnol",
    und: "Langue non précisée",
  };
  return known[value] ?? value;
}

function textPreview(text: string) {
  if (text.length <= 500) return text;
  const boundary = text.lastIndexOf(" ", 480);
  return `${text.slice(0, boundary > 320 ? boundary : 480).trimEnd()}…`;
}

function provenance(article: PublicArticle) {
  if (article.format === "post") return "Texte publié sur X";
  const labels: Record<PublicArticle["contentBasis"], string> = {
    feed_text: "Texte fourni par le flux de la source",
    page_text: "Texte extrait de la page publique de l’article",
    page_excerpt: "Extrait de la page de publications",
    metadata: "Titre et métadonnées uniquement",
  };
  return labels[article.contentBasis];
}

function PublicArticleCard({ article }: { article: PublicArticle }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const summary = article.summary;
  const longSummary = Boolean(summary && summary.text.length > 500);
  const excerpt =
    article.contentBasis !== "metadata" &&
    article.excerpt?.trim() !== article.title.trim()
      ? article.excerpt
      : null;
  const language = article.language === "und" ? undefined : article.language;

  return (
    <article className={styles.article}>
      <div className={styles.articleMeta}>
        <span className={styles.source}>{article.sourceName}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={article.publishedAt ?? undefined}>
          {dateLabel(article.publishedAt)}
        </time>
        {article.format !== "article" && (
          <span className={styles.format}>
            {article.format === "video" ? "Vidéo" : "Publication X"}
          </span>
        )}
      </div>
      <h2 className={styles.articleTitle}>
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          lang={language}
        >
          {article.title}
        </a>
      </h2>
      {summary ? (
        <section className={styles.summary} aria-label="Résumé IA en français">
          <div className={styles.summaryLabel}>
            <Languages size={15} aria-hidden="true" />
            <span>Résumé IA · Français</span>
          </div>
          <p id={summaryId} className={styles.articleText} lang="fr">
            {expanded ? summary.text : textPreview(summary.text)}
          </p>
          {longSummary && (
            <button
              type="button"
              className={styles.expandButton}
              aria-expanded={expanded}
              aria-controls={summaryId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Réduire le résumé" : "Lire le résumé complet"}
              <ChevronDown
                size={15}
                aria-hidden="true"
                className={expanded ? styles.flipped : undefined}
              />
            </button>
          )}
          <details className={styles.provenance}>
            <summary>À propos de ce résumé</summary>
            <p>
              {provenance(article)}. Résumé du texte disponible, sans
              vérification indépendante.
            </p>
            <p>
              Généré le{" "}
              <time dateTime={summary.generatedAt}>
                {dateLabel(summary.generatedAt, true)}
              </time>
              .
            </p>
            {excerpt && (
              <p className={styles.originalExcerpt} lang={language}>
                Extrait original : {excerpt}
              </p>
            )}
          </details>
        </section>
      ) : (
        <>
          {excerpt && (
            <p className={styles.articleText} lang={language}>
              {excerpt}
            </p>
          )}
          <p className={styles.textProvenance}>{provenance(article)}</p>
        </>
      )}
      <footer className={styles.articleFooter}>
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.originalLink}
        >
          Lire la source <ArrowUpRight size={15} aria-hidden="true" />
          <span className="sr-only"> : {article.title} (nouvel onglet)</span>
        </a>
        <span>{languageLabel(article.language)}</span>
      </footer>
    </article>
  );
}

export function PublicMonitor({
  initialData,
}: {
  initialData: PublicSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialData);
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const refreshInFlight = useRef(false);
  const searchId = useId();
  const sourceSelectId = useId();
  const articles = useMemo(() => {
    const matchesSearch = createSearchMatcher(query);
    return snapshot.articles
      .filter((article) => {
        if (sourceId && article.sourceId !== sourceId) return false;
        return matchesSearch([
          article.title,
          article.sourceName,
          article.excerpt,
          article.summary?.text,
        ]);
      })
      .sort((a, b) => {
        const first = Date.parse(a.publishedAt ?? a.collectedAt) || 0;
        const second = Date.parse(b.publishedAt ?? b.collectedAt) || 0;
        return second - first || a.id.localeCompare(b.id);
      });
  }, [snapshot, query, sourceId]);
  const filtered = Boolean(query.trim() || sourceId);

  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/public-monitor", {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Refresh failed");
      const data: { snapshot: PublicSnapshot } = await response.json();
      setSnapshot(data.snapshot);
      setNotice("La vue est à jour.");
    } catch {
      setError(
        "Impossible d’actualiser la vue. Les publications déjà chargées restent disponibles.",
      );
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }

  return (
    <div className={styles.shell}>
      <a href="#publications" className="skip-link">
        Aller aux publications
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a
            href="/"
            className={styles.brand}
            aria-label="Defense Tech Monitor — accueil"
          >
            <span className={styles.brandSymbol}>
              <Signal size={23} aria-hidden="true" />
            </span>
            <span>
              DEFENSE TECH<span className={styles.brandSubtitle}>MONITOR</span>
            </span>
          </a>
          <a href="/admin" className={styles.adminLink}>
            <LockKeyhole size={14} aria-hidden="true" /> Administration
          </a>
        </div>
      </header>

      <main id="publications" className={styles.main}>
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              <Radio size={14} aria-hidden="true" /> VEILLE OUVERTE
            </p>
            <h1>Défense & technologie</h1>
            <p className={styles.introduction}>
              Les publications, leurs sources et les résumés disponibles en
              français.
            </p>
          </div>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw
              size={16}
              aria-hidden="true"
              className={refreshing ? styles.spinning : undefined}
            />
            {refreshing ? "Actualisation…" : "Actualiser la vue"}
          </button>
        </div>
        <p className={styles.collectionDate}>
          {snapshot.lastCollectionAt ? (
            <>
              Dernière collecte :{" "}
              <time dateTime={snapshot.lastCollectionAt}>
                {dateLabel(snapshot.lastCollectionAt, true)}
              </time>
            </>
          ) : (
            "Les nouvelles publications apparaîtront ici après leur collecte."
          )}
        </p>

        <div
          className={styles.toolbar}
          role="search"
          aria-label="Filtrer les publications"
        >
          <label htmlFor={searchId} className="sr-only">
            Rechercher dans les publications
          </label>
          <div className={styles.searchField}>
            <Search size={18} aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              placeholder="Rechercher une publication…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
            />
          </div>
          <label htmlFor={sourceSelectId} className="sr-only">
            Filtrer par source
          </label>
          <select
            id={sourceSelectId}
            value={sourceId}
            className={styles.sourceSelect}
            onChange={(event) => {
              setSourceId(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
          >
            <option value="">Toutes les sources</option>
            {snapshot.sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.resultLine}>
          <p role="status">
            {articles.length} publication{articles.length !== 1 ? "s" : ""}
            {filtered ? " trouvée" : ""}
            {filtered && articles.length !== 1 ? "s" : ""} · Les plus récentes
            d’abord
          </p>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSourceId("");
                setVisibleCount(PAGE_SIZE);
              }}
            >
              <X size={14} aria-hidden="true" /> Effacer les filtres
            </button>
          )}
        </div>
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {articles.length ? (
          <div className={styles.articles}>
            {articles.slice(0, visibleCount).map((article) => (
              <PublicArticleCard key={article.id} article={article} />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <Search size={26} aria-hidden="true" />
            <h2>
              {filtered
                ? "Aucune publication trouvée"
                : "La veille arrive bientôt"}
            </h2>
            <p>
              {filtered
                ? "Essayez un autre mot-clé ou choisissez toutes les sources."
                : "Les publications collectées seront consultables sur cette page."}
            </p>
          </div>
        )}
        {articles.length > visibleCount && (
          <button
            type="button"
            className={styles.loadMore}
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            Afficher plus de publications{" "}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        )}
        <footer className={styles.pageFooter}>
          Defense Tech Monitor <span aria-hidden="true">·</span> Une veille à
          lire à la source.
        </footer>
      </main>
    </div>
  );
}
