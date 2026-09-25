"use client";

import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Download,
  Layers3,
  Newspaper,
  RefreshCw,
  Rss,
} from "lucide-react";
import {
  buildDigest,
  digestSnapshotKey,
  digestSourceIssueLabel,
  type DigestEntry,
  type DigestPeriod,
  type DigestScope,
} from "@/lib/digest";
import { digestMarkdown, digestUrl } from "@/lib/digest-markdown";
import type { Snapshot } from "@/lib/types";

function dateLabel(value: string | null, withTime = false) {
  if (!value) return "Date non fournie";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date non fournie";
  return new Intl.DateTimeFormat("fr-FR", {
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}),
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime
      ? ({
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        } as const)
      : {}),
  }).format(date);
}

function languageLabel(value: string) {
  const languages: Record<string, string> = {
    en: "Anglais",
    fr: "Français",
    uk: "Ukrainien",
    de: "Allemand",
    es: "Espagnol",
    und: "Langue non précisée",
  };
  return languages[value] ?? value;
}

function makeEdition(
  snapshot: Snapshot,
  periodHours: DigestPeriod,
  scope: DigestScope,
) {
  return {
    digest: buildDigest(snapshot, { periodHours, scope, now: Date.now() }),
    key: digestSnapshotKey(snapshot),
    configuredSources: snapshot.sources.length,
    activeSources: snapshot.sources.filter((source) => source.enabled).length,
  };
}

export function DigestView({
  snapshot,
  onOpenSources,
}: {
  snapshot: Snapshot;
  onOpenSources: () => void;
}) {
  const [edition, setEdition] = useState(() =>
    makeEdition(snapshot, 24, "personal"),
  );
  const [exportNotice, setExportNotice] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const currentKey = useMemo(() => digestSnapshotKey(snapshot), [snapshot]);
  const digest = edition.digest;
  const hasUpdates = currentKey !== edition.key;

  function updateEdition(
    periodHours = digest.periodHours,
    scope = digest.scope,
  ) {
    setEdition(makeEdition(snapshot, periodHours, scope));
    setExportNotice(null);
  }

  function download() {
    try {
      const blob = new Blob([digestMarkdown(digest)], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `defense-tech-monitor-review-${digest.generatedAt.slice(0, 19).replace(/[:T]/g, "-")}-${digest.periodHours}h-${digest.scope}.md`;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setExportNotice({ error: false, text: "Export Markdown préparé." });
    } catch {
      setExportNotice({
        error: true,
        text: "L’export n’a pas pu être préparé. Réessayez.",
      });
    }
  }

  return (
    <div className="digest-view">
      <section className="digest-controls" aria-label="Composer la revue">
        <div className="digest-control-row">
          <div className="digest-options">
            <div>
              <label htmlFor="digest-period">Période</label>
              <select
                id="digest-period"
                value={digest.periodHours}
                onChange={(event) =>
                  updateEdition(Number(event.target.value) as DigestPeriod)
                }
              >
                <option value={24}>24 dernières heures</option>
                <option value={168}>7 derniers jours</option>
              </select>
            </div>
            <div>
              <label htmlFor="digest-scope">Sélection</label>
              <select
                id="digest-scope"
                value={digest.scope}
                onChange={(event) =>
                  updateEdition(
                    digest.periodHours,
                    event.target.value as DigestScope,
                  )
                }
              >
                <option value="personal">Pour moi</option>
                <option value="all">Tout le flux</option>
              </select>
            </div>
          </div>
          <div className="digest-toolbar">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => updateEdition()}
            >
              <RefreshCw size={15} /> Actualiser la revue
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={download}
            >
              <Download size={15} /> Télécharger Markdown
            </button>
          </div>
        </div>
        <p className="digest-control-help">
          La période porte sur les premières collectes et les modifications
          détectées. Actualiser la revue utilise les données déjà collectées.
        </p>
      </section>

      {hasUpdates && (
        <div className="digest-refresh-notice" role="status">
          <RefreshCw size={17} />
          <span>
            De nouvelles données sont disponibles. Cette revue reste inchangée
            jusqu’à son actualisation.
          </span>
          <button type="button" onClick={() => updateEdition()}>
            Intégrer les nouvelles données
          </button>
        </div>
      )}
      {exportNotice && (
        <p
          className={`digest-export-notice ${exportNotice.error ? "is-error" : ""}`}
          role={exportNotice.error ? "alert" : "status"}
        >
          {exportNotice.error ? <CircleAlert size={15} /> : <Check size={15} />}
          {exportNotice.text}
        </p>
      )}

      <section className="digest-edition" aria-label="Périmètre de la revue">
        <dl className="digest-window">
          <div>
            <dt>Période couverte</dt>
            <dd>
              Du{" "}
              <time dateTime={digest.from}>{dateLabel(digest.from, true)}</time>{" "}
              au <time dateTime={digest.to}>{dateLabel(digest.to, true)}</time>
            </dd>
          </div>
          <div>
            <dt>Revue générée</dt>
            <dd>
              <time dateTime={digest.generatedAt}>
                {dateLabel(digest.generatedAt, true)}
              </time>
            </dd>
          </div>
        </dl>
        <div
          className="digest-counts"
          aria-label="Publications incluses dans cette revue"
        >
          <div>
            <strong>{digest.shown}</strong>
            <span>
              publication{digest.shown > 1 ? "s" : ""} incluse
              {digest.shown > 1 ? "s" : ""}
            </span>
          </div>
          <div>
            <strong>{digest.newCount}</strong>
            <span>
              première{digest.newCount > 1 ? "s" : ""} collecte
              {digest.newCount > 1 ? "s" : ""}
            </span>
          </div>
          <div>
            <strong>{digest.updatedCount}</strong>
            <span>
              publication{digest.updatedCount > 1 ? "s" : ""} actualisée
              {digest.updatedCount > 1 ? "s" : ""}
            </span>
          </div>
          <div>
            <strong>{digest.sourceCount}</strong>
            <span>
              source{digest.sourceCount > 1 ? "s" : ""} représentée
              {digest.sourceCount > 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <p className="digest-scope-note">
          {digest.scope === "personal"
            ? "Sélection selon votre profil et vos retours au moment de la génération."
            : "Toutes les publications correspondant à la période, sans filtre de profil."}{" "}
          Les données affichées sont leur version actuelle, pas l’historique des
          modifications.
        </p>
        {digest.groupCount > 0 && (
          <p className="digest-scope-note">
            {digest.groupCount} regroupement{digest.groupCount > 1 ? "s" : ""}{" "}
            de reprises probables ; chaque publication conserve son lien.
          </p>
        )}
        {digest.omitted > 0 && (
          <p className="digest-limit">
            <CircleAlert size={15} />
            <span>
              La revue affiche {digest.shown} publications sur {digest.total}.
              Les {digest.omitted} restantes ne figurent pas dans cette édition
              ni dans son export.
            </span>
          </p>
        )}
      </section>

      <section
        className="digest-source-health"
        aria-label="État des sources de la revue"
      >
        {digest.sourceIssues.length > 0 ? (
          <details>
            <summary>
              <CircleAlert size={15} /> {digest.sourceIssues.length} source
              {digest.sourceIssues.length > 1 ? "s" : ""} à vérifier
            </summary>
            <p>
              État des sources actives au moment de cette revue, quel que soit
              le périmètre sélectionné.
            </p>
            <ul>
              {digest.sourceIssues.map((source) => (
                <li key={source.id}>
                  <strong>{source.name}</strong>
                  <span>{digestSourceIssueLabel(source, digest.from)}</span>
                  {source.lastError && <p>{source.lastError}</p>}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p>
            <Rss size={15} />{" "}
            {edition.configuredSources === 0
              ? "Aucune source configurée."
              : edition.activeSources === 0
                ? "Aucune source active dans cette édition."
                : "Aucun problème de collecte signalé dans les sources actives de cette édition."}
          </p>
        )}
        <button
          className="digest-sources-link"
          type="button"
          onClick={onOpenSources}
        >
          Voir les sources <ArrowUpRight size={14} />
        </button>
      </section>

      {digest.sections.length > 0 ? (
        <div className="digest-sections">
          {digest.sections.map((section, sectionIndex) => (
            <section
              className="digest-section"
              key={section.theme}
              aria-labelledby={`digest-theme-${sectionIndex}`}
            >
              <div className="digest-section-heading">
                <h2 id={`digest-theme-${sectionIndex}`}>{section.theme}</h2>
                <span>
                  {section.publicationCount} publication
                  {section.publicationCount > 1 ? "s" : ""}
                </span>
              </div>
              <div className="digest-items">
                {section.items.map((item) => (
                  <div
                    className={`digest-item ${item.entries.length > 1 ? "digest-group" : ""}`}
                    key={item.id}
                  >
                    {item.entries.length > 1 && (
                      <div className="digest-group-heading">
                        <span>
                          <Layers3 size={14} /> Même annonce probable ·{" "}
                          {item.entries.length} publications
                        </span>
                        <p>
                          Ces reprises ne constituent pas des confirmations
                          indépendantes.
                        </p>
                      </div>
                    )}
                    {item.entries.map((entry) => (
                      <ReviewEntry key={entry.article.id} entry={entry} />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="empty-state digest-empty">
          <span className="empty-icon">
            <Newspaper size={27} />
          </span>
          <h2>Aucune publication pour cette revue.</h2>
          <p>
            {edition.configuredSources === 0
              ? "Ajoutez des sources pour commencer votre veille."
              : digest.scope === "personal"
                ? "Aucune première collecte ou modification détectée sur cette période ne correspond à votre profil et à vos retours actuels. Essayez 7 jours ou Tout le flux."
                : "Aucune première collecte ou modification n’a été détectée sur cette période. Essayez 7 jours ou consultez vos sources."}
          </p>
          <p>
            La date de publication originale ne détermine pas l’inclusion dans
            la revue.
          </p>
          {edition.configuredSources === 0 && (
            <button
              type="button"
              className="button button-secondary"
              onClick={onOpenSources}
            >
              Ajouter des sources <ArrowUpRight size={15} />
            </button>
          )}
        </div>
      )}
      <p className="digest-footnote">
        Les titres et extraits proviennent des sources. Ouvrez les publications
        originales pour lire le contenu complet.
      </p>
    </div>
  );
}

function ReviewEntry({ entry }: { entry: DigestEntry }) {
  const article = entry.article;
  const url = digestUrl(article.url);
  return (
    <article className="digest-entry">
      <div className="digest-entry-meta">
        <span className="digest-entry-source">{article.sourceName}</span>
        <span>{languageLabel(article.language)}</span>
        <span className={`digest-kind digest-kind-${entry.kind}`}>
          {entry.kind === "new" ? "Première collecte" : "Actualisée"}
        </span>
      </div>
      <h3>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {article.title} <ArrowUpRight size={16} />
          </a>
        ) : (
          article.title
        )}
      </h3>
      {!url && (
        <p className="digest-link-unavailable">Lien original indisponible.</p>
      )}
      <dl className="digest-entry-dates">
        <div>
          <dt>Publication originale</dt>
          <dd>
            <time dateTime={article.publishedAt ?? undefined}>
              {dateLabel(article.publishedAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>
            {entry.kind === "new"
              ? "Première collecte"
              : "Modification détectée"}
          </dt>
          <dd>
            <time dateTime={entry.detectedAt}>
              {dateLabel(entry.detectedAt, true)}
            </time>
          </dd>
        </div>
      </dl>
      {article.excerpt && article.contentBasis !== "metadata" ? (
        <div className="digest-excerpt">
          <span>
            {article.contentBasis === "page_excerpt"
              ? "Extrait de la page"
              : "Extrait du flux"}
          </span>
          <p>{article.excerpt}</p>
        </div>
      ) : (
        <p className="digest-no-excerpt">
          {article.contentBasis === "metadata"
            ? "Titre et métadonnées uniquement."
            : "Aucun extrait disponible dans cette revue."}
        </p>
      )}
    </article>
  );
}
