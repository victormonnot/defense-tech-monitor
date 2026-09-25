export type FeedSort = "relevance" | "date";

export interface FeedInput {
  name: string;
  instructions: string;
  exclusions: string;
  minScore: number;
  minConfidence: number;
  sort: FeedSort;
  enabled: boolean;
}

export interface CustomFeed extends FeedInput {
  id: string;
  isGeneral: boolean;
  archived: boolean;
  revision: number;
  analysis: { ready: number; pending: number; failed: number };
}

export const GENERAL_FEED_ID = "general";

// Starting settings for personal adjustment, not calibrated model thresholds.
const defaults = {
  minScore: 1.5,
  minConfidence: 0.6,
  sort: "relevance" as const,
  enabled: true,
};

export const GENERAL_FEED: FeedInput = {
  ...defaults,
  name: "Général",
  instructions:
    "Suivre les évolutions des technologies de défense : drones, autonomie, robotique, perception, navigation et IA embarquée. Inclure la recherche, les nouveaux produits, l'industrialisation, les entreprises et les retours d'ingénieurs ou d'utilisateurs sur le terrain. Une évolution industrielle ou un besoin concret peut être pertinent même sans détails techniques. Privilégier ce qui aide à comprendre les capacités, les limites et les usages réels.",
  exclusions:
    "Actualité générale de la guerre, politique ou bilan quotidien des combats sans lien substantiel avec les technologies, leur industrie, leur recherche ou leurs usages.",
};

export const FEED_PRESETS: Array<{ id: string } & FeedInput> = [
  {
    ...defaults,
    id: "drones",
    name: "Drones",
    instructions:
      "Suivre les drones aériens, terrestres et maritimes, leur autonomie, la coordination d'essaims, la perception et la navigation. Inclure les nouveaux systèmes, la recherche, les limites techniques, les retours d'utilisation, la production et les entreprises spécialisées. Une publication directement consacrée à ces sujets peut être pertinente sans explication technique détaillée.",
    exclusions:
      "Mentions anecdotiques d'un drone dans un récit général de combat sans information sur le système, son usage, ses limites ou sa production.",
  },
  {
    ...defaults,
    id: "ukraine",
    name: "Ukraine news",
    instructions:
      "Suivre les évolutions importantes liées à l'Ukraine : situation du conflit, décisions politiques et diplomatiques, aide internationale, économie et industrie de défense. Retenir les nouvelles informations qui aident à comprendre ce qui change, même sans contenu technique. Les annonces doivent rester attribuées à leur source.",
    exclusions:
      "Actualité sans rapport substantiel avec l'Ukraine, simples mentions de contexte ou opinions générales sans évolution identifiable.",
  },
  {
    ...defaults,
    id: "startups",
    name: "Startups",
    instructions:
      "Suivre les startups et entreprises qui développent des technologies de défense, de robotique ou de systèmes autonomes. Inclure créations d'entreprises, produits, levées de fonds, contrats, partenariats, fondateurs, industrialisation et besoins clients. Une annonce commerciale ou financière peut être centrale pour ce fil sans détails d'ingénierie.",
    exclusions:
      "Actualité générale des startups sans lien avec ces secteurs, mentions anecdotiques d'entreprise et publicité sans information sur une évolution de produit ou d'activité.",
  },
];

function textField(
  value: unknown,
  label: string,
  min: number,
  max: number,
  multiline: boolean,
): string {
  if (typeof value !== "string") throw new Error(`${label} invalide.`);
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
    : /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
  if (controls.test(value))
    throw new Error(`${label} contient des caractères de contrôle interdits.`);
  const text = value.normalize("NFC").trim();
  if (text.length < min || text.length > max)
    throw new Error(
      `${label} doit contenir entre ${min} et ${max} caractères.`,
    );
  return text;
}

function threshold(value: unknown, max: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    throw new Error(`${label} doit être un nombre compris entre 0 et ${max}.`);
  return value;
}

/** Validate editable fields without accepting persistence metadata from a caller. */
export function parseFeedInput(value: unknown): FeedInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Fil de veille invalide.");
  const feed = value as Record<string, unknown>;
  if (feed.sort !== "relevance" && feed.sort !== "date")
    throw new Error("Ordre du fil de veille invalide.");
  if (typeof feed.enabled !== "boolean")
    throw new Error("État du fil de veille invalide.");
  return {
    name: textField(feed.name, "Le nom", 1, 80, false),
    instructions: textField(feed.instructions, "La consigne", 1, 4000, true),
    exclusions: textField(feed.exclusions, "Les exclusions", 0, 2000, true),
    minScore: threshold(feed.minScore, 3, "Le seuil de pertinence"),
    minConfidence: threshold(feed.minConfidence, 1, "Le seuil de confiance"),
    sort: feed.sort,
    enabled: feed.enabled,
  };
}
