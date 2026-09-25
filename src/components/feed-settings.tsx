"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  Compass,
  Plus,
  Radio,
  RefreshCw,
  X,
} from "lucide-react";
import {
  FEED_PRESETS,
  GENERAL_FEED,
  parseFeedInput,
  type CustomFeed,
  type FeedInput,
} from "@/lib/custom-feeds";
import type { Article, MonitorAction } from "@/lib/types";

type FeedAction = (action: MonitorAction) => Promise<boolean>;

function editable(feed: FeedInput): FeedInput {
  return {
    name: feed.name,
    instructions: feed.instructions,
    exclusions: feed.exclusions,
    minScore: feed.minScore,
    minConfidence: feed.minConfidence,
    sort: feed.sort,
    enabled: feed.enabled,
  };
}

function blankFeed(): FeedInput {
  return { ...GENERAL_FEED, name: "", instructions: "", exclusions: "" };
}

function numberLabel(value: number) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(
    value,
  );
}

function textKey(value: string) {
  return value.normalize("NFC").trim();
}

export function FeedManager({
  feeds,
  busy,
  onAction,
  onSelect,
}: {
  feeds: CustomFeed[];
  busy: boolean;
  onAction: FeedAction;
  onSelect: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [preset, setPreset] = useState("custom");
  const [draft, setDraft] = useState<FeedInput>(blankFeed);
  const [error, setError] = useState<string | null>(null);
  const active = feeds.filter((feed) => !feed.archived);
  const archived = feeds.filter((feed) => feed.archived);

  function changePreset(id: string) {
    setPreset(id);
    const selected = FEED_PRESETS.find((item) => item.id === id);
    setDraft(selected ? editable(selected) : blankFeed());
    setError(null);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const feed = parseFeedInput(draft);
      if (await onAction({ action: "createCustomFeed", feed })) {
        setCreating(false);
        setPreset("custom");
        setDraft(blankFeed());
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Vérifiez les paramètres du fil.",
      );
    }
  }

  function feedRow(feed: CustomFeed) {
    return (
      <div className="custom-feed-row" key={feed.id}>
        <button
          className="custom-feed-open"
          type="button"
          onClick={() => onSelect(feed.id)}
        >
          {feed.isGeneral ? <Compass size={18} /> : <Radio size={18} />}
          <span>
            <strong>
              {feed.isGeneral ? `Pour moi · ${feed.name}` : feed.name}
            </strong>
            <small>
              {feed.archived
                ? "Archivé"
                : !feed.enabled
                  ? "Analyses en pause"
                  : `${feed.analysis.ready} analyse${feed.analysis.ready > 1 ? "s" : ""} disponible${feed.analysis.ready > 1 ? "s" : ""}`}
            </small>
          </span>
          <ArrowRight size={15} />
        </button>
        {!feed.isGeneral && (
          <button
            type="button"
            className="custom-feed-archive"
            disabled={busy}
            aria-label={`${feed.archived ? "Restaurer" : "Archiver"} ${feed.name}`}
            onClick={() =>
              void onAction({
                action: "setCustomFeedArchived",
                id: feed.id,
                value: !feed.archived,
              })
            }
          >
            {feed.archived ? (
              <ArchiveRestore size={16} />
            ) : (
              <Archive size={16} />
            )}
            <span>{feed.archived ? "Restaurer" : "Archiver"}</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <section
      className="panel custom-feed-manager"
      aria-labelledby="custom-feeds-title"
    >
      <div className="custom-feed-manager-heading">
        <div>
          <h2 id="custom-feeds-title">Vos fils</h2>
          <p>Un fil général et des sélections propres à chaque sujet.</p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() => {
            setCreating(!creating);
            setError(null);
          }}
        >
          <Plus size={15} /> Nouveau fil
        </button>
      </div>
      <div className="custom-feed-list">{active.map(feedRow)}</div>
      {archived.length > 0 && (
        <details className="custom-feed-archives">
          <summary>Fils archivés ({archived.length})</summary>
          <div className="custom-feed-list">{archived.map(feedRow)}</div>
        </details>
      )}
      {creating && (
        <form
          className="custom-feed-create"
          onSubmit={(event) => void create(event)}
        >
          <div className="custom-feed-create-heading">
            <h3>Créer un fil</h3>
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              aria-label="Fermer la création du fil"
              onClick={() => setCreating(false)}
            >
              <X size={17} />
            </button>
          </div>
          <fieldset disabled={busy} className="feed-fields">
            <label htmlFor="feed-preset">Point de départ</label>
            <select
              id="feed-preset"
              value={preset}
              onChange={(event) => changePreset(event.target.value)}
            >
              <option value="custom">Personnalisé</option>
              {FEED_PRESETS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <FeedTextFields
              prefix="new-feed"
              value={draft}
              onChange={setDraft}
            />
            <FeedThresholdFields
              prefix="new-feed"
              value={draft}
              onChange={setDraft}
            />
            <FeedEnabledField
              prefix="new-feed"
              value={draft}
              onChange={setDraft}
            />
          </fieldset>
          <p className="feed-settings-help">
            La création enregistre ces consignes. Les analyses utilisent le mode
            Jev actif et le budget mensuel partagé.
          </p>
          {error && (
            <p className="feed-settings-error" role="alert">
              {error}
            </p>
          )}
          <div className="feed-settings-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={
                busy || !draft.name.trim() || !draft.instructions.trim()
              }
            >
              <Plus size={15} /> Créer le fil
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Annuler
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function FeedSettings(props: {
  feed: CustomFeed;
  articles: Article[];
  busy: boolean;
  onAction: FeedAction;
}) {
  return <FeedEditor key={props.feed.id} {...props} />;
}

function FeedEditor({
  feed,
  articles,
  busy,
  onAction,
}: {
  feed: CustomFeed;
  articles: Article[];
  busy: boolean;
  onAction: FeedAction;
}) {
  const [draft, setDraft] = useState(() => editable(feed));
  const [base, setBase] = useState(() => editable(feed));
  const [baseRevision, setBaseRevision] = useState(feed.revision);
  const [acceptSavedState, setAcceptSavedState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!acceptSavedState) return;
    const saved = editable(feed);
    setDraft(saved);
    setBase(saved);
    setBaseRevision(feed.revision);
    setAcceptSavedState(false);
  }, [feed, acceptSavedState]);
  const changed = JSON.stringify(draft) !== JSON.stringify(base);
  const instructionsChanged =
    textKey(draft.instructions) !== textKey(base.instructions) ||
    textKey(draft.exclusions) !== textKey(base.exclusions);
  const externalChange = feed.revision !== baseRevision && !acceptSavedState;
  const preview = useMemo(() => {
    const known = articles.flatMap((article) => {
      const analysis =
        article.feedAnalyses?.[feed.id] ??
        (feed.isGeneral ? article.jev : undefined);
      return analysis ? [{ article, analysis }] : [];
    });
    const confident = known.filter(
      ({ analysis }) => analysis.confidence >= draft.minConfidence,
    );
    const retained = confident.filter(
      ({ analysis }) => analysis.score >= draft.minScore,
    );
    const date = (article: Article) => {
      const value = Date.parse(article.publishedAt ?? article.collectedAt);
      return Number.isFinite(value) ? value : 0;
    };
    retained.sort(
      (a, b) =>
        (draft.sort === "relevance"
          ? b.analysis.score - a.analysis.score
          : 0) ||
        date(b.article) - date(a.article) ||
        a.article.id.localeCompare(b.article.id),
    );
    return {
      known: known.length,
      uncertain: known.length - confident.length,
      retained,
    };
  }, [
    articles,
    feed.id,
    feed.isGeneral,
    draft.minScore,
    draft.minConfidence,
    draft.sort,
  ]);

  function reload() {
    const current = editable(feed);
    setDraft(current);
    setBase(current);
    setBaseRevision(feed.revision);
    setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || feed.archived || !changed) return;
    setError(null);
    try {
      const input = parseFeedInput(draft);
      if (
        await onAction({
          action: "updateCustomFeed",
          id: feed.id,
          revision: baseRevision,
          feed: input,
        })
      )
        setAcceptSavedState(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Vérifiez les paramètres du fil.",
      );
    }
  }

  return (
    <section
      className="panel custom-feed-settings"
      aria-labelledby="feed-settings-title"
    >
      <div className="custom-feed-settings-heading">
        <div>
          <h2 id="feed-settings-title">Paramètres · {feed.name}</h2>
          <p>
            {feed.isGeneral
              ? "Les consignes de votre fil Pour moi."
              : "Une sélection dédiée à ce sujet."}
          </p>
        </div>
        <span
          className={`feed-analysis-state ${feed.enabled && !feed.archived ? "is-enabled" : ""}`}
        >
          {feed.archived
            ? "Archivé"
            : feed.enabled
              ? "Fil actif"
              : "Analyses en pause"}
        </span>
      </div>
      <div
        className="feed-analysis-progress"
        aria-label={`État des analyses de ${feed.name}`}
      >
        <div>
          <strong>{feed.analysis.ready}</strong>
          <span>disponibles</span>
        </div>
        <div>
          <strong>{feed.analysis.pending}</strong>
          <span>en attente</span>
        </div>
        <div>
          <strong>{feed.analysis.failed}</strong>
          <span>en échec</span>
        </div>
      </div>
      {feed.analysis.ready + feed.analysis.pending + feed.analysis.failed >
        0 && (
        <progress
          className="feed-analysis-bar"
          value={feed.analysis.ready}
          max={
            feed.analysis.ready + feed.analysis.pending + feed.analysis.failed
          }
          aria-label={`Progression des analyses de ${feed.name}`}
        />
      )}
      {feed.archived && (
        <p className="feed-settings-help">
          Ce fil conserve ses paramètres. Restaurez-le depuis la liste pour
          reprendre sa configuration et ses analyses.
        </p>
      )}
      {externalChange && (
        <div className="feed-external-change" role="status">
          <CircleAlert size={17} />
          <span>
            Ce fil a été modifié ailleurs. Votre brouillon est conservé ;
            rechargez les paramètres enregistrés avant de continuer.
          </span>
          <button type="button" disabled={busy} onClick={reload}>
            <RefreshCw size={14} /> Recharger les paramètres
          </button>
        </div>
      )}
      <form onSubmit={(event) => void save(event)}>
        <fieldset className="feed-fields" disabled={busy || feed.archived}>
          <FeedTextFields
            prefix="edit-feed"
            value={draft}
            onChange={setDraft}
            general={feed.isGeneral}
          />
          <FeedThresholdFields
            prefix="edit-feed"
            value={draft}
            onChange={setDraft}
          />
          <FeedEnabledField
            prefix="edit-feed"
            value={draft}
            onChange={setDraft}
          />
        </fieldset>
        <p className="feed-settings-help">
          Modifier les consignes ou les exclusions prépare une nouvelle analyse
          de ce fil à l’enregistrement, selon le mode Jev actif et le budget
          partagé. Modifier les seuils, le nom ou le tri réutilise les résultats
          existants.
        </p>
        {error && (
          <p className="feed-settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="feed-settings-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || feed.archived || !changed}
          >
            <Check size={16} /> Enregistrer ce fil
          </button>
          {changed && (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={reload}
            >
              Annuler les modifications
            </button>
          )}
        </div>
      </form>

      <section
        className="feed-local-preview"
        aria-labelledby="feed-preview-title"
      >
        <div className="feed-preview-heading">
          <h3 id="feed-preview-title">Aperçu des seuils</h3>
          <span>Sans nouvel appel</span>
        </div>
        {(instructionsChanged || externalChange) && (
          <p className="feed-preview-warning" role="status">
            <CircleAlert size={15} />
            <span>
              Les scores ci-dessous proviennent des consignes déjà enregistrées.
              Ils ne prédisent pas l’effet de votre nouveau texte.
            </span>
          </p>
        )}
        <p>
          <strong>{preview.retained.length}</strong> publication
          {preview.retained.length > 1 ? "s" : ""} retenue
          {preview.retained.length > 1 ? "s" : ""} parmi{" "}
          <strong>{preview.known}</strong> analyse{preview.known > 1 ? "s" : ""}{" "}
          disponible{preview.known > 1 ? "s" : ""}, avant vos retours.
        </p>
        <p className="feed-settings-help">
          {preview.uncertain} analyse{preview.uncertain > 1 ? "s" : ""} sous le
          seuil de confiance.{" "}
          {feed.isGeneral
            ? "Dans Pour moi, les règles complètent les analyses absentes ou incertaines ; vos retours restent prioritaires."
            : "Ce fil utilise ses propres analyses et vos retours. Les publications non analysées ou incertaines ne sont pas retenues automatiquement."}
        </p>
        {preview.retained.length > 0 ? (
          <ol>
            {preview.retained.slice(0, 5).map(({ article, analysis }) => (
              <li key={article.id}>
                <div>
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title} <ArrowUpRight size={13} />
                  </a>
                  <span>{article.sourceName}</span>
                </div>
                <strong>{numberLabel(analysis.score)} / 3</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="feed-preview-empty">
            {preview.known === 0
              ? "Aucune analyse disponible pour ce fil. Les scores apparaîtront après son traitement."
              : "Aucune analyse actuelle ne franchit ces deux seuils."}
          </p>
        )}
        {preview.retained.length > 5 && (
          <p className="feed-settings-help">
            Les 5 premières publications sont affichées, selon le tri choisi.
          </p>
        )}
      </section>
    </section>
  );
}

function FeedTextFields({
  prefix,
  value,
  onChange,
  general = false,
}: {
  prefix: string;
  value: FeedInput;
  onChange: (value: FeedInput) => void;
  general?: boolean;
}) {
  return (
    <>
      <label htmlFor={`${prefix}-name`}>Nom du fil</label>
      <input
        id={`${prefix}-name`}
        value={value.name}
        onChange={(event) => onChange({ ...value, name: event.target.value })}
        required
        maxLength={80}
        readOnly={general}
      />
      <label htmlFor={`${prefix}-instructions`}>Ce que je veux suivre</label>
      <textarea
        id={`${prefix}-instructions`}
        rows={5}
        value={value.instructions}
        onChange={(event) =>
          onChange({ ...value, instructions: event.target.value })
        }
        required
        maxLength={4000}
        placeholder="Les sujets, évolutions et types de publications qui m’intéressent…"
      />
      <label htmlFor={`${prefix}-exclusions`}>
        Ce que je veux écarter <span>facultatif</span>
      </label>
      <textarea
        id={`${prefix}-exclusions`}
        rows={3}
        value={value.exclusions}
        onChange={(event) =>
          onChange({ ...value, exclusions: event.target.value })
        }
        maxLength={2000}
        placeholder="Les sujets hors périmètre ou les mentions trop anecdotiques…"
      />
    </>
  );
}

function FeedThresholdFields({
  prefix,
  value,
  onChange,
}: {
  prefix: string;
  value: FeedInput;
  onChange: (value: FeedInput) => void;
}) {
  const confidenceChoices = Array.from(
    { length: 11 },
    (_, index) => index / 10,
  );
  return (
    <div className="feed-threshold-fields">
      <div className="feed-score-field">
        <label htmlFor={`${prefix}-score`}>
          Note minimale{" "}
          <output htmlFor={`${prefix}-score`}>
            {numberLabel(value.minScore)} / 3
          </output>
        </label>
        <input
          id={`${prefix}-score`}
          type="range"
          min={0}
          max={3}
          step={0.1}
          value={value.minScore}
          onChange={(event) =>
            onChange({ ...value, minScore: Number(event.target.value) })
          }
        />
        <div className="feed-score-scale" aria-hidden="true">
          <span>0 · Large</span>
          <span>3 · Très ciblé</span>
        </div>
      </div>
      <div>
        <label htmlFor={`${prefix}-confidence`}>Confiance minimale</label>
        <select
          id={`${prefix}-confidence`}
          value={value.minConfidence}
          onChange={(event) =>
            onChange({ ...value, minConfidence: Number(event.target.value) })
          }
        >
          {!confidenceChoices.includes(value.minConfidence) && (
            <option value={value.minConfidence}>
              {numberLabel(value.minConfidence * 100)} %
            </option>
          )}
          {confidenceChoices.map((choice) => (
            <option key={choice} value={choice}>
              {Math.round(choice * 100)} %
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${prefix}-sort`}>Ordre des publications</label>
        <select
          id={`${prefix}-sort`}
          value={value.sort}
          onChange={(event) =>
            onChange({
              ...value,
              sort: event.target.value as FeedInput["sort"],
            })
          }
        >
          <option value="relevance">Pertinence, puis date</option>
          <option value="date">Plus récentes d’abord</option>
        </select>
      </div>
    </div>
  );
}

function FeedEnabledField({
  prefix,
  value,
  onChange,
}: {
  prefix: string;
  value: FeedInput;
  onChange: (value: FeedInput) => void;
}) {
  return (
    <label className="feed-enabled-field" htmlFor={`${prefix}-enabled`}>
      <input
        id={`${prefix}-enabled`}
        type="checkbox"
        checked={value.enabled}
        onChange={(event) =>
          onChange({ ...value, enabled: event.target.checked })
        }
      />
      <span>
        Analyser les publications pour ce fil
        <small>La pause conserve les résultats déjà disponibles.</small>
      </span>
    </label>
  );
}
