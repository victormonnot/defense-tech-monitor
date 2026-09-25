import type { Profile } from "./types";

function terms(input: unknown) {
  if (!Array.isArray(input) || input.length > 100)
    throw new Error("Maximum 100 mots-clés.");
  return [
    ...new Set(
      input.map((term) => {
        if (typeof term !== "string" || !term.trim() || term.length > 100)
          throw new Error("Mot-clé invalide.");
        return term.trim();
      }),
    ),
  ];
}

/** Shared validation for saved profiles and non-persistent previews. */
export function parseProfile(input: unknown): Profile {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Profil invalide.");
  const profile = input as Record<string, unknown>;
  if (
    !Number.isInteger(profile.minScore) ||
    Number(profile.minScore) < 1 ||
    Number(profile.minScore) > 20
  )
    throw new Error("Le seuil doit être compris entre 1 et 20 mots-clés.");
  if (
    profile.matchScope !== undefined &&
    profile.matchScope !== "all_text" &&
    profile.matchScope !== "title_excerpt"
  )
    throw new Error("Périmètre de sélection invalide.");
  return {
    keywords: terms(profile.keywords),
    excludeKeywords: terms(profile.excludeKeywords),
    minScore: Number(profile.minScore),
    ...(profile.matchScope === undefined
      ? {}
      : { matchScope: profile.matchScope }),
  };
}

export function classificationText(
  article: { title: string; text: string; excerpt: string | null },
  profile: Profile,
) {
  return `${article.title}\n${profile.matchScope === "title_excerpt" ? (article.excerpt ?? "") : article.text}`;
}
