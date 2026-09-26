import { digestSourceIssueLabel, type Digest } from "./digest";

/** External text stays literal when a downloaded review is rendered as Markdown. */
function literal(value: string): string {
  return value
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+\-.!|~]/g, "\\$&");
}

export function digestUrl(value: string): string | null {
  if (/[\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href.replace(/[()<>\\\s]/g, (character) =>
      encodeURIComponent(character).replace(
        /[()]/g,
        (part) => `%${part.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    );
  } catch {
    return null;
  }
}

function timestamp(value: string | null): string {
  if (!value) return "Date non fournie";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Date non fournie";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(parsed).toISOString().slice(0, 10) === value
      ? value
      : "Date non fournie";
  }
  return new Date(parsed)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC")
    .replace("Z", " UTC");
}

/** Export the captured edition, not the live dashboard or a fresh time window. */
export function digestMarkdown(digest: Digest): string {
  const lines = [
    "# Defense Tech Monitor — Revue de veille",
    "",
    `Édition du ${timestamp(digest.generatedAt)}.`,
    `Période de collecte : du ${timestamp(digest.from)} au ${timestamp(digest.to)} (bornes incluses).`,
    `Périmètre : ${digest.scope === "personal" ? "Pour moi" : "Tout le flux"} · ${digest.periodHours === 24 ? "24 dernières heures" : "7 derniers jours"}.`,
    "",
    `${digest.shown} publication(s) présentée(s) sur ${digest.total} : ${digest.newCount} première(s) collecte(s), ${digest.updatedCount} actualisation(s) de données déjà collectées, ${digest.sourceCount} source(s).`,
    `${digest.groupCount} regroupement(s) de reprises parmi les publications présentées.`,
    "",
  ];
  if (digest.omitted) {
    lines.push(
      `Revue limitée aux ${digest.shown} publications les plus récemment repérées ou actualisées. ${digest.omitted} publication(s) supplémentaire(s) ne figurent pas dans cette édition. Consultez Tout le flux pour les retrouver.`,
      "",
    );
  }
  lines.push(
    "La période porte sur la première collecte et la dernière modification détectée des données, indépendamment de la date de publication, de la lecture ou de la validation des nouveautés. Cette édition conserve les versions disponibles lors de sa création ; elle ne reconstitue pas les versions antérieures ni le détail des changements.",
    "",
  );
  if (digest.sourceIssues.length) {
    lines.push("## État de la collecte à la création de cette édition", "");
    lines.push(
      "Ces points concernent toutes les sources actives, quel que soit le périmètre sélectionné.",
      "",
    );
    for (const source of digest.sourceIssues) {
      lines.push(
        `- ${literal(source.name)} — ${literal(digestSourceIssueLabel(source, digest.from))}${source.lastError ? ` : ${literal(source.lastError)}` : ""}.`,
      );
    }
    lines.push("");
  }
  if (!digest.shown) {
    lines.push(
      "Aucune publication dans cette période et ce périmètre. Vérifiez aussi la collecte et les critères de votre profil.",
      "",
    );
  }
  for (const section of digest.sections) {
    lines.push(
      `## ${literal(section.theme)} — ${section.publicationCount} publication(s)`,
      "",
    );
    for (const item of section.items) {
      const grouped = item.entries.length > 1;
      if (grouped) {
        lines.push(
          `### Reprises rapprochées — ${item.entries.length} publications`,
          "",
          "Ce rapprochement ne constitue pas une confirmation indépendante. Chaque lien original est conservé.",
          "",
        );
      }
      for (const entry of item.entries) {
        const article = entry.article;
        const url = digestUrl(article.url);
        const title = literal(article.title) || "Publication sans titre";
        lines.push(
          `${grouped ? "####" : "###"} ${url ? `[${title}](<${url.replace(/&/g, "&amp;")}>)` : title}`,
          "",
          `- Source : ${literal(article.sourceName)} · Langue : ${literal(article.language)} · Format : ${article.format === "video" ? "vidéo" : "article"}.`,
          `- Date de publication : ${timestamp(article.publishedAt)}.`,
          `- ${entry.kind === "new" ? "Première collecte" : "Données collectées actualisées"} : ${timestamp(entry.detectedAt)}.`,
          `- Contenu disponible : ${article.contentBasis === "feed_text" ? "texte fourni par le flux" : article.contentBasis === "page_text" ? "texte extrait de la page de l’article" : article.contentBasis === "page_excerpt" ? "extrait de la page publique" : "titre et métadonnées uniquement"}.`,
        );
        if (article.themes.length)
          lines.push(`- Thèmes : ${article.themes.map(literal).join(", ")}.`);
        if (!url) lines.push("- Lien original indisponible.");
        if (article.excerpt && article.contentBasis !== "metadata") {
          lines.push(
            "",
            `**${article.contentBasis === "feed_text" ? "Extrait du flux" : article.contentBasis === "page_text" ? "Extrait de l’article" : "Extrait de la page"} :** ${literal(article.excerpt)}`,
          );
        }
        lines.push("");
      }
    }
  }
  lines.push(
    "---",
    "",
    "Titres et extraits dans leur langue d’origine, sans résumé généré. Consultez les publications originales pour leur contenu complet. La sélection exprime une pertinence pour le profil, pas une évaluation de la fiabilité des affirmations.",
    "",
  );
  return lines.join("\n");
}
