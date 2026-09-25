import { createHash } from "node:crypto";
import { load } from "cheerio";
import { canonicalUrl, plainText, type FeedEntry } from "../feed";

const ORIGIN = "https://brave1.gov.ua";

function calendarDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function publicationDate(
  datetime: string | undefined,
  visible: string,
): string | null {
  const value = datetime?.trim() ?? "";
  const day = calendarDate(value.slice(0, 10));
  if (day && value.length === 10) return day;
  if (
    day &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(
      value,
    )
  ) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }

  // The rendered time has no timezone; preserve only its stated calendar date.
  const rendered = visible
    .trim()
    .match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\s*\|\s*(?:[01]\d|2[0-3]):[0-5]\d)?$/);
  return rendered
    ? calendarDate(`${rendered[1]}-${rendered[2]}-${rendered[3]}`)
    : null;
}

function articleUrl(href: string, pageUrl: string): string | null {
  try {
    const url = new URL(canonicalUrl(href, pageUrl));
    if (url.origin !== ORIGIN) return null;
    // The public English listing currently includes this broken language prefix.
    url.pathname = url.pathname.replace(
      /^\/en\/news\/langPrefix\/news\//,
      "/en/news/",
    );
    if (!/^\/en\/news\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(url.pathname))
      return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function parseBrave1Page(html: string, pageUrl: string): FeedEntry[] {
  const page = new URL(pageUrl);
  if (
    page.origin !== ORIGIN ||
    page.username ||
    page.password ||
    !/^\/en\/news\/?$/.test(page.pathname)
  )
    throw new Error(
      "Le connecteur Brave1 nécessite la page officielle des actualités en anglais.",
    );

  const $ = load(html);
  $("script, style, noscript, iframe, template").remove();
  const cards = $("app-news-home-list app-news-cards-list app-news-card");
  if (cards.length === 0)
    throw new Error(
      "La liste des actualités Brave1 est introuvable ; la structure de la page a peut-être changé.",
    );

  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  cards.each((_, card) => {
    const link = $(card)
      .find("h3.block__title > a.block__title-link[href]")
      .first();
    const href = link.attr("href");
    if (!href) return;
    const url = articleUrl(href, pageUrl);
    const title = plainText(link.html() ?? "").slice(0, 1000);
    if (!url || !title || seen.has(url)) return;

    const time = $(card).find("time").first();
    const publishedAt = publicationDate(time.attr("datetime"), time.text());
    // These cards publish metadata only, without article bodies or excerpts.
    const entry = {
      guid: url,
      url,
      title,
      publishedAt,
      text: "",
      excerpt: null,
      language: "en",
      format: "article" as const,
      contentBasis: "metadata" as const,
    };
    entries.push({
      ...entry,
      contentHash: createHash("sha256")
        .update(JSON.stringify(entry))
        .digest("hex"),
    });
    seen.add(url);
  });

  if (entries.length === 0)
    throw new Error(
      "Les cartes Brave1 ne contiennent aucune publication avec titre et lien utilisables.",
    );
  return entries;
}
