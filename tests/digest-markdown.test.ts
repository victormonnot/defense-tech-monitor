import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MonitorStore } from "../src/lib/store";
import { buildDigest, type Digest } from "../src/lib/digest";
import { digestMarkdown, digestUrl } from "../src/lib/digest-markdown";
import type { FeedEntry } from "../src/lib/feed";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function fixture(t: TestContext, entries: FeedEntry[]) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  const sourceId = store.addSource({
    name: "Synthetic publication",
    siteUrl: "https://example.test",
    feedUrl: "https://example.test/feed",
    language: "en",
  });
  store.upsertEntries(sourceId, entries, "2026-09-25T10:00:00.000Z");
  return {
    store,
    digest: buildDigest(store.snapshot(), {
      periodHours: 24,
      scope: "all",
      now: NOW,
    }),
  };
}

function entry(patch: Partial<FeedEntry> = {}): FeedEntry {
  return {
    guid: "synthetic-article",
    url: "https://example.test/robot",
    title: "Synthetic robot publication",
    publishedAt: "2025-01-01",
    text: "A short synthetic excerpt.",
    excerpt: "A short synthetic excerpt.",
    language: "en",
    format: "article",
    contentBasis: "feed_text",
    contentHash: "synthetic-content",
    ...patch,
  };
}

test("Markdown export keeps the captured edition, original attribution and distinct publication and collection dates", (t) => {
  const { store, digest } = fixture(t, [entry()]);
  const before = store.snapshot();
  const markdown = digestMarkdown(digest);
  assert.match(markdown, /Édition du 2026-09-25 12:00:00 UTC/);
  assert.match(markdown, /Date de publication : 2025-01-01/);
  assert.match(markdown, /Première collecte : 2026-09-25 10:00:00 UTC/);
  assert.match(markdown, /Source : Synthetic publication · Langue : en/);
  assert.match(
    markdown,
    /\[Synthetic robot publication\]\(<https:\/\/example.test\/robot>\)/,
  );
  assert.match(markdown, /\*\*Extrait du flux :\*\* A short synthetic excerpt/);
  assert.match(markdown, /sans résumé généré/);
  assert.deepEqual(store.snapshot(), before);

  store.upsertEntries(
    before.sources[0].id,
    [entry({ title: "Later modified title", contentHash: "new-hash" })],
    "2026-09-25T13:00:00.000Z",
  );
  assert.equal(digestMarkdown(digest), markdown);
  assert.doesNotMatch(markdown, /Later modified title/);
});

test("incomplete content remains explicit and metadata-only entries never export an excerpt", (t) => {
  const { digest } = fixture(t, [
    entry({
      text: "",
      excerpt: "Do not export this misleading metadata excerpt",
      contentBasis: "metadata",
      publishedAt: null,
      format: "video",
    }),
    entry({
      guid: "page-excerpt",
      url: "https://example.test/card",
      title: "Synthetic public card",
      contentBasis: "page_excerpt",
      excerpt: "This text comes from a listing card.",
    }),
  ]);
  const markdown = digestMarkdown(digest);
  assert.match(markdown, /titre et métadonnées uniquement/);
  assert.match(markdown, /Date de publication : Date non fournie/);
  assert.match(markdown, /Format : vidéo/);
  assert.doesNotMatch(markdown, /misleading metadata excerpt/);
  assert.match(
    markdown,
    /\*\*Extrait de la page :\*\* This text comes from a listing card/,
  );
});

test("untrusted titles, excerpts, theme names and source errors cannot inject Markdown structure or HTML", (t) => {
  const { digest } = fixture(t, [
    entry({
      title: "](<javascript:alert(1)>)\n# INJECTED HEADING",
      url: "javascript:alert(1)",
      excerpt:
        "<img src=x onerror=alert(1)>\n```html\n<script>attack()</script>\n![image](https://evil.test/x)",
    }),
  ]);
  digest.sections[0].theme = "Topic\n# INJECTED TOPIC";
  digest.sourceIssues[0].name = "[Trusted](https://evil.test)";
  digest.sourceIssues[0].lastError =
    "Failure\n# INJECTED ERROR\n<script>attack()</script>";
  const markdown = digestMarkdown(digest);
  assert.doesNotMatch(markdown, /^(?:# INJECTED|```|<script|<img|!\[image\])/m);
  assert.doesNotMatch(markdown, /<javascript:|\]\(<javascript:/);
  assert.ok(markdown.includes("&lt;img src=x onerror=alert\\(1\\)&gt;"));
  assert.ok(markdown.includes("\\# INJECTED HEADING"));
  assert.ok(markdown.includes("\\[Trusted\\]\\(https://evil\\.test\\)"));
  assert.match(markdown, /Lien original indisponible/);
});

test("export URLs reject active schemes and credentials and encode destination delimiters", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>x</script>",
    "file:///private/file",
    "/relative",
    "https://user:secret@example.test/",
    "https://example.test/\nattack",
    "not a url",
  ])
    assert.equal(digestUrl(value), null);
  assert.equal(
    digestUrl("https://example.test/a(b)?q=<x> hello"),
    "https://example.test/a%28b%29?q=%3Cx%3E%20hello",
  );
  assert.equal(
    digestUrl("http://example.test/article#section"),
    "http://example.test/article#section",
  );
});

test("Markdown destinations preserve entity-like query strings without changing browser URLs", (t) => {
  const url = "https://example.test/article?q=&copy;&next=&NewLine;";
  const { digest } = fixture(t, [entry({ url })]);
  assert.equal(digestUrl(url), url);
  assert.ok(
    digestMarkdown(digest).includes(
      "<https://example.test/article?q=&amp;copy;&amp;next=&amp;NewLine;>",
    ),
  );
});

test("bounded editions disclose omitted publications in the downloaded review", (t) => {
  const { digest } = fixture(
    t,
    Array.from({ length: 102 }, (_, i) =>
      entry({
        guid: `item-${i}`,
        url: `https://example.test/item-${i}`,
        title: `Synthetic item ${i}`,
      }),
    ),
  );
  const markdown = digestMarkdown(digest);
  assert.match(markdown, /100 publication\(s\) présentée\(s\) sur 102/);
  assert.match(markdown, /2 publication\(s\) supplémentaire\(s\)/);
  assert.equal((markdown.match(/^### /gm) ?? []).length, 100);
});

test("grouped exports keep every included original link and disclose global source issues", (t) => {
  const { digest } = fixture(t, [entry()]);
  const first = digest.sections[0].items[0].entries[0];
  const grouped: Digest = {
    ...digest,
    total: 2,
    shown: 2,
    omitted: 0,
    newCount: 1,
    updatedCount: 1,
    sourceCount: 2,
    groupCount: 1,
    sections: [
      {
        theme: "Robotique",
        publicationCount: 2,
        items: [
          {
            id: "synthetic-group",
            entries: [
              first,
              {
                ...first,
                kind: "updated",
                detectedAt: "2026-09-25T11:00:00.000Z",
                article: {
                  ...first.article,
                  id: "second",
                  sourceName: "Second source",
                  url: "https://second.test/original",
                  title: "Second original title",
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const markdown = digestMarkdown(grouped);
  assert.match(markdown, /2 publication\(s\) présentée\(s\) sur 2/);
  assert.match(markdown, /<https:\/\/example.test\/robot>/);
  assert.match(markdown, /<https:\/\/second.test\/original>/);
  assert.match(
    markdown,
    /Données collectées actualisées : 2026-09-25 11:00:00 UTC/,
  );
  assert.match(markdown, /ne constitue pas une confirmation indépendante/);
  assert.match(
    markdown,
    /toutes les sources actives, quel que soit le périmètre/,
  );
});

test("empty editions stay exportable and never imply that sources stopped publishing", (t) => {
  const { digest } = fixture(t, []);
  const markdown = digestMarkdown(digest);
  assert.match(markdown, /0 publication\(s\) présentée\(s\) sur 0/);
  assert.match(
    markdown,
    /Aucune publication dans cette période et ce périmètre/,
  );
  assert.match(markdown, /Vérifiez aussi la collecte/);
  assert.match(markdown, /Synthetic publication/);
});
