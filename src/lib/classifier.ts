import type { Profile } from "./types";

export const defaultProfile: Profile = {
  keywords: [
    "drone",
    "UAV",
    "FPV",
    "autonomy",
    "autonomous",
    "autonomie",
    "swarm",
    "essaim",
    "robot",
    "robotics",
    "robotique",
    "perception",
    "navigation",
    "embedded AI",
    "industrialisation",
    "manufacturing",
    "дрони",
    "БПЛА",
    "робот",
  ],
  excludeKeywords: [],
  minScore: 1,
};

const topics: Record<string, string[]> = {
  Drones: ["drone", "UAV", "FPV", "БПЛА", "дрони", "безпілотник"],
  Autonomie: ["autonomy", "autonomous", "autonomie", "автономний"],
  Essaims: ["swarm", "essaim", "рій"],
  Robotique: ["robot", "robotics", "robotique", "UGV", "робот"],
  "Perception & navigation": [
    "perception",
    "navigation",
    "GNSS",
    "GPS",
    "computer vision",
    "SLAM",
    "навігація",
  ],
  "IA embarquée": [
    "embedded AI",
    "edge AI",
    "machine learning",
    "штучний інтелект",
  ],
  Industrie: [
    "manufacturing",
    "industrialisation",
    "production",
    "startup",
    "funding",
    "виробництво",
  ],
};

function normalize(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function containsTerm(text: string, term: string) {
  const normalized = normalize(term.trim());
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}${/^[a-z]{3,}$/.test(normalized) ? "s?" : ""}(?=$|[^\\p{L}\\p{N}])`,
    "u",
  ).test(normalize(text));
}

export interface Classification {
  score: number;
  themes: string[];
  reasons: string[];
}

export interface Classifier {
  id: string;
  classify(text: string, profile: Profile): Classification;
}

export const rulesClassifier: Classifier = {
  id: "keywords-v1",
  classify(text, profile) {
    const matches = profile.keywords.filter((term) => containsTerm(text, term));
    const exclusions = profile.excludeKeywords.filter((term) =>
      containsTerm(text, term),
    );
    return {
      score: exclusions.length ? 0 : matches.length,
      themes: Object.entries(topics)
        .filter(([, terms]) => terms.some((term) => containsTerm(text, term)))
        .map(([name]) => name),
      reasons: exclusions.length
        ? exclusions.map((term) => `Exclusion : ${term}`)
        : matches.length
          ? matches.map((term) => `Mot-clé : ${term}`)
          : ["Aucun mot-clé du profil"],
    };
  },
};
