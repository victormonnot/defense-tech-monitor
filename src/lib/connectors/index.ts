import { parseFeed, publicUrl, type FeedEntry } from "../feed";
import { parseBrave1Page } from "./brave1";
import { parseDefenderPage } from "./defender";

export interface CollectionTarget {
  kind: "rss" | "website";
  url: string;
  parse(
    body: string,
    responseUrl: string,
    language: string,
  ): FeedEntry[] | Promise<FeedEntry[]>;
}

function websiteTarget(
  url: string,
  parse: (html: string, pageUrl: string) => FeedEntry[],
): CollectionTarget {
  return {
    kind: "website",
    url,
    parse(body, responseUrl) {
      const expected = new URL(url);
      const actual = new URL(responseUrl);
      if (
        actual.origin !== expected.origin ||
        actual.pathname.replace(/\/$/, "") !==
          expected.pathname.replace(/\/$/, "")
      ) {
        throw new Error(
          "La source a redirigé vers une autre page. Le connecteur doit être vérifié.",
        );
      }
      return parse(body, responseUrl);
    },
  };
}

export function resolveCollection(
  siteUrl: string,
  feedUrl: string | null,
): CollectionTarget | null {
  if (feedUrl)
    return { kind: "rss", url: publicUrl(feedUrl), parse: parseFeed };
  let site: URL;
  try {
    site = new URL(publicUrl(siteUrl));
  } catch {
    return null;
  }
  if (
    site.hostname === "brave1.gov.ua" &&
    /^\/en(?:\/news)?\/?$/.test(site.pathname)
  ) {
    return websiteTarget("https://brave1.gov.ua/en/news", parseBrave1Page);
  }
  if (
    site.hostname === "thedefender.media" &&
    /^\/en\/?$/.test(site.pathname)
  ) {
    return websiteTarget("https://thedefender.media/en/", parseDefenderPage);
  }
  return null;
}
