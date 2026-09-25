import { createHash } from "node:crypto";
import { load } from "cheerio";
import { canonicalUrl, plainText, type FeedEntry } from "../feed";

const ORIGIN = "https://thedefender.media";
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function articleUrl(href: string | undefined, pageUrl: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(canonicalUrl(href, pageUrl));
    if (
      url.origin !== ORIGIN ||
      !/^\/en\/(?:(?:19|20)\d{2}\/(?:0[1-9]|1[0-2])|insights)\/[a-z0-9][a-z0-9-]*\/?$/.test(
        url.pathname,
      )
    )
      return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
    return url.toString();
  } catch {
    return null;
  }
}

function calendarDate(year: number, month: number, day: number): string | null {
  if (
    year < 1900 ||
    year > 2099 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  )
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
}

function publishedDate(raw: string): string | null {
  const value = raw.trim();
  const iso = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/,
  );
  if (iso) {
    const day = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (!day) return null;
    // A date without an explicit timezone must not acquire a made-up UTC time.
    if (!iso[4]) return day;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : null;
  }
  const dayFirst = value.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/i);
  const monthFirst = value.match(/^([a-z]+) (\d{1,2}),? (\d{4})$/i);
  const day = dayFirst?.[1] ?? monthFirst?.[2];
  const month = dayFirst?.[2] ?? monthFirst?.[1];
  const year = dayFirst?.[3] ?? monthFirst?.[3];
  if (!day || !month || !year) return null;
  return calendarDate(
    Number(year),
    MONTHS.indexOf(month.toLowerCase()) + 1,
    Number(day),
  );
}

/** Read only the article cards published on Defender's English home page. */
export function parseDefenderPage(html: string, pageUrl: string): FeedEntry[] {
  const page = new URL(pageUrl);
  if (
    page.origin !== ORIGIN ||
    !/^\/en\/?$/.test(page.pathname) ||
    page.username ||
    page.password
  )
    throw new Error(
      "Le connecteur Defender Media attend la page d’accueil anglaise officielle.",
    );
  const $ = load(html);
  $("script, style, noscript, iframe, template").remove();
  const entries = new Map<string, Omit<FeedEntry, "contentHash">>();
  const cards = $(
    "article.one-news, .featured-article, .article.swiper-slide, a.trending-news-box",
  );
  cards.each((_, node) => {
    const card = $(node);
    if (
      card.closest(
        "nav, header, footer, [role='navigation'], .advertisement, .advertising, .ads, .ad",
      ).length
    )
      return;
    const trending = card.is("a.trending-news-box");
    const titleNode = card
      .find(".entry-title a, .article-title a, .insights-article-title a")
      .first();
    const url = articleUrl(
      trending ? card.attr("href") : titleNode.attr("href"),
      pageUrl,
    );
    if (!url) return;
    const title = plainText(
      (trending ? card.find(".article-title").first() : titleNode).html() ?? "",
    ).slice(0, 1000);
    if (
      !title ||
      /^(read more|learn more|continue reading|latest news|all articles)$/i.test(
        title,
      )
    )
      return;
    const excerptNode = card
      .find("a.excerpt-link")
      .filter(
        (_, element) => articleUrl($(element).attr("href"), pageUrl) === url,
      )
      .first()
      .clone();
    excerptNode.find(".read-more, .more-link").remove();
    const excerptText = plainText(excerptNode.html() ?? "").slice(0, 480);
    const excerpt =
      excerptText &&
      excerptText !== title &&
      !/^(read more|learn more|continue reading)$/i.test(excerptText)
        ? excerptText
        : null;
    const time = card.find("time.published").first();
    const publishedAt =
      publishedDate(time.attr("datetime") ?? time.text()) ??
      publishedDate(
        card
          .find(".article-data-date, .sidebar-article-data > span")
          .first()
          .text(),
      );
    const entry: Omit<FeedEntry, "contentHash"> = {
      guid: url,
      url,
      title,
      publishedAt,
      text: excerpt ?? "",
      excerpt,
      language: "en",
      format: "article",
      contentBasis: excerpt ? "page_excerpt" : "metadata",
    };
    const previous = entries.get(url);
    if (!previous) {
      entries.set(url, entry);
      return;
    }
    // Featured, trending and latest sections can repeat the same publication.
    // Keep the richest card and fill missing metadata from its other occurrence.
    const preferred =
      entry.text.length > previous.text.length ? entry : previous;
    const other = preferred === entry ? previous : entry;
    const date = preferred.publishedAt ?? other.publishedAt;
    entries.set(url, {
      ...preferred,
      publishedAt:
        date && date.length === 10 && other.publishedAt?.startsWith(date)
          ? other.publishedAt
          : date,
    });
  });
  if (!entries.size)
    throw new Error(
      "Defender Media : aucune carte d’article reconnue sur la page d’accueil. La structure de la page a peut-être changé.",
    );
  return [...entries.values()].slice(0, 200).map((entry) => ({
    ...entry,
    contentHash: createHash("sha256")
      .update(
        JSON.stringify([
          entry.url,
          entry.title,
          entry.publishedAt,
          entry.text,
          entry.excerpt,
          entry.language,
          entry.format,
          entry.contentBasis,
        ]),
      )
      .digest("hex"),
  }));
}
