import { load } from "cheerio";
import { canonicalUrl, plainText } from "../feed";

const ARTICLE_PATH =
  /^\/en\/(?:(?:19|20)\d{2}\/(?:0[1-9]|1[0-2])|insights)\/[a-z0-9][a-z0-9-]*\/?$/;
const BLOCKS = "p, h2, h3, h4, h5, h6, li, blockquote";
const NON_CONTENT = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "nav",
  "aside",
  "header",
  "footer",
  "form",
  "button",
  "input",
  "figure",
  "figcaption",
  "audio",
  "video",
  "[hidden]",
  "[inert]",
  "[aria-hidden='true' i]",
  ".hidden",
  ".d-none",
  ".screen-reader-text",
  ".sr-only",
  ".share-wrap",
  ".social-share",
  ".sharedaddy",
  ".single-article-summary",
  ".single-ml-subscribe-form",
  ".newsletter",
  ".newsletter-form",
  ".subscribe-form",
  ".subscription-form",
  ".related-posts",
  ".related-articles",
  ".yarpp-related",
  ".article-preview",
  ".wp-block-buttons",
  ".wp-block-thdfndr-audio",
  ".wp-block-embed",
  ".wp-block-image",
  ".wp-caption",
  ".caption",
  ".post-tags",
  ".post-navigation",
  ".cookie-notice",
  ".advertisement",
  ".ads",
  ".ad",
].join(", ");
const RESTRICTED = [
  ".pmpro-body-no-access",
  ".pmpro-no-access",
  ".pmpro_content_message",
  ".pmpro-content-restricted",
  ".paywall",
  ".subscription-required",
  "[data-paywall]",
  "[data-access='restricted']",
  "[itemprop='isAccessibleForFree'][content='false']",
].join(", ");

function articleIdentity(value: string, base?: string): string | null {
  try {
    const url = new URL(canonicalUrl(value, base));
    if (
      url.origin !== "https://thedefender.media" ||
      !ARTICLE_PATH.test(url.pathname) ||
      url.search
    )
      return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
    return url.toString();
  } catch {
    return null;
  }
}

function isEnglish(value: string): boolean {
  return /^en(?:[-_][a-z0-9]+)*$/i.test(value.trim());
}

/** Extract the visible public article body; never use embedded article text. */
export function extractDefenderArticle(
  html: string,
  pageUrl: string,
): string | null {
  const identity = articleIdentity(pageUrl);
  if (!identity) return null;
  const $ = load(html);
  for (const node of $(
    "link[rel~='canonical'], meta[property='og:url']",
  ).toArray()) {
    const value = $(node).attr("href") ?? $(node).attr("content");
    if (!value || articleIdentity(value, pageUrl) !== identity) return null;
  }
  for (const node of $(
    "html[lang], html[xml\\:lang], body[lang], meta[property='og:locale'], meta[http-equiv='content-language']",
  ).toArray()) {
    const value =
      $(node).attr("lang") ??
      $(node).attr("xml:lang") ??
      $(node).attr("content");
    if (value && !isEnglish(value)) return null;
  }
  // Read access and identity metadata only. Text in JSON-LD may be hidden or gated.
  for (const node of $("script[type='application/ld+json']").toArray()) {
    let pending: unknown[];
    try {
      pending = [JSON.parse($(node).text())];
    } catch {
      continue;
    }
    while (pending.length) {
      const item = pending.pop();
      if (Array.isArray(item)) {
        for (const value of item) pending.push(value);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (String(record.isAccessibleForFree).toLowerCase() === "false")
        return null;
      const types = Array.isArray(record["@type"])
        ? record["@type"]
        : [record["@type"]];
      if (
        types.some(
          (type) =>
            typeof type === "string" &&
            /(?:^|\/)(?:Article|NewsArticle|BlogPosting|WebPage)$/.test(type),
        )
      ) {
        const declaredUrl = record.url ?? record["@id"];
        if (
          typeof declaredUrl === "string" &&
          articleIdentity(declaredUrl, pageUrl) !== identity
        )
          return null;
        if (
          typeof record.inLanguage === "string" &&
          !isEnglish(record.inLanguage)
        )
          return null;
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === "object") pending.push(value);
      }
    }
  }
  if ($(RESTRICTED).length) return null;
  $(NON_CONTENT).remove();
  $("[style]").each((_, node) => {
    if (
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?)(?:\s*!important)?\s*(?:;|$)/i.test(
        $(node).attr("style") ?? "",
      )
    )
      $(node).remove();
  });
  const bodies = $("section.blog-post .blog-post-container > .single-article");
  if (bodies.length !== 1) return null;
  const body = bodies.first();
  const section = body.closest("section.blog-post");
  if (!plainText(section.find(".blog-post-data h1").first().html() ?? ""))
    return null;
  for (const node of body.add(body.parents()).filter("[lang]").toArray()) {
    const language = $(node).attr("lang");
    if (language && !isEnglish(language)) return null;
  }
  const paragraphs: string[] = [];
  const narrative: string[] = [];
  body.find(BLOCKS).each((_, node) => {
    const block = $(node);
    if (block.find(BLOCKS).length) return;
    const text = plainText(block.html() ?? "");
    if (
      !text ||
      /^(?:read also|read more|also read|related articles|subscribe|sign up|follow us|share this article)\b/i.test(
        text,
      )
    )
      return;
    paragraphs.push(text);
    if (block.is("p, li, blockquote")) narrative.push(text);
  });
  const prose = narrative.join(" ");
  if (prose.length < 400 || prose.split(/\s+/).length < 40) return null;
  return paragraphs.join("\n\n").slice(0, 20000).trim();
}
