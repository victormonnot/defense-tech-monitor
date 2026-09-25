import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalUrl,
  discoverFeed,
  parseFeed,
  plainText,
  publicUrl,
} from "../src/lib/feed";

// Synthetic fixtures only: these documents do not contain publisher content.
const feedUrl = "https://fixture.example.test/feed";
const rss = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fixture feed</title><link>https://fixture.example.test</link><description>Test fixture</description><language>en-US</language>${items}</channel></rss>`;
const atom = (entries: string) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture feed</title><id>urn:fixture:feed</id><updated>2026-01-02T12:00:00Z</updated>${entries}</feed>`;
const item = (extra = "") =>
  `<item><title>Fixture article</title><link>https://fixture.example.test/articles/one</link>${extra}</item>`;
const entry = (extra = "") =>
  `<entry><title>Fixture article</title><id>urn:fixture:one</id><link href="https://fixture.example.test/articles/one"/>${extra}</entry>`;

test("RSS preserves publisher metadata and separates available text from the title", async () => {
  const [article] = await parseFeed(
    rss(
      item(
        `<guid>fixture-one</guid><pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>A synthetic excerpt.</p>]]></description><content:encoded><![CDATA[<p>First fixture paragraph.</p><p>Second fixture paragraph.</p>]]></content:encoded>`,
      ),
    ),
    feedUrl,
    "fr",
  );
  assert.equal(article.guid, "fixture-one");
  assert.equal(article.publishedAt, "2026-01-02T12:00:00.000Z");
  assert.equal(article.language, "en");
  assert.equal(article.excerpt, "A synthetic excerpt.");
  assert.equal(
    article.text,
    "First fixture paragraph. Second fixture paragraph.",
  );
  assert.equal(article.format, "article");
});

test("Atom reads entry identifiers, links, summaries and publication dates", async () => {
  const [article] = await parseFeed(
    atom(
      entry(
        `<published>2026-01-02T14:00:00+02:00</published><summary type="html">&lt;p&gt;Synthetic Atom excerpt.&lt;/p&gt;</summary>`,
      ),
    ),
    feedUrl,
    "fr-FR",
  );
  assert.equal(article.guid, "urn:fixture:one");
  assert.equal(article.url, "https://fixture.example.test/articles/one");
  assert.equal(article.publishedAt, "2026-01-02T12:00:00.000Z");
  assert.equal(article.excerpt, "Synthetic Atom excerpt.");
  assert.equal(article.language, "fr");
});

test("missing dates stay null in both RSS and Atom", async () => {
  for (const xml of [rss(item()), atom(entry())]) {
    const [article] = await parseFeed(xml, feedUrl, "en");
    assert.equal(article.publishedAt, null);
  }
});

test("invalid RSS dates remain null instead of becoming collection dates", async () => {
  const [article] = await parseFeed(
    rss(item("<pubDate>not-a-date</pubDate>")),
    feedUrl,
    "en",
  );
  assert.equal(article.publishedAt, null);
});

test("invalid Atom dates do not discard an otherwise readable article", async () => {
  for (const field of ["published", "updated"]) {
    const [article] = await parseFeed(
      atom(entry(`<${field}>not-a-date</${field}>`)),
      feedUrl,
      "en",
    );
    assert.equal(article.publishedAt, null);
  }
});

test("title-only entries keep unavailable text and excerpts empty", async () => {
  for (const xml of [rss(item()), atom(entry())]) {
    const [article] = await parseFeed(xml, feedUrl, "en");
    assert.equal(article.title, "Fixture article");
    assert.equal(article.text, "");
    assert.equal(article.excerpt, null);
  }
});

test("feed ingestion removes script and style content from text and excerpts", async () => {
  const xml = rss(
    item(
      `<description><![CDATA[<p>Visible fixture.</p><script>hiddenScript()</script><style>.hidden { color: red; }</style>]]></description>`,
    ),
  );
  const [article] = await parseFeed(xml, feedUrl, "en");
  assert.equal(article.text, "Visible fixture.");
  assert.equal(article.excerpt, "Visible fixture.");
});

test("plain text extraction removes non-content elements and preserves word boundaries", () => {
  assert.equal(
    plainText(
      "<p>First &amp; second.</p><p>Third<br>fourth.</p><script>hiddenScript()</script><style>hiddenStyle</style><iframe>hiddenFrame</iframe><template>hiddenTemplate</template><noscript>hiddenFallback</noscript>",
    ),
    "First & second. Third fourth.",
  );
});

test("unsafe article links are excluded while valid entries are retained", async () => {
  const xml = rss(
    `<item><title>Unsafe fixture</title><link>javascript:alert(1)</link></item>${item()}`,
  );
  const articles = await parseFeed(xml, feedUrl, "en");
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Fixture article");
  assert.throws(() => publicUrl("javascript:alert(1)"));
  assert.throws(() => publicUrl("https://user:password@fixture.example.test/"));
});

test("canonical URLs remove tracking and fragments without dropping content parameters", () => {
  assert.equal(
    canonicalUrl(
      "/articles/one?utm_source=fixture&b=2&fbclid=tracking&a=1&gclid=tracking#section",
      feedUrl,
    ),
    "https://fixture.example.test/articles/one?a=1&b=2",
  );
});

test("tracked links produce the same article URL and content hash", async () => {
  const first = rss(item());
  const tracked = first.replace(
    "/articles/one</link>",
    "/articles/one?utm_source=fixture</link>",
  );
  const [[a], [b]] = await Promise.all([
    parseFeed(first, feedUrl, "en"),
    parseFeed(tracked, feedUrl, "en"),
  ]);
  assert.equal(a.url, b.url);
  assert.equal(a.guid, b.guid);
  assert.equal(a.contentHash, b.contentHash);
});

test("feed discovery uses explicit RSS or Atom links and rejects unsafe URLs", () => {
  assert.equal(
    discoverFeed(
      '<link rel="alternate" type="application/rss+xml" href="/rss">',
      feedUrl,
    ),
    "https://fixture.example.test/rss",
  );
  assert.equal(
    discoverFeed(
      '<link rel="alternate" type="application/atom+xml" href="atom.xml">',
      feedUrl,
    ),
    "https://fixture.example.test/atom.xml",
  );
  assert.equal(discoverFeed('<a href="/feed">News feed</a>', feedUrl), null);
  assert.throws(() =>
    discoverFeed(
      '<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">',
      feedUrl,
    ),
  );
});

test("HTML responses and external XML declarations are rejected", async () => {
  await assert.rejects(
    parseFeed("<html><title>Fixture homepage</title></html>", feedUrl, "en"),
  );
  await assert.rejects(
    parseFeed(
      `<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///fixture">]>${rss(item())}`,
      feedUrl,
      "en",
    ),
  );
  assert.deepEqual(await parseFeed(rss(""), feedUrl, "en"), []);
});
