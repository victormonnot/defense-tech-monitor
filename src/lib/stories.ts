import type { Article } from "./types";

export type StoryArticle = Article & { comparisonText?: string };

export interface StoryGroup {
  id: string;
  articleIds: string[];
  reason: string;
}

export interface StoryRelation {
  articleIds: [string, string];
  reason: string;
}

const WEEK = 7 * 24 * 60 * 60 * 1_000;
const STOP_WORDS = new Set(
  "a an and are as at be been being by for from has have in into is it its of on or that the their this to was were will with un une des du de la le les et en au aux pour par sur dans est sont son sa ses".split(
    " ",
  ),
);
// These words describe the subject area, but cannot identify an announcement.
const GENERIC_WORDS = new Set(
  "ukraine ukrainian russia russian military defence defense tech technology technologies drone drones system systems company companies new latest news update updates announces announce announced unveils unveil unveiled launches launch launched develops develop developed development first next army armed forces air ground combat war warfare weapon weapons production industry startup startups robot robots ugv ugvs unmanned autonomous".split(
    " ",
  ),
);
const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  first: "1st",
  second: "2nd",
  third: "3rd",
  premier: "1st",
  premiere: "1st",
  deux: "2",
  trois: "3",
  quatre: "4",
  cinq: "5",
};
const QUANTITY_UNITS = new Set(
  "thousand million billion trillion milliard millions billions milliards km m kg ton tons tonnes percent usd eur gbp uah dollars euros hours hour jours jour day days".split(
    " ",
  ),
);
const EVENT_STAGES = [
  /\b(?:announc\w*|unveil\w*|launch\w*|reveal\w*|annonce\w*|devoil\w*)\b/,
  /\b(?:test\w*|trial\w*|essai\w*)\b/,
  /\b(?:deliver\w*|receiv\w*|livr\w*|recoit)\b/,
  /\b(?:deploy\w*|deploi\w*|deploie\w*)\b/,
  /\b(?:order\w*|purchas\w*|contract\w*|command\w*|achat\w*)\b/,
  /\b(?:upgrad\w*|updat\w*|modernis\w*|moderniz\w*|ameliore\w*)\b/,
];
const DEVELOPMENTS =
  /\b(?:update[ds]?|correction|corrected|revised|follow up|new details|new evidence|additional|further|subsequent|meanwhile|however|but|after|delay\w*|cancel\w*|denie[ds]|denial|not|never|fails?|failed|failure|debunk\w*|false|mise a jour|nouveaux details|nouvelles informations|rectificatif|annul\w*|retard\w*|dement\w*|echec|mais|apres)\b/;

type Prepared = {
  article: StoryArticle;
  orderedTitle: string;
  orderedText: string;
  tokens: Set<string>;
  anchors: Set<string>;
  numbers: Set<string>;
  excerptNumbers: Set<string>;
  units: Set<string>;
  stages: Set<string>;
  development: boolean;
  date: number | null;
  language: string | null;
};
type Match = { merge: boolean; reason: string };

function normalize(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/[$]/g, " usd ")
    .replace(/€/g, " eur ")
    .replace(/£/g, " gbp ")
    .replace(/%/g, " percent ")
    .replace(/[’']/g, "")
    .replace(/[−–—]/g, "-");
}

function words(text: string) {
  return normalize(text).match(/[+-]?\d+(?:[.,]\d+)?|[\p{L}\p{N}]+/gu) ?? [];
}

function significantWords(text: string) {
  return new Set(words(text).filter((word) => !STOP_WORDS.has(word)));
}

function numericFacts(text: string) {
  const tokens = words(text);
  return new Set(
    tokens.flatMap((word, index) => {
      if (!/\d/.test(word) && !NUMBER_WORDS[word]) return [];
      // Bind a quantity to its following word: swapping quantities between
      // products must not look like the same set of numbers.
      return [`${NUMBER_WORDS[word] ?? word}:${tokens[index + 1] ?? ""}`];
    }),
  );
}

function sameSet(a: Set<string>, b: Set<string>) {
  return a.size === b.size && [...a].every((word) => b.has(word));
}

function overlap(a: Set<string>, b: Set<string>) {
  const shared = [...a].filter((word) => b.has(word)).length;
  return { shared, ratio: shared / Math.max(a.size, b.size, 1) };
}

function publishedTime(value: string | null) {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    return null;
  const day = value.slice(0, 10);
  const parsedDay = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(parsedDay) ||
    new Date(parsedDay).toISOString().slice(0, 10) !== day
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function prepare(article: StoryArticle): Prepared {
  const title = normalize(article.title);
  const tokens = significantWords(title);
  const language = article.language.trim().toLowerCase().split(/[-_]/)[0];
  const excerpt = article.comparisonText ?? article.excerpt ?? "";
  return {
    article,
    orderedTitle: words(title).join(" "),
    orderedText: words(excerpt).join(" "),
    tokens,
    anchors: new Set(
      [...tokens].filter(
        (word) =>
          !GENERIC_WORDS.has(word) &&
          !/\d/.test(word) &&
          !NUMBER_WORDS[word] &&
          word.length > 2,
      ),
    ),
    numbers: numericFacts(title),
    excerptNumbers: numericFacts(excerpt),
    units: new Set(words(title).filter((word) => QUANTITY_UNITS.has(word))),
    stages: new Set(
      EVENT_STAGES.flatMap((pattern, index) =>
        pattern.test(title) ? [String(index)] : [],
      ),
    ),
    development: DEVELOPMENTS.test(
      [...words(title), ...words(excerpt)].join(" "),
    ),
    date: publishedTime(article.publishedAt),
    language:
      /^[a-z]{2}$/.test(language) && !["xx", "zz"].includes(language)
        ? language
        : null,
  };
}

function compare(a: Prepared, b: Prepared): Match | null {
  if (
    a.article.sourceId === b.article.sourceId ||
    !a.language ||
    a.language !== b.language ||
    a.date === null ||
    b.date === null ||
    Math.abs(a.date - b.date) > WEEK
  )
    return null;

  const titleOverlap = overlap(a.tokens, b.tokens);
  if (
    titleOverlap.shared < 4 ||
    titleOverlap.ratio < 0.65 ||
    overlap(a.anchors, b.anchors).shared < 2
  )
    return null;

  if (
    !sameSet(a.numbers, b.numbers) ||
    !sameSet(a.excerptNumbers, b.excerptNumbers) ||
    !sameSet(a.units, b.units)
  )
    return {
      merge: false,
      reason:
        "Titres proches, mais chiffres ou unités différents : information à comparer.",
    };
  if (a.development || b.development)
    return {
      merge: false,
      reason:
        "Sujet proche, avec un signal de suivi, de correction ou de nouvelle information.",
    };
  if (!sameSet(a.stages, b.stages))
    return {
      merge: false,
      reason:
        "Sujet proche, mais étapes de l’annonce différentes ou insuffisamment précisées.",
    };
  if (a.orderedTitle !== b.orderedTitle)
    return {
      merge: false,
      reason:
        "Titres proches, avec une formulation ou un ordre différents : articles conservés séparément.",
    };

  // Excerpts are evidence, not summaries. Unknown or different details must not
  // disappear behind a title match, including when only one source has text.
  if (a.orderedText !== b.orderedText)
    return {
      merge: false,
      reason:
        "Titres identiques, mais textes disponibles différents ou incomplets : apport possible à vérifier.",
    };

  return {
    merge: true,
    reason:
      "Titres identiques, même langue et publications à sept jours maximum : même annonce probable.",
  };
}

/** Presentation suggestions only: no article, source or reader state is changed. */
export function buildStories(
  articles: StoryArticle[],
  separateArticleIds: ReadonlySet<string> = new Set(),
): { groups: StoryGroup[]; related: StoryRelation[] } {
  const sorted = [...articles].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const prepared = sorted
    .filter(
      (article, index) => index === 0 || article.id !== sorted[index - 1].id,
    )
    .map(prepare);
  const matches = new Map<string, Match>();
  const pairKey = (a: Prepared, b: Prepared) =>
    JSON.stringify([a.article.id, b.article.id].sort());
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const match = compare(prepared[i], prepared[j]);
      if (match) matches.set(pairKey(prepared[i], prepared[j]), match);
    }
  }

  const clusters: Prepared[][] = [];
  for (const article of prepared) {
    if (separateArticleIds.has(article.article.id)) continue;
    // Complete-link compatibility prevents A≈B≈C from implying A≈C.
    const cluster = clusters.find((members) =>
      members.every((member) => matches.get(pairKey(member, article))?.merge),
    );
    if (cluster) cluster.push(article);
    else clusters.push([article]);
  }
  const groups = clusters
    .filter((members) => members.length > 1)
    .map((members) => {
      const articleIds = members.map(({ article }) => article.id);
      return {
        id: `story:${articleIds.map(encodeURIComponent).join(":")}`,
        articleIds,
        reason:
          "Titres identiques, même langue et publications à sept jours maximum : même annonce probable.",
      };
    });
  const membership = new Map(
    groups.flatMap((group) =>
      group.articleIds.map((id) => [id, group.id] as const),
    ),
  );
  const related: StoryRelation[] = [];
  for (const [key, match] of matches) {
    const articleIds = JSON.parse(key) as [string, string];
    if (
      membership.has(articleIds[0]) &&
      membership.get(articleIds[0]) === membership.get(articleIds[1])
    )
      continue;
    related.push({
      articleIds,
      reason: match.merge
        ? separateArticleIds.has(articleIds[0]) ||
          separateArticleIds.has(articleIds[1])
          ? "Même annonce probable, conservée séparément selon votre choix."
          : "Titres proches, mais compatibilité insuffisante avec tous les articles du groupe."
        : match.reason,
    });
  }
  return { groups, related };
}
