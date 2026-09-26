import { load } from "cheerio";
import { plainText } from "../feed";

const ORIGIN = "https://brave1.gov.ua";
const MAX_TEXT_LENGTH = 20_000;

function articleIdentity(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      !/^\/en\/news\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(url.pathname)
    )
      return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function isEnglish(value: string) {
  return /^en(?:[-_][a-z0-9]+)*$/i.test(value.trim());
}

export function extractBrave1Article(
  html: string,
  pageUrl: string,
): string | null {
  const identity = articleIdentity(pageUrl);
  if (!identity) return null;
  const $ = load(html);

  if ($('meta[http-equiv="refresh" i]').length) return null;
  for (const tag of $(
    'head link[rel~="canonical"][href], head meta[property="og:url"][content]',
  ).toArray()) {
    if (
      articleIdentity(
        $(tag).attr("href") ?? $(tag).attr("content") ?? "",
        pageUrl,
      ) !== identity
    )
      return null;
  }

  // Brave1's English pages currently declare lang="uk" on the HTML root.
  // Accept that known template error only; article-level language still wins.
  const rootLanguage = $("html").attr("lang")?.trim();
  if (rootLanguage && rootLanguage !== "uk" && !isEnglish(rootLanguage))
    return null;
  for (const tag of $(
    'meta[property="og:locale"][content], meta[http-equiv="content-language" i][content], body[lang], app-news-view[lang], app-news-view main[lang], app-news-view section.main__content[lang], app-news-view section.main__content > .content[lang]',
  ).toArray()) {
    if (!isEnglish($(tag).attr("lang") ?? $(tag).attr("content") ?? ""))
      return null;
  }

  $(
    'script, style, noscript, template, iframe, svg, canvas, [hidden], [inert], [aria-hidden="true"], .hidden, .d-none, .sr-only, .visually-hidden',
  ).remove();
  $("[style]").each((_, node) => {
    if (
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
        $(node).attr("style") ?? "",
      )
    )
      $(node).remove();
  });

  const view = $("app-news-view");
  const heading = view.find("main app-news-view-hero h1");
  const section = view.find("main section.main__content");
  if (
    view.length !== 1 ||
    heading.length !== 1 ||
    !heading.text().trim() ||
    section.length !== 1
  )
    return null;
  if (
    view.find('.paywall, .subscription-required, [data-paywall="true"]').length
  )
    return null;

  section
    .find(
      "nav, aside, header, footer, form, button, figure, figcaption, .caption, .image-caption, .related-articles, app-news-cards-list, .share, .social-share, .newsletter, .cookie-banner",
    )
    .remove();
  section.find("cite, cite > span").each((_, node) => {
    $(node).prepend(" ").append(" ");
  });

  const fragments: string[] = [];
  let unknownContent = false;
  section.children(".content").each((_, node) => {
    const block = $(node);
    if (block.hasClass("html")) {
      fragments.push(block.html() ?? "");
      return;
    }
    // These two editorial components occur between rich-text blocks.
    const list = block.children("app-numbered-list");
    const quote = block.children("app-quote-block").find("blockquote");
    if (list.length) fragments.push(list.html() ?? "");
    else if (quote.length) fragments.push(quote.html() ?? "");
    else if (block.text().trim()) unknownContent = true;
  });
  if (unknownContent || !fragments.length) return null;

  const text = plainText(fragments.join(" "));
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = text.match(/\p{Script=Latin}/gu) ?? [];
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  const englishMarkers = new Set(
    words
      .map((word) => word.toLowerCase())
      .filter((word) =>
        /^(?:the|and|of|to|in|for|with|is|are|a|an|that|from|has|have|on|will|by)$/.test(
          word,
        ),
      ),
  );
  if (
    text.length < 400 ||
    words.length < 35 ||
    latin.length / Math.max(1, letters.length) < 0.8 ||
    englishMarkers.size < 3
  )
    return null;
  return text.slice(0, MAX_TEXT_LENGTH).trim();
}
