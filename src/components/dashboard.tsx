"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Compass,
  ExternalLink,
  Eye,
  FolderOpen,
  Globe2,
  Layers3,
  ListFilter,
  LoaderCircle,
  Newspaper,
  Pencil,
  Radio,
  RefreshCw,
  Rss,
  Search,
  Settings2,
  Signal,
  Split,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import type {
  Article,
  Feedback,
  Folder,
  MonitorAction,
  Profile,
  ProfilePreview,
  Snapshot,
  Source,
  SourceStatus,
} from "@/lib/types";
import type { StoryGroup } from "@/lib/stories";
import { buildFeedItems } from "@/lib/story-feed";
import {
  activityOrder,
  matchesActivity,
  MAX_ACTIVITY_BATCH,
  reviewBatch,
  type ActivityFilter,
} from "@/lib/activity";
import {
  matchesProfile,
  matchesEvaluation,
  type EvaluationFilter,
} from "@/lib/selection";
import { ArticleFolders, FolderManager } from "@/components/folder-controls";
import { CollectionSchedule } from "@/components/collection-schedule";
import { useMonitorSnapshot } from "@/components/use-monitor-snapshot";
import { DigestView } from "@/components/digest-view";

type View =
  | "personal"
  | "all"
  | "digest"
  | "saved"
  | "folders"
  | "evaluation"
  | "sources"
  | "profile";
type Notice = { kind: "success" | "error"; text: string } | null;
type RelatedPublication = { article: Article; reason: string };

const views = [
  { id: "personal", label: "Pour moi", icon: Compass },
  { id: "all", label: "Tout le flux", icon: Radio },
  { id: "digest", label: "Revue", icon: Newspaper },
  { id: "saved", label: "Sauvegardés", icon: Bookmark },
  { id: "folders", label: "Dossiers", icon: FolderOpen },
  { id: "evaluation", label: "Évaluer", icon: CheckCheck },
  { id: "sources", label: "Sources", icon: Rss },
  { id: "profile", label: "Profil de veille", icon: Settings2 },
] as const;

const viewCopy: Record<
  View,
  { eyebrow: string; title: string; description: string }
> = {
  personal: {
    eyebrow: "VOTRE VEILLE",
    title: "Pour moi",
    description:
      "Les publications qui correspondent à votre profil, réunies au même endroit.",
  },
  all: {
    eyebrow: "EXPLORER",
    title: "Tout le flux",
    description:
      "Retrouvez chaque publication collectée et explorez au-delà de votre sélection.",
  },
  saved: {
    eyebrow: "VOTRE BIBLIOTHÈQUE",
    title: "Sauvegardés",
    description:
      "Vos publications sauvegardées, pour y revenir quand vous en avez besoin.",
  },
  digest: {
    eyebrow: "VOTRE POINT DE VEILLE",
    title: "Revue de veille",
    description: "Titres et extraits disponibles, organisés par thème.",
  },
  folders: {
    eyebrow: "VOTRE BIBLIOTHÈQUE",
    title: "Dossiers",
    description:
      "Organisez vos publications par sujet. Une publication peut appartenir à plusieurs dossiers.",
  },
  evaluation: {
    eyebrow: "VOS RETOURS",
    title: "Évaluer la sélection",
    description:
      "Repérez les publications manquées ou retenues à tort par vos règles et ajustez votre veille.",
  },
  sources: {
    eyebrow: "VOS SOURCES",
    title: "Sources",
    description:
      "Gérez les sites suivis et vérifiez le résultat de chaque collecte.",
  },
  profile: {
    eyebrow: "VOS CRITÈRES",
    title: "Profil de veille",
    description:
      "Définissez vos intérêts et ajustez le seuil de sélection de votre veille.",
  },
};

const statusLabels: Record<SourceStatus, string> = {
  pending: "À collecter",
  ok: "Collecte réussie",
  empty: "Aucune publication trouvée",
  error: "Erreur de collecte",
  unsupported: "Connecteur à ajouter",
};

function dateLabel(value: string | null, withTime = false) {
  if (!value) return "Date non fournie";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date non fournie";
  return new Intl.DateTimeFormat("fr-FR", {
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}),
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
  }).format(date);
}

function languageLabel(value: string) {
  const known: Record<string, string> = {
    en: "Anglais",
    fr: "Français",
    uk: "Ukrainien",
    de: "Allemand",
    es: "Espagnol",
    und: "Non précisée",
  };
  return known[value] ?? value;
}

const evaluationFilters: { id: EvaluationFilter; label: string }[] = [
  { id: "unreviewed", label: "À évaluer" },
  { id: "missed", label: "Manqués par les règles" },
  { id: "off_topic", label: "Retenus mais hors sujet" },
  { id: "reviewed", label: "Tous les retours" },
];

const activityFilters: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "new", label: "Nouvelles" },
  { id: "updated", label: "Actualisées" },
];

function percentage(value: number | null) {
  return value === null
    ? "—"
    : new Intl.NumberFormat("fr-FR", {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(value);
}

function splitKeywords(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean),
    ),
  ];
}

export function Dashboard({ initialData }: { initialData: Snapshot }) {
  const { data, acceptSnapshot, beginChange, endChange, refresh, syncError } =
    useMonitorSnapshot(initialData, invalidatePreview);
  const [view, setView] = useState<View>("personal");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(
    initialData.folders.find((folder) => !folder.archived)?.id ??
      initialData.folders[0]?.id ??
      null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [languageFilter, setLanguageFilter] = useState("");
  const [themeFilter, setThemeFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [groupStories, setGroupStories] = useState(true);
  const [evaluationFilter, setEvaluationFilter] =
    useState<EvaluationFilter>("unreviewed");
  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const previewRequest = useRef(0);
  const [keywords, setKeywords] = useState(data.profile.keywords.join(", "));
  const [excludeKeywords, setExcludeKeywords] = useState(
    data.profile.excludeKeywords.join(", "),
  );
  const [minScore, setMinScore] = useState(String(data.profile.minScore));
  const [matchScope, setMatchScope] = useState<
    NonNullable<Profile["matchScope"]>
  >(data.profile.matchScope ?? "all_text");
  const [sourceName, setSourceName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const sourceNameInput = useRef<HTMLInputElement>(null);

  const selected = data.articles.filter((article) =>
    matchesProfile(article, data.profile),
  );
  const saved = data.articles.filter((article) => article.saved);
  const selectedFolder =
    data.folders.find((folder) => folder.id === selectedFolderId) ??
    data.folders.find((folder) => !folder.archived) ??
    data.folders[0] ??
    null;
  const enabledSources = data.sources.filter((source) => source.enabled).length;
  const hasFilters = Boolean(
    search ||
    sourceFilter ||
    languageFilter ||
    themeFilter ||
    formatFilter ||
    (view !== "evaluation" && activityFilter !== "all"),
  );
  const languages = [
    ...new Set(data.articles.map((article) => article.language)),
  ].sort();
  const themes = [
    ...new Set(data.articles.flatMap((article) => article.themes)),
  ].sort((a, b) => a.localeCompare(b, "fr"));

  const filteredArticles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr");
    return data.articles.filter((article) => {
      if (view === "personal" && !matchesProfile(article, data.profile))
        return false;
      if (view === "saved" && !article.saved) return false;
      if (
        view === "folders" &&
        (!selectedFolder || !article.folderIds.includes(selectedFolder.id))
      )
        return false;
      if (
        view === "evaluation" &&
        !matchesEvaluation(article, data.profile, evaluationFilter)
      )
        return false;
      if (sourceFilter && article.sourceId !== sourceFilter) return false;
      if (languageFilter && article.language !== languageFilter) return false;
      if (themeFilter && !article.themes.includes(themeFilter)) return false;
      if (formatFilter && article.format !== formatFilter) return false;
      if (
        query &&
        ![article.title, article.excerpt, article.sourceName, ...article.themes]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("fr")
          .includes(query)
      )
        return false;
      return true;
    });
  }, [
    data,
    view,
    search,
    sourceFilter,
    languageFilter,
    themeFilter,
    formatFilter,
    evaluationFilter,
    selectedFolder,
  ]);

  const articles = useMemo(() => {
    if (view === "evaluation" || activityFilter === "all")
      return filteredArticles;
    return filteredArticles
      .filter((article) => matchesActivity(article, activityFilter))
      .sort(activityOrder);
  }, [filteredArticles, view, activityFilter]);
  const activityCounts = {
    all: filteredArticles.length,
    new: filteredArticles.filter((article) => article.changeKind === "new")
      .length,
    updated: filteredArticles.filter(
      (article) => article.changeKind === "updated",
    ).length,
  };
  const visibleChanges = articles.filter(
    (article) => article.changeKind,
  ).length;
  const activityBatch = reviewBatch(articles);

  const feedItems = useMemo(
    () =>
      buildFeedItems(
        articles,
        groupStories && view !== "evaluation" ? data.stories.groups : [],
      ),
    [articles, groupStories, data.stories.groups, view],
  );
  const groupedCount = feedItems.filter((item) => item.group).length;
  const relatedByArticle = useMemo(() => {
    const visible = new Map(articles.map((article) => [article.id, article]));
    const relations = new Map<string, RelatedPublication[]>();
    for (const { articleIds, reason } of data.stories.related) {
      const first = visible.get(articleIds[0]);
      const second = visible.get(articleIds[1]);
      if (!first || !second) continue;
      relations.set(first.id, [
        ...(relations.get(first.id) ?? []),
        { article: second, reason },
      ]);
      relations.set(second.id, [
        ...(relations.get(second.id) ?? []),
        { article: first, reason },
      ]);
    }
    return relations;
  }, [articles, data.stories.related]);

  async function mutate(
    action: MonitorAction,
    key: string = action.action,
    successMessage?: string,
  ) {
    const change = beginChange();
    if (change === null) return false;
    setPending(key);
    setNotice(null);
    try {
      const response = await fetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      const result = (await response.json()) as {
        snapshot?: Snapshot;
        folderId?: string;
        message?: string;
        error?: string;
      };
      if (!response.ok || !result.snapshot)
        throw new Error(
          result.error || "L’action n’a pas pu être effectuée. Réessayez.",
        );
      acceptSnapshot(result.snapshot);
      if (action.action === "createFolder") {
        if (result.folderId) {
          setSelectedFolderId(result.folderId);
          resetFilters();
        }
      } else if (selectedFolderId === null) {
        const fallbackFolderId =
          selectedFolder?.id ??
          result.snapshot.folders.find((folder) => !folder.archived)?.id ??
          result.snapshot.folders[0]?.id ??
          null;
        setSelectedFolderId((current) => current ?? fallbackFolderId);
      }
      if (result.message || successMessage)
        setNotice({ kind: "success", text: result.message || successMessage! });
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Une erreur est survenue. Réessayez.",
      });
      return false;
    } finally {
      setPending(null);
      endChange(change);
    }
  }

  function invalidatePreview() {
    previewRequest.current += 1;
    setPreview(null);
  }

  function draftProfile(): Profile {
    return {
      keywords: splitKeywords(keywords),
      excludeKeywords: splitKeywords(excludeKeywords),
      minScore: Number(minScore),
      matchScope,
    };
  }

  async function previewProfile() {
    const change = beginChange();
    if (change === null) return;
    const request = ++previewRequest.current;
    setPending("previewProfile");
    setPreview(null);
    setNotice(null);
    try {
      const response = await fetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "previewProfile",
          profile: draftProfile(),
        }),
      });
      const result = (await response.json()) as {
        preview?: ProfilePreview;
        error?: string;
      };
      if (!response.ok || !result.preview)
        throw new Error(
          result.error || "La prévisualisation a échoué. Réessayez.",
        );
      if (request === previewRequest.current) setPreview(result.preview);
    } catch (error) {
      if (request === previewRequest.current)
        setNotice({
          kind: "error",
          text:
            error instanceof Error
              ? error.message
              : "La prévisualisation a échoué. Réessayez.",
        });
    } finally {
      setPending(null);
      endChange(change);
    }
  }

  function openEvaluation(filter: EvaluationFilter) {
    setEvaluationFilter(filter);
    changeView("evaluation");
  }

  function resetFilters() {
    setSearch("");
    setSourceFilter("");
    setLanguageFilter("");
    setThemeFilter("");
    setFormatFilter("");
    setActivityFilter("all");
  }

  function changeView(next: View) {
    if (next === "folders")
      setSelectedFolderId((current) => current ?? selectedFolder?.id ?? null);
    setView(next);
    resetFilters();
  }

  function openFolder(id?: string) {
    setSelectedFolderId(id ?? selectedFolder?.id ?? null);
    changeView("folders");
  }

  function resetSourceForm() {
    setEditingSourceId(null);
    setSourceName("");
    setSiteUrl("");
    setFeedUrl("");
    setSourceLanguage("");
  }

  function editSource(source: Source) {
    setEditingSourceId(source.id);
    setSourceName(source.name);
    setSiteUrl(source.siteUrl);
    setFeedUrl(source.feedUrl ?? "");
    setSourceLanguage(source.language === "und" ? "" : source.language);
    sourceNameInput.current?.focus();
  }

  async function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await mutate(
      {
        action: "addSource",
        name: sourceName.trim(),
        siteUrl: siteUrl.trim(),
        feedUrl: feedUrl.trim(),
        ...(sourceLanguage ? { language: sourceLanguage } : {}),
      },
      "addSource",
      editingSourceId
        ? "Source mise à jour. Son état d’activation est conservé."
        : "Source ajoutée. Lancez une collecte pour récupérer ses publications.",
    );
    if (success) {
      resetSourceForm();
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate(
      {
        action: "updateProfile",
        profile: draftProfile(),
      },
      "updateProfile",
      "Profil enregistré. La sélection a été recalculée.",
    );
  }

  const copy = viewCopy[view];
  const busy = pending !== null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Aller au contenu
      </a>
      <aside className="sidebar" aria-label="Navigation principale">
        <a
          className="brand"
          href="/"
          aria-label="Defense Tech Monitor — accueil"
        >
          <span className="brand-symbol">
            <Signal size={22} strokeWidth={2.5} />
          </span>
          <span>
            DEFENSE TECH<span className="brand-subtitle">MONITOR</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="live-dot" /> Espace de veille
        </div>
        <nav className="main-nav">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${view === id ? "active" : ""} ${id === "sources" ? "nav-section-start" : ""}`}
              onClick={() => changeView(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "personal" && (
                <span className="nav-count">{selected.length}</span>
              )}
              {id === "saved" && saved.length > 0 && (
                <span className="nav-count">{saved.length}</span>
              )}
              {id === "folders" &&
                data.folders.some((folder) => !folder.archived) && (
                  <span className="nav-count">
                    {data.folders.filter((folder) => !folder.archived).length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Radio size={17} />
            <span>
              {enabledSources} source{enabledSources > 1 ? "s" : ""} active
              {enabledSources > 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Monitor</span>
            <ChevronRight size={14} />
            <strong>{views.find((item) => item.id === view)?.label}</strong>
            {view === "folders" && selectedFolder && (
              <>
                <ChevronRight size={14} />
                <span className="breadcrumb-folder">{selectedFolder.name}</span>
              </>
            )}
          </div>
          <span className="topbar-label">
            <span className="tiny-dot" /> Veille personnelle
          </span>
        </header>

        <main id="main-content" className="main-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1>{copy.title}</h1>
              <p className="page-description">{copy.description}</p>
            </div>
            <div className="collection-control">
              <button
                className="button button-primary"
                type="button"
                disabled={busy || data.collection.running}
                onClick={() => void mutate({ action: "collect" }, "collect")}
              >
                {pending === "collect" || data.collection.running ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <RefreshCw size={17} />
                )}
                {pending === "collect" || data.collection.running
                  ? "Collecte en cours…"
                  : "Actualiser les sources"}
              </button>
              <span>
                {data.lastCollectionAt
                  ? `Dernière consultation : ${dateLabel(data.lastCollectionAt, true)}`
                  : "Aucune source consultée"}
              </span>
            </div>
          </section>

          {notice && (
            <div
              className={`notice notice-${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              {notice.kind === "error" ? (
                <CircleAlert size={18} />
              ) : (
                <Check size={18} />
              )}
              <span>{notice.text}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setNotice(null)}
                aria-label="Fermer le message"
              >
                <X size={17} />
              </button>
            </div>
          )}

          {syncError && (
            <div className="snapshot-sync-error" role="status">
              <CircleAlert size={16} />
              <span>{syncError}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Réessayer
              </button>
            </div>
          )}

          {view !== "digest" && (
            <div className="stats-grid" aria-label="Vue d’ensemble">
              <Stat
                label="Publications collectées"
                value={data.articles.length}
                icon={<Radio size={18} />}
              />
              <Stat
                label="Dans votre sélection"
                value={selected.length}
                icon={<Compass size={18} />}
                highlight
              />
              <Stat
                label="À lire dans la sélection"
                value={selected.filter((article) => !article.isRead).length}
                icon={<Eye size={18} />}
              />
              <Stat
                label="Publications sauvegardées"
                value={saved.length}
                icon={<Bookmark size={18} />}
              />
            </div>
          )}

          {view === "digest" && (
            <DigestView
              snapshot={data}
              onOpenSources={() => changeView("sources")}
            />
          )}

          {view === "folders" && (
            <FolderManager
              folders={data.folders}
              selectedFolder={selectedFolder}
              busy={busy}
              onSelect={openFolder}
              onAction={(action) => mutate(action)}
            />
          )}

          {(view === "personal" ||
            view === "all" ||
            view === "saved" ||
            (view === "folders" && selectedFolder) ||
            view === "evaluation") && (
            <>
              {view === "personal" && (
                <div className="selection-note">
                  <span className="selection-icon">
                    <Settings2 size={16} />
                  </span>
                  <span>
                    Votre sélection s’appuie sur{" "}
                    <strong>
                      {data.profile.keywords.length} mot
                      {data.profile.keywords.length > 1 ? "s" : ""}-clé
                      {data.profile.keywords.length > 1 ? "s" : ""}
                    </strong>{" "}
                    et{" "}
                    <strong>
                      {data.profile.minScore} correspondance
                      {data.profile.minScore > 1 ? "s" : ""} minimale
                      {data.profile.minScore > 1 ? "s" : ""}
                    </strong>
                    , ainsi que sur vos retours.
                  </span>
                  <button type="button" onClick={() => changeView("profile")}>
                    Ajuster mon profil <ArrowRight size={14} />
                  </button>
                </div>
              )}
              {view === "evaluation" && (
                <section
                  className="evaluation-controls"
                  aria-label="Parcours d’évaluation"
                >
                  <div
                    className="evaluation-tabs"
                    role="group"
                    aria-label="Publications à évaluer"
                  >
                    {evaluationFilters.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={evaluationFilter === id}
                        className={`evaluation-tab ${evaluationFilter === id ? "is-selected" : ""}`}
                        onClick={() => setEvaluationFilter(id)}
                      >
                        {label}
                        <span>
                          {
                            data.articles.filter((article) =>
                              matchesEvaluation(article, data.profile, id),
                            ).length
                          }
                        </span>
                      </button>
                    ))}
                  </div>
                  <p>
                    « Pertinent » ajoute la publication à Pour moi. « Hors sujet
                    » et « Déjà vu » la retirent. Cliquez à nouveau sur votre
                    retour pour réappliquer les règles.
                  </p>
                  <p>
                    Les écarts ci-dessous portent sur les règles, avant vos
                    corrections. « Déjà vu » ne mesure pas la pertinence. Chaque
                    publication est affichée séparément pour l’évaluer.
                  </p>
                </section>
              )}
              <section className="feed-section" aria-labelledby="feed-title">
                <div className="section-heading">
                  <div className="section-title">
                    <h2 id="feed-title">
                      {view === "personal"
                        ? "Votre sélection"
                        : view === "saved"
                          ? "Vos sauvegardes"
                          : view === "folders"
                            ? selectedFolder?.name
                            : view === "evaluation"
                              ? evaluationFilters.find(
                                  (filter) => filter.id === evaluationFilter,
                                )?.label
                              : "Toutes les publications"}
                    </h2>
                    <span className="count-badge">{articles.length}</span>
                  </div>
                  <span className="section-meta">
                    {view === "folders"
                      ? selectedFolder?.archived
                        ? "Dossier archivé"
                        : "Publications classées dans ce dossier"
                      : "Publications des sources suivies"}
                  </span>
                </div>
                <div className="filter-panel">
                  <div className="search-field">
                    <Search size={18} />
                    <label className="sr-only" htmlFor="article-search">
                      Rechercher dans les publications
                    </label>
                    <input
                      id="article-search"
                      type="search"
                      placeholder="Rechercher un sujet, un titre, une source…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  <div className="filters">
                    <ListFilter
                      size={17}
                      className="filters-icon"
                      aria-hidden="true"
                    />
                    <Filter
                      id="filter-source"
                      label="Source"
                      value={sourceFilter}
                      onChange={setSourceFilter}
                      options={data.sources.map((source) => ({
                        value: source.id,
                        label: source.name,
                      }))}
                      all="Toutes les sources"
                    />
                    <Filter
                      id="filter-language"
                      label="Langue"
                      value={languageFilter}
                      onChange={setLanguageFilter}
                      options={languages.map((language) => ({
                        value: language,
                        label: languageLabel(language),
                      }))}
                      all="Toutes les langues"
                    />
                    <Filter
                      id="filter-theme"
                      label="Thème"
                      value={themeFilter}
                      onChange={setThemeFilter}
                      options={themes.map((theme) => ({
                        value: theme,
                        label: theme,
                      }))}
                      all="Tous les thèmes"
                    />
                    <Filter
                      id="filter-format"
                      label="Format"
                      value={formatFilter}
                      onChange={setFormatFilter}
                      options={[
                        { value: "article", label: "Articles" },
                        { value: "video", label: "Vidéos" },
                      ]}
                      all="Tous les formats"
                    />
                    {hasFilters && (
                      <button
                        type="button"
                        className="reset-filters"
                        onClick={resetFilters}
                      >
                        <X size={13} /> Effacer
                      </button>
                    )}
                  </div>
                </div>
                {view !== "evaluation" && (
                  <section
                    className="activity-controls"
                    aria-label="Nouveautés de la veille"
                  >
                    <div className="activity-heading">
                      <div>
                        <h3>Votre point de veille</h3>
                        <p className="activity-context">
                          {data.activity.lastReviewedAt
                            ? "Dernière validation : "
                            : "Suivi des nouveautés depuis le "}
                          <time
                            dateTime={
                              data.activity.lastReviewedAt ??
                              data.activity.startedAt
                            }
                          >
                            {dateLabel(
                              data.activity.lastReviewedAt ??
                                data.activity.startedAt,
                              true,
                            )}
                          </time>
                        </p>
                      </div>
                      <button
                        type="button"
                        className="button button-secondary activity-review"
                        disabled={busy || activityBatch.length === 0}
                        onClick={() =>
                          void mutate({
                            action: "acknowledgeChanges",
                            articles: activityBatch,
                          })
                        }
                      >
                        {pending === "acknowledgeChanges" ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <CheckCheck size={16} />
                        )}
                        <span>
                          Valider les nouveautés affichées (
                          {activityBatch.length})
                        </span>
                      </button>
                    </div>
                    <div
                      className="activity-tabs"
                      role="group"
                      aria-label="Filtrer par nouveauté"
                    >
                      {activityFilters.map(({ id, label }) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={activityFilter === id}
                          className={`activity-tab ${activityFilter === id ? "is-selected" : ""}`}
                          onClick={() => setActivityFilter(id)}
                        >
                          {label}
                          <span>{activityCounts[id]}</span>
                        </button>
                      ))}
                    </div>
                    <p className="activity-help">
                      Validez les publications de cette vue sans les marquer
                      comme lues.
                      {activityFilter !== "all" &&
                        " Les dernières collectes ou modifications apparaissent en premier."}
                    </p>
                    <details className="activity-explanation">
                      <summary>Comprendre les repères</summary>
                      <p className="activity-help">
                        « Nouvelle » signale une première collecte, même pour
                        une publication ancienne. « Actualisée » signale une
                        modification des données collectées. Ces repères restent
                        présents jusqu’à validation, indépendamment de l’état
                        lu.
                      </p>
                      <p className="activity-help">
                        Les compteurs suivent vos filtres. Valider retire les
                        repères des publications affichées, y compris dans les
                        regroupements. Les publications masquées par vos filtres
                        conservent leurs repères.
                      </p>
                    </details>
                    {visibleChanges > MAX_ACTIVITY_BATCH && (
                      <p className="activity-limit" role="status">
                        Les {MAX_ACTIVITY_BATCH} premières nouveautés de cette
                        vue seront validées. Les{" "}
                        {visibleChanges - MAX_ACTIVITY_BATCH} suivantes
                        conserveront leur repère.
                      </p>
                    )}
                  </section>
                )}
                <div className="feed-display-controls">
                  {view !== "evaluation" && (
                    <label className="grouping-toggle">
                      <input
                        type="checkbox"
                        checked={groupStories}
                        onChange={(event) =>
                          setGroupStories(event.target.checked)
                        }
                      />
                      Regrouper les annonces similaires
                    </label>
                  )}
                  <p className="feed-count" role="status">
                    {articles.length} publication
                    {articles.length > 1 ? "s" : ""}
                    {groupedCount > 0 && (
                      <>
                        {" "}
                        · {feedItems.length} fiche
                        {feedItems.length > 1 ? "s" : ""} affichée
                        {feedItems.length > 1 ? "s" : ""}, dont {groupedCount}{" "}
                        regroupement{groupedCount > 1 ? "s" : ""}
                      </>
                    )}
                  </p>
                </div>
                <div className="article-list" aria-busy={busy}>
                  {feedItems.map((item) => {
                    const onAction = (action: MonitorAction) =>
                      void mutate(
                        action,
                        "id" in action
                          ? `${action.action}-${action.id}`
                          : action.action,
                      );
                    return item.group ? (
                      <StoryCard
                        key={item.id}
                        articles={item.articles}
                        group={item.group}
                        matchScope={data.profile.matchScope}
                        relatedByArticle={relatedByArticle}
                        folders={data.folders}
                        onOpenFolders={openFolder}
                        busy={busy}
                        onAction={onAction}
                      />
                    ) : (
                      <ArticleCard
                        key={item.id}
                        article={item.articles[0]}
                        matchScope={data.profile.matchScope}
                        related={relatedByArticle.get(item.articles[0].id)}
                        folders={data.folders}
                        onOpenFolders={openFolder}
                        busy={busy}
                        onAction={onAction}
                      />
                    );
                  })}
                  {articles.length === 0 && (
                    <div className="empty-state">
                      <span className="empty-icon">
                        {view === "folders" ? (
                          <FolderOpen size={26} />
                        ) : view === "saved" ? (
                          <Bookmark size={26} />
                        ) : (
                          <Radio size={26} />
                        )}
                      </span>
                      <h3>
                        {hasFilters
                          ? "Aucune publication ne correspond."
                          : view === "evaluation"
                            ? "Aucune publication dans cette catégorie."
                            : view === "folders"
                              ? "Ce dossier est encore vide."
                              : view === "saved"
                                ? "Votre bibliothèque commence ici."
                                : data.articles.length === 0
                                  ? "Prêt pour votre première collecte."
                                  : "Votre sélection est encore vide."}
                      </h3>
                      <p>
                        {hasFilters
                          ? "Essayez un autre mot-clé ou élargissez vos filtres."
                          : view === "evaluation"
                            ? "Évaluez les publications du flux pour comparer vos retours aux règles de sélection."
                            : view === "folders"
                              ? selectedFolder?.archived
                                ? "Restaurez ce dossier pour y classer des publications."
                                : "Depuis le flux, utilisez « Classer » pour ajouter des publications à ce dossier."
                              : view === "saved"
                                ? "Sauvegardez une publication depuis le flux pour la retrouver ici."
                                : data.articles.length === 0
                                  ? "Actualisez les sources pour récupérer les publications disponibles."
                                  : "Explorez tout le flux ou ajustez les critères de votre profil."}
                      </p>
                      {hasFilters ? (
                        <button
                          className="button button-secondary"
                          onClick={resetFilters}
                        >
                          Réinitialiser les filtres
                        </button>
                      ) : view === "saved" ||
                        view === "folders" ||
                        view === "evaluation" ||
                        (view === "personal" && data.articles.length > 0) ? (
                        <button
                          className="button button-secondary"
                          onClick={() => changeView("all")}
                        >
                          Explorer tout le flux <ArrowRight size={16} />
                        </button>
                      ) : (
                        <button
                          className="button button-secondary"
                          disabled={busy || data.collection.running}
                          onClick={() =>
                            void mutate({ action: "collect" }, "collect")
                          }
                        >
                          <RefreshCw size={16} /> Lancer une collecte
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <p className="feed-footnote">
                  Les titres et extraits sont ceux des sources. Consultez la
                  publication originale pour lire le contenu complet.
                </p>
              </section>
            </>
          )}

          {view === "sources" && (
            <>
              <CollectionSchedule
                collection={data.collection}
                busy={busy}
                onAction={(action) => void mutate(action)}
              />
              <div className="sources-layout">
                <section aria-labelledby="sources-title">
                  <div className="section-heading">
                    <div className="section-title">
                      <h2 id="sources-title">Sources suivies</h2>
                      <span className="count-badge">{data.sources.length}</span>
                    </div>
                  </div>
                  <div className="source-list">
                    {data.sources.map((source) => (
                      <article className="source-card" key={source.id}>
                        <div className="source-card-top">
                          <span className="source-icon">
                            {source.collectionKind === "website" ? (
                              <Globe2 size={20} />
                            ) : (
                              <Rss size={20} />
                            )}
                          </span>
                          <div className="source-title">
                            <h3>{source.name}</h3>
                            <a
                              href={source.siteUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Consulter le site <ArrowUpRight size={12} />
                            </a>
                          </div>
                          <div className="source-controls">
                            <button
                              type="button"
                              className="source-edit"
                              disabled={busy}
                              aria-label={`Modifier ${source.name}`}
                              aria-pressed={editingSourceId === source.id}
                              onClick={() => editSource(source)}
                            >
                              <Pencil size={13} /> Modifier
                            </button>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={source.enabled}
                              aria-label={`${source.enabled ? "Désactiver" : "Activer"} ${source.name}`}
                              className={`switch ${source.enabled ? "switch-on" : ""}`}
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  {
                                    action: "toggleSource",
                                    id: source.id,
                                    enabled: !source.enabled,
                                  },
                                  `source-${source.id}`,
                                )
                              }
                            >
                              <span />
                            </button>
                          </div>
                        </div>
                        <div className="source-details">
                          <span className="source-kind">
                            {source.collectionKind === "rss"
                              ? "RSS/Atom"
                              : source.collectionKind === "website"
                                ? "Page publique"
                                : "Connecteur indisponible"}
                          </span>
                          <span
                            className={`source-status status-${source.status}`}
                          >
                            <span />
                            {statusLabels[source.status]}
                          </span>
                          <span>{languageLabel(source.language)}</span>
                          <span>
                            {source.articleCount} publication
                            {source.articleCount > 1 ? "s" : ""}
                          </span>
                          <span className="source-enabled">
                            {source.enabled ? "Active" : "Désactivée"}
                          </span>
                        </div>
                        {source.lastError && (
                          <p className="source-error">
                            <CircleAlert size={15} />
                            <span>{source.lastError}</span>
                          </p>
                        )}
                        <dl className="source-dates">
                          <div>
                            <dt>Dernière tentative</dt>
                            <dd>
                              {source.lastCheckedAt
                                ? dateLabel(source.lastCheckedAt, true)
                                : "Pas encore collectée"}
                            </dd>
                          </div>
                          <div>
                            <dt>Dernier succès</dt>
                            <dd>
                              {source.lastSuccessAt
                                ? dateLabel(source.lastSuccessAt, true)
                                : "Aucun"}
                            </dd>
                          </div>
                        </dl>
                        {source.collectionUrl && (
                          <a
                            className="feed-url"
                            href={source.collectionUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {source.collectionKind === "website" ? (
                              <Globe2 size={12} />
                            ) : (
                              <Rss size={12} />
                            )}
                            <span>{source.collectionUrl}</span>
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </article>
                    ))}
                    {data.sources.length === 0 && (
                      <div className="empty-state">
                        <Rss size={28} />
                        <h3>Ajoutez votre première source.</h3>
                        <p>
                          Renseignez son site. Pour Brave1 et Defender Media, la
                          page publique est reconnue automatiquement. Un flux
                          RSS/Atom peut être fourni pour les autres sources.
                        </p>
                      </div>
                    )}
                  </div>
                </section>
                <section
                  className="panel source-form-panel"
                  aria-labelledby="add-source-title"
                >
                  <div className="panel-heading">
                    <span className="panel-icon">
                      <Rss size={19} />
                    </span>
                    <h2 id="add-source-title">
                      {editingSourceId
                        ? "Modifier la source"
                        : "Ajouter une source"}
                    </h2>
                  </div>
                  <p className="muted">
                    {editingSourceId
                      ? "Mettez à jour ses paramètres. Son état d’activation est conservé."
                      : "Ajoutez un site ou un flux à votre veille."}
                  </p>
                  <form onSubmit={addSource} className="stacked-form">
                    <label htmlFor="source-name">
                      Nom de la source <span className="required-mark">*</span>
                    </label>
                    <input
                      id="source-name"
                      ref={sourceNameInput}
                      value={sourceName}
                      onChange={(event) => setSourceName(event.target.value)}
                      placeholder="Nom de la publication"
                      required
                      maxLength={120}
                    />
                    <label htmlFor="source-site">
                      Site web <span className="required-mark">*</span>
                    </label>
                    <input
                      id="source-site"
                      type="url"
                      value={siteUrl}
                      readOnly={editingSourceId !== null}
                      aria-describedby={
                        editingSourceId ? "source-site-help" : undefined
                      }
                      onChange={(event) => setSiteUrl(event.target.value)}
                      placeholder="https://…"
                      required
                    />
                    {editingSourceId && (
                      <p id="source-site-help" className="field-help">
                        L’adresse du site identifie cette source et ne peut pas
                        être modifiée ici.
                      </p>
                    )}
                    <label htmlFor="source-feed">
                      Flux RSS/Atom{" "}
                      <span className="optional-label">facultatif</span>
                    </label>
                    <input
                      id="source-feed"
                      type="url"
                      value={feedUrl}
                      onChange={(event) => setFeedUrl(event.target.value)}
                      placeholder="https://…/feed"
                    />
                    <p className="field-help">
                      Sans flux, Brave1 et Defender Media utilisent leur page
                      anglaise de publications. Pour les autres sites, une
                      détection de flux RSS/Atom sera tentée.
                    </p>
                    <label htmlFor="source-language">
                      Langue <span className="optional-label">facultatif</span>
                    </label>
                    <select
                      id="source-language"
                      value={sourceLanguage}
                      onChange={(event) =>
                        setSourceLanguage(event.target.value)
                      }
                    >
                      <option value="">Non précisée</option>
                      <option value="fr">Français</option>
                      <option value="en">Anglais</option>
                      <option value="uk">Ukrainien</option>
                      <option value="de">Allemand</option>
                      <option value="es">Espagnol</option>
                      {sourceLanguage &&
                        !["fr", "en", "uk", "de", "es"].includes(
                          sourceLanguage,
                        ) && (
                          <option value={sourceLanguage}>
                            {languageLabel(sourceLanguage)}
                          </option>
                        )}
                    </select>
                    <button
                      type="submit"
                      className="button button-primary"
                      disabled={busy}
                    >
                      {pending === "addSource" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <ArrowRight size={16} />
                      )}{" "}
                      {editingSourceId
                        ? "Enregistrer les modifications"
                        : "Ajouter à ma veille"}
                    </button>
                    {editingSourceId && (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy}
                        onClick={resetSourceForm}
                      >
                        Annuler
                      </button>
                    )}
                  </form>
                </section>
              </div>
            </>
          )}

          {view === "profile" && (
            <div className="profile-layout">
              <section className="panel" aria-labelledby="profile-title">
                <div className="panel-heading">
                  <span className="panel-icon">
                    <Settings2 size={19} />
                  </span>
                  <h2 id="profile-title">Critères de sélection</h2>
                </div>
                <form
                  onSubmit={saveProfile}
                  className="stacked-form profile-form"
                >
                  <label htmlFor="profile-keywords">
                    Sujets et mots-clés à suivre
                  </label>
                  <textarea
                    id="profile-keywords"
                    rows={4}
                    value={keywords}
                    onChange={(event) => {
                      invalidatePreview();
                      setKeywords(event.target.value);
                    }}
                    placeholder="Séparez vos mots-clés par des virgules"
                    aria-describedby="keywords-help"
                  />
                  <p id="keywords-help" className="field-help">
                    Séparez les termes par des virgules. Pensez aux termes
                    anglais pour les sources internationales.
                  </p>
                  <label htmlFor="profile-exclusions">
                    Mots-clés à exclure
                  </label>
                  <textarea
                    id="profile-exclusions"
                    rows={3}
                    value={excludeKeywords}
                    onChange={(event) => {
                      invalidatePreview();
                      setExcludeKeywords(event.target.value);
                    }}
                    placeholder="Termes à écarter, séparés par des virgules"
                  />
                  <p className="field-help">
                    Un de ces mots-clés suffit à écarter une publication, sauf
                    si vous la signalez « Pertinent ».
                  </p>
                  <label htmlFor="profile-scope">
                    Texte utilisé pour la sélection
                  </label>
                  <select
                    id="profile-scope"
                    value={matchScope}
                    onChange={(event) => {
                      invalidatePreview();
                      setMatchScope(
                        event.target.value as NonNullable<
                          Profile["matchScope"]
                        >,
                      );
                    }}
                    aria-describedby="scope-help"
                  >
                    <option value="all_text">Tout le texte collecté</option>
                    <option value="title_excerpt">
                      Titre et extrait disponible
                    </option>
                  </select>
                  <p id="scope-help" className="field-help">
                    Le texte collecté peut contenir des mentions secondaires. Le
                    mode titre et extrait se limite au titre et aux 480 premiers
                    caractères disponibles ; sans extrait, seul le titre est
                    utilisé. Ce choix s’applique aussi aux thèmes attribués.
                  </p>
                  <div className="threshold-row">
                    <div>
                      <label htmlFor="profile-score">
                        Correspondances minimales
                      </label>
                      <p className="field-help">
                        Nombre de mots-clés différents requis pour entrer dans
                        la sélection.
                      </p>
                    </div>
                    <div className="number-field">
                      <input
                        id="profile-score"
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        value={minScore}
                        onChange={(event) => {
                          invalidatePreview();
                          setMinScore(event.target.value);
                        }}
                        required
                      />
                      <span>mot(s)-clé(s)</span>
                    </div>
                  </div>
                  <div className="form-footer profile-form-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={(event) => {
                        if (event.currentTarget.form?.reportValidity())
                          void previewProfile();
                      }}
                    >
                      {pending === "previewProfile" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Eye size={16} />
                      )}
                      Prévisualiser les changements
                    </button>
                    <button
                      type="submit"
                      className="button button-primary"
                      disabled={busy}
                    >
                      {pending === "updateProfile" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Check size={16} />
                      )}{" "}
                      Enregistrer mon profil
                    </button>
                  </div>
                </form>
                {preview && (
                  <ProfilePreviewPanel
                    preview={preview}
                    currentEvaluation={data.evaluation}
                  />
                )}
              </section>
              <div className="profile-aside">
                <section
                  className="panel evaluation-panel"
                  aria-labelledby="evaluation-title"
                >
                  <div className="panel-heading">
                    <span className="panel-icon">
                      <CheckCheck size={19} />
                    </span>
                    <h2 id="evaluation-title">Évaluer la sélection</h2>
                  </div>
                  <p className="muted">
                    Comparez les règles enregistrées à vos retours, avant vos
                    corrections manuelles. Ces mesures portent uniquement sur
                    vos publications évaluées.
                  </p>
                  <dl className="evaluation-stats">
                    <div>
                      <dt>
                        Publications évaluées
                        <small>Pertinent ou Hors sujet</small>
                      </dt>
                      <dd>{data.evaluation.reviewed}</dd>
                    </div>
                    <div>
                      <dt>
                        <button
                          type="button"
                          className="evaluation-link"
                          onClick={() => openEvaluation("missed")}
                        >
                          Pertinentes manquées par les règles{" "}
                          <ArrowRight size={14} />
                        </button>
                        <small>
                          {data.evaluation.matchedRelevant} retenues sur{" "}
                          {data.evaluation.relevant} pertinentes
                        </small>
                      </dt>
                      <dd>{data.evaluation.missedRelevant}</dd>
                    </div>
                    <div>
                      <dt>
                        <button
                          type="button"
                          className="evaluation-link"
                          onClick={() => openEvaluation("off_topic")}
                        >
                          Retenues mais hors sujet <ArrowRight size={14} />
                        </button>
                        <small>
                          {data.evaluation.excludedOffTopic} écartées sur{" "}
                          {data.evaluation.offTopic} hors sujet
                        </small>
                      </dt>
                      <dd>{data.evaluation.selectedOffTopic}</dd>
                    </div>
                    <div>
                      <dt>
                        Précision des règles
                        <small>
                          Part pertinente parmi les publications retenues et
                          évaluées
                        </small>
                      </dt>
                      <dd>{percentage(data.evaluation.precision)}</dd>
                    </div>
                    <div>
                      <dt>
                        Rappel des règles
                        <small>
                          Part des publications pertinentes retrouvées
                        </small>
                      </dt>
                      <dd>{percentage(data.evaluation.recall)}</dd>
                    </div>
                  </dl>
                  {data.evaluation.reviewed === 0 && (
                    <p className="evaluation-note">
                      Signalez des publications « Pertinent » ou « Hors sujet »
                      pour commencer la comparaison. Aucune qualité de sélection
                      n’est encore mesurée.
                    </p>
                  )}
                  <p className="evaluation-note">
                    {data.evaluation.seen} retour
                    {data.evaluation.seen > 1 ? "s" : ""} « Déjà vu », exclu
                    {data.evaluation.seen > 1 ? "s" : ""} de ces mesures. Un
                    tiret indique qu’il n’y a pas assez de retours pour calculer
                    le ratio.
                  </p>
                  <button
                    type="button"
                    className="button button-secondary evaluation-start"
                    onClick={() => openEvaluation("unreviewed")}
                  >
                    Évaluer des publications <ArrowRight size={15} />
                  </button>
                  <button
                    type="button"
                    className="evaluation-link evaluation-all"
                    onClick={() => openEvaluation("reviewed")}
                  >
                    Voir tous mes retours <ArrowRight size={14} />
                  </button>
                </section>
                <section className="profile-explainer">
                  <h3>Une sélection explicable</h3>
                  <p>
                    Le score compte les mots-clés de votre profil présents dans
                    le texte choisi dans votre profil. Chaque publication
                    précise l’origine du contenu disponible : texte du flux,
                    extrait d’une page publique, ou titre uniquement. Le texte
                    des flux est limité à 20 000 caractères. Les connecteurs de
                    pages publiques consultent une seule page anglaise par
                    source et par collecte, sans ouvrir le corps des articles.
                  </p>
                  <p>
                    « Pertinent » retient la publication dans Pour moi, même
                    sous le seuil ou en présence d’une exclusion. « Hors sujet »
                    et « Déjà vu » la retirent de cette vue. Cliquez à nouveau
                    sur le retour actif pour réappliquer les règles. Les
                    publications restent accessibles dans Tout le flux.
                  </p>
                  <p>
                    Vos retours ne modifient pas automatiquement les mots-clés
                    et n’entraînent aucun modèle. Prévisualisez vos ajustements,
                    puis enregistrez-les pour les appliquer.
                  </p>
                </section>
              </div>
            </div>
          )}

          <footer className="page-footer">
            <span>DEFENSE TECH MONITOR</span>
            <span>
              Publications originales ·{" "}
              {data.collection.enabled
                ? "Collecte automatique locale"
                : "Collecte à la demande"}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function ProfilePreviewPanel({
  preview,
  currentEvaluation,
}: {
  preview: ProfilePreview;
  currentEvaluation: Snapshot["evaluation"];
}) {
  return (
    <section
      className="profile-preview"
      aria-labelledby="preview-title"
      aria-live="polite"
    >
      <div className="panel-heading">
        <Eye size={18} />
        <h2 id="preview-title">Prévisualisation non enregistrée</h2>
      </div>
      <p className="muted">
        Ces résultats utilisent les publications déjà collectées. Enregistrez
        votre profil pour appliquer les changements.
      </p>
      <dl className="preview-counts">
        <div>
          <dt>Dans Pour moi, avec vos retours</dt>
          <dd>
            {preview.currentSelected} <ArrowRight size={15} aria-label="vers" />{" "}
            {preview.selected}
          </dd>
        </div>
        <div>
          <dt>Pertinentes manquées par les règles</dt>
          <dd>
            {currentEvaluation.missedRelevant}{" "}
            <ArrowRight size={15} aria-label="vers" />{" "}
            {preview.evaluation.missedRelevant}
          </dd>
        </div>
        <div>
          <dt>Retenues mais hors sujet par les règles</dt>
          <dd>
            {currentEvaluation.selectedOffTopic}{" "}
            <ArrowRight size={15} aria-label="vers" />{" "}
            {preview.evaluation.selectedOffTopic}
          </dd>
        </div>
      </dl>
      <p className="evaluation-note">
        Avant → après. La sélection porte sur toutes les publications ; les deux
        écarts portent sur vos publications évaluées (
        {preview.evaluation.reviewed}).
        {preview.evaluation.reviewed === 0
          ? " Sans retour de pertinence, ces nombres ne permettent pas de juger les nouveaux critères."
          : " Les deux écarts comparent les règles à vos retours, avant correction manuelle."}
      </p>
      {[
        {
          label: "Publications qui entreraient dans Pour moi",
          articles: preview.entered,
          empty: "Aucune nouvelle publication retenue.",
        },
        {
          label: "Publications qui quitteraient Pour moi",
          articles: preview.exited,
          empty: "Aucune publication retirée.",
        },
      ].map(({ label, articles, empty }) => (
        <details className="preview-publications" key={label}>
          <summary>
            {label} <span className="count-badge">{articles.length}</span>
          </summary>
          {articles.length === 0 ? (
            <p className="muted">{empty}</p>
          ) : (
            <ul>
              {articles.map((article) => (
                <li key={article.id}>
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title} <ArrowUpRight size={14} />
                  </a>
                  <span>
                    {article.sourceName} · {article.score} correspondance
                    {article.score > 1 ? "s" : ""}
                  </span>
                  <p>
                    {article.reasons.length
                      ? article.reasons.join(" · ")
                      : "Aucun mot-clé du profil proposé trouvé."}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
    </section>
  );
}

function Stat({
  label,
  value,
  icon,
  highlight = false,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={`stat-card ${highlight ? "stat-highlight" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function Filter({
  id,
  label,
  value,
  onChange,
  options,
  all,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  all: string;
}) {
  return (
    <div className="filter-select">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{all}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SeparateAction({
  article,
  busy,
  onAction,
}: {
  article: Article;
  busy: boolean;
  onAction: (action: MonitorAction) => void;
}) {
  return (
    <button
      type="button"
      className="article-action separate-action"
      disabled={busy}
      onClick={() =>
        onAction({
          action: "setSeparate",
          id: article.id,
          value: !article.keepSeparate,
        })
      }
    >
      {article.keepSeparate ? <Layers3 size={15} /> : <Split size={15} />}
      {article.keepSeparate ? "Rétablir le regroupement" : "Conserver séparé"}
    </button>
  );
}

function ActivityBadge({ article }: { article: Article }) {
  if (!article.changeKind) return null;
  const label = article.changeKind === "new" ? "Nouvelle" : "Actualisée";
  const description =
    article.changeKind === "new"
      ? `Première collecte le ${dateLabel(article.collectedAt, true)}`
      : `Modification des données collectées détectée le ${dateLabel(article.updatedAt, true)}`;
  return (
    <span
      className={`activity-badge activity-badge-${article.changeKind}`}
      title={description}
      aria-label={`${label} : ${description}`}
    >
      {label}
    </span>
  );
}

function StoryCard({
  articles,
  group,
  matchScope,
  relatedByArticle,
  folders,
  onOpenFolders,
  busy,
  onAction,
}: {
  articles: Article[];
  group: StoryGroup;
  matchScope?: Profile["matchScope"];
  relatedByArticle: Map<string, RelatedPublication[]>;
  folders: Folder[];
  onOpenFolders: (id?: string) => void;
  busy: boolean;
  onAction: (action: MonitorAction) => void;
}) {
  const [lead, ...otherArticles] = articles;
  const sources = [...new Set(articles.map((article) => article.sourceName))];
  return (
    <section className="story-card" aria-label="Même annonce probable">
      <header className="story-header">
        <div className="story-label">
          <Layers3 size={16} />
          <strong>Même annonce probable</strong>
          <span>{articles.length} publications</span>
        </div>
        <p className="story-sources">{sources.join(" · ")}</p>
        <p className="story-caution">
          Ces reprises ne constituent pas des confirmations indépendantes.
        </p>
        <details className="story-explanation">
          <summary>Pourquoi ce regroupement ?</summary>
          <p>{group.reason}</p>
          <p>
            Comparaison des titres et du texte collecté dans les flux ou les
            pages de liste. Le contenu intégral des articles n’est pas
            nécessairement disponible. Vous pouvez conserver chaque publication
            séparément.
          </p>
        </details>
      </header>
      <ArticleCard
        article={lead}
        matchScope={matchScope}
        grouped
        related={relatedByArticle.get(lead.id)}
        folders={folders}
        onOpenFolders={onOpenFolders}
        busy={busy}
        onAction={onAction}
      />
      <div className="story-members">
        <p className="story-members-label">Autres publications rapprochées</p>
        {otherArticles.map((article) => (
          <div className="story-member" key={article.id}>
            <div className="article-meta">
              <span className="article-source">{article.sourceName}</span>
              <span className="meta-dot">·</span>
              <time dateTime={article.publishedAt ?? undefined}>
                {dateLabel(article.publishedAt)}
              </time>
              <span className="meta-dot">·</span>
              <span>{languageLabel(article.language)}</span>
              <ActivityBadge article={article} />
            </div>
            <h3>
              <a href={article.url} target="_blank" rel="noreferrer">
                {article.title} <ArrowUpRight size={15} />
              </a>
            </h3>
            <div className="story-member-status">
              <span>
                {article.isRead ? <Check size={13} /> : <Eye size={13} />}
                {article.isRead ? "Lu" : "Non lu"}
              </span>
              <span>
                <Bookmark
                  size={13}
                  fill={article.saved ? "currentColor" : "none"}
                />
                {article.saved ? "Sauvegardé" : "Non sauvegardé"}
              </span>
              <SeparateAction
                article={article}
                busy={busy}
                onAction={onAction}
              />
            </div>
            <ArticleFolders
              article={article}
              folders={folders}
              busy={busy}
              onAction={onAction}
              onOpenFolders={onOpenFolders}
            />
            <details className="story-member-details">
              <summary>Détails et actions pour cette publication</summary>
              <ArticleCard
                article={article}
                matchScope={matchScope}
                grouped
                related={relatedByArticle.get(article.id)}
                folders={folders}
                showFolders={false}
                onOpenFolders={onOpenFolders}
                busy={busy}
                onAction={onAction}
              />
            </details>
          </div>
        ))}
      </div>
    </section>
  );
}

function ArticleCard({
  article,
  matchScope,
  grouped = false,
  related = [],
  folders,
  showFolders = true,
  onOpenFolders,
  busy,
  onAction,
}: {
  article: Article;
  matchScope?: Profile["matchScope"];
  grouped?: boolean;
  related?: RelatedPublication[];
  folders: Folder[];
  showFolders?: boolean;
  onOpenFolders: (id?: string) => void;
  busy: boolean;
  onAction: (action: MonitorAction) => void;
}) {
  const feedbackOptions: {
    value: Feedback;
    label: string;
    icon: typeof ThumbsUp;
  }[] = [
    { value: "relevant", label: "Pertinent", icon: ThumbsUp },
    { value: "off_topic", label: "Hors sujet", icon: ThumbsDown },
    { value: "seen", label: "Déjà vu", icon: CheckCheck },
  ];
  return (
    <article className={`article-card ${article.isRead ? "article-read" : ""}`}>
      <div className="article-main">
        <div className="article-meta">
          <span className="article-source">{article.sourceName}</span>
          <span className="meta-dot">·</span>
          <time dateTime={article.publishedAt ?? undefined}>
            {dateLabel(article.publishedAt)}
          </time>
          <span className="meta-dot">·</span>
          <span>{languageLabel(article.language)}</span>
          <span className="format-tag">
            {article.format === "video" ? "Vidéo" : "Article"}
          </span>
          <ActivityBadge article={article} />
          {article.isRead && (
            <span className="read-label">
              <Check size={12} /> Lu
            </span>
          )}
        </div>
        <h3>
          <a href={article.url} target="_blank" rel="noreferrer">
            {article.title}
            <ArrowUpRight size={17} />
          </a>
        </h3>
        {article.themes.length > 0 && (
          <div className="theme-list">
            {article.themes.map((theme) => (
              <span className="theme-tag" key={theme}>
                {theme}
              </span>
            ))}
          </div>
        )}
        {article.excerpt && article.contentBasis !== "metadata" && (
          <div className="article-excerpt">
            <span>
              {article.contentBasis === "page_excerpt"
                ? "Extrait de la page"
                : "Extrait du flux"}
            </span>
            <p>
              {article.excerpt.length > 400
                ? `${article.excerpt.slice(0, 397).trimEnd()}…`
                : article.excerpt}
            </p>
          </div>
        )}
        <div className="analysis-details">
          <span>
            <span className="analysis-dot" />
            {matchScope === "title_excerpt"
              ? article.excerpt
                ? "Titre et extrait utilisés pour la sélection"
                : "Titre seul utilisé pour la sélection"
              : article.contentBasis === "feed_text"
                ? "Texte du flux analysé"
                : article.contentBasis === "page_excerpt"
                  ? "Extrait de la page analysé"
                  : "Titre seul analysé"}
          </span>
          {article.reasons.length > 0 && (
            <details>
              <summary>Pourquoi ce score ?</summary>
              <ul>
                {article.reasons.map((reason, index) => (
                  <li key={`${reason}-${index}`}>{reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {article.feedback && (
          <p className={`feedback-note feedback-note-${article.feedback}`}>
            {article.feedback === "relevant"
              ? "Retenu selon votre retour"
              : article.feedback === "off_topic"
                ? "Écarté de Pour moi : hors sujet"
                : "Écarté de Pour moi : déjà vu"}
          </p>
        )}
        {article.keepSeparate && (
          <p className="separate-note">
            Conservée séparément selon votre choix.
          </p>
        )}
        {related.length > 0 && (
          <aside className="related-publications" aria-label="Sujets proches">
            <strong>Sujet proche, différence possible</strong>
            <ul>
              {related.map(({ article: other, reason }) => (
                <li key={other.id}>
                  <a href={other.url} target="_blank" rel="noreferrer">
                    {other.title} <ArrowUpRight size={13} />
                  </a>
                  <span>
                    {other.sourceName} · {reason}
                  </span>
                </li>
              ))}
            </ul>
            <p>
              Ces publications restent séparées. Le texte disponible ne permet
              pas de confirmer qu’elles apportent la même information.
            </p>
          </aside>
        )}
      </div>
      <div
        className="article-score"
        aria-label={`Score des règles : ${article.score} mots-clés correspondants`}
      >
        <span>CORRESPONDANCES</span>
        <strong>{article.score}</strong>
        <small>
          mot{article.score > 1 ? "s" : ""}-clé{article.score > 1 ? "s" : ""}{" "}
          selon les règles
        </small>
      </div>
      {showFolders && (
        <ArticleFolders
          article={article}
          folders={folders}
          busy={busy}
          onAction={onAction}
          onOpenFolders={onOpenFolders}
        />
      )}
      <div className="article-actions">
        <div className="reading-actions">
          <button
            type="button"
            aria-pressed={article.isRead}
            className={`article-action ${article.isRead ? "is-selected" : ""}`}
            disabled={busy}
            onClick={() =>
              onAction({
                action: "setRead",
                id: article.id,
                value: !article.isRead,
              })
            }
          >
            {article.isRead ? <Check size={15} /> : <Eye size={15} />}
            {article.isRead ? "Lu" : "Marquer comme lu"}
          </button>
          <button
            type="button"
            aria-pressed={article.saved}
            className={`article-action ${article.saved ? "is-selected" : ""}`}
            disabled={busy}
            onClick={() =>
              onAction({
                action: "setSaved",
                id: article.id,
                value: !article.saved,
              })
            }
          >
            <Bookmark
              size={15}
              fill={article.saved ? "currentColor" : "none"}
            />
            {article.saved ? "Sauvegardé" : "Sauvegarder"}
          </button>
        </div>
        <div
          className="feedback-actions"
          aria-label="Évaluer cette publication"
        >
          {feedbackOptions.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={article.feedback === value}
              title={
                article.feedback === value
                  ? "Retirer ce retour et réappliquer les règles"
                  : value === "relevant"
                    ? "Retenir cette publication dans Pour moi"
                    : "Retirer cette publication de Pour moi"
              }
              className={`article-action feedback-action ${article.feedback === value ? "is-selected" : ""}`}
              disabled={busy}
              onClick={() =>
                onAction({
                  action: "setFeedback",
                  id: article.id,
                  value: article.feedback === value ? null : value,
                })
              }
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        {(grouped || article.keepSeparate) && (
          <SeparateAction article={article} busy={busy} onAction={onAction} />
        )}
        <a
          className="original-link"
          href={article.url}
          target="_blank"
          rel="noreferrer"
        >
          Lire la source <ArrowUpRight size={14} />
        </a>
      </div>
    </article>
  );
}
