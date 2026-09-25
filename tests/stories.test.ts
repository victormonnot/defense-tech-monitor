import assert from "node:assert/strict";
import test from "node:test";
import { buildStories, type StoryArticle } from "../src/lib/stories";
import type { Article } from "../src/lib/types";

// Synthetic announcements only; no publisher content is embedded in fixtures.
function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    sourceId: `source-${id}`,
    sourceName: `Source ${id}`,
    title: "Acme unveils Falcon autonomous reconnaissance drone",
    url: `https://fixture.example.test/${id}`,
    publishedAt: "2026-09-20T12:00:00Z",
    collectedAt: "2026-09-25T12:00:00Z",
    language: "en",
    format: "article",
    themes: ["Drones"],
    excerpt: null,
    contentBasis: "metadata",
    score: 80,
    reasons: ["Fixture"],
    isRead: false,
    saved: false,
    feedback: null,
    keepSeparate: false,
    ...overrides,
  };
}

function assertRelated(a: Article, b: Article) {
  const result = buildStories([a, b]);
  assert.equal(result.groups.length, 0);
  assert.deepEqual(
    result.related.map(({ articleIds }) => articleIds),
    [[a.id, b.id].sort()],
  );
  return result.related[0];
}

test("same announcement across sources groups deterministically without changing articles", () => {
  const a = article("a", { isRead: true, saved: true, feedback: "relevant" });
  const b = article("b", {
    title: "ACME unveils Falcon — autonomous reconnaissance drone!",
    publishedAt: "2026-09-22",
    language: "en-GB",
  });
  const before = structuredClone([a, b]);
  const result = buildStories([a, b]);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].articleIds, ["a", "b"]);
  assert.match(result.groups[0].reason, /probable/);
  assert.deepEqual(result.related, []);
  assert.deepEqual(buildStories([b, a]), result);
  assert.deepEqual([a, b], before);
});

test("known-language headlines tolerate case, accents and punctuation", () => {
  const result = buildStories([
    article("a", {
      language: "fr",
      title: "Aérovia dévoile Faucon, son robot de reconnaissance autonome",
    }),
    article("b", {
      language: "fr-FR",
      title: "AEROVIA dévoile Faucon : son robot de reconnaissance autonome!",
    }),
  ]);
  assert.equal(result.groups.length, 1);
});

test("an exact headline from the same source is not a cross-source group", () => {
  assert.deepEqual(
    buildStories([article("a"), article("b", { sourceId: "source-a" })]),
    { groups: [], related: [] },
  );
});

test("publication dates must exist and be valid; collection time is not a substitute", () => {
  for (const publishedAt of [
    null,
    "",
    "not-a-date",
    "2026-02-30",
    "2026-09-20T99:00:00Z",
  ]) {
    assert.deepEqual(
      buildStories([article("a"), article("b", { publishedAt })]),
      { groups: [], related: [] },
    );
  }
});

test("the publication window includes seven days but no more", () => {
  const a = article("a", { publishedAt: "2026-09-20" });
  assert.equal(
    buildStories([a, article("b", { publishedAt: "2026-09-27" })]).groups
      .length,
    1,
  );
  assert.deepEqual(
    buildStories([a, article("b", { publishedAt: "2026-09-27T00:00:01Z" })]),
    { groups: [], related: [] },
  );
});

test("different or unknown languages cannot be grouped even with identical titles", () => {
  for (const language of ["fr", "uk", "", "und", "unknown", "mul", "xx"]) {
    assert.deepEqual(buildStories([article("a"), article("b", { language })]), {
      groups: [],
      related: [],
    });
  }
  assert.deepEqual(
    buildStories([
      article("a", { language: "und" }),
      article("b", { language: "und" }),
    ]),
    { groups: [], related: [] },
  );
});

test("domain vocabulary alone cannot identify the same announcement", () => {
  const title = "Ukraine unveils new autonomous military drone systems";
  assert.deepEqual(
    buildStories([article("a", { title }), article("b", { title })]),
    { groups: [], related: [] },
  );
});

test("titles about the same field with different named products remain unrelated", () => {
  assert.deepEqual(
    buildStories([
      article("a", {
        title: "Acme unveils Falcon autonomous reconnaissance drone",
      }),
      article("b", {
        title: "Boreal unveils Raven autonomous reconnaissance drone",
      }),
    ]),
    { groups: [], related: [] },
  );
});

test("different numeric facts, scales, currencies and quantities never collapse", () => {
  for (const [first, second] of [
    [
      "Acme orders 10 Falcon autonomous reconnaissance drones",
      "Acme orders 20 Falcon autonomous reconnaissance drones",
    ],
    [
      "Acme orders Falcon reconnaissance drones for 10 million dollars",
      "Acme orders Falcon reconnaissance drones for 10 billion dollars",
    ],
    [
      "Acme orders Falcon reconnaissance drones for $10 million",
      "Acme orders Falcon reconnaissance drones for €10 million",
    ],
    [
      "Acme orders 10 Falcon and 20 Raven reconnaissance drones",
      "Acme orders 20 Falcon and 10 Raven reconnaissance drones",
    ],
    [
      "Acme orders two Falcon reconnaissance drones",
      "Acme orders three Falcon reconnaissance drones",
    ],
    [
      "Acme orders first Falcon reconnaissance drone batch",
      "Acme orders second Falcon reconnaissance drone batch",
    ],
  ]) {
    const relation = assertRelated(
      article("a", { title: first }),
      article("b", { title: second }),
    );
    assert.match(relation.reason, /chiffres|unités/);
  }
});

test("identical long excerpts with one changed number remain separate", () => {
  const excerpt =
    "Acme demonstrated the Falcon platform during its annual conference alongside engineers partners procurement officials and operators. The prototype carries 10 sensors.";
  assertRelated(
    article("a", { excerpt }),
    article("b", { excerpt: excerpt.replace("10 sensors", "20 sensors") }),
  );
});

test("explicit follow-ups, corrections and negation remain related but separate", () => {
  for (const prefix of ["Update: ", "Correction: ", "New details: "]) {
    const relation = assertRelated(
      article("a"),
      article("b", {
        title: `${prefix}Acme unveils Falcon autonomous reconnaissance drone`,
      }),
    );
    assert.match(relation.reason, /suivi|correction|nouvelle information/);
  }
  assertRelated(
    article("a"),
    article("b", {
      title: "Acme never unveils Falcon autonomous reconnaissance drone",
    }),
  );
});

test("a delivery or a trial is not the original product announcement", () => {
  for (const verb of ["tests", "delivers", "deploys", "orders"]) {
    const relation = assertRelated(
      article("a"),
      article("b", {
        title: `Acme ${verb} Falcon autonomous reconnaissance drone`,
      }),
    );
    assert.match(relation.reason, /étapes/);
  }
});

test("new or missing excerpt information keeps both articles separate", () => {
  const excerpt =
    "Acme demonstrated the Falcon prototype in a public exhibition.";
  for (const other of [
    null,
    `${excerpt} Operators also demonstrated thermal navigation.`,
    "The platform uses laser sensors to map terrain.",
  ]) {
    const relation = assertRelated(
      article("a", { excerpt }),
      article("b", { excerpt: other }),
    );
    assert.match(relation.reason, /textes disponibles/);
  }
  assertRelated(
    article("a", { excerpt }),
    article("b", {
      excerpt: `${excerpt} New details confirm a delayed delivery.`,
    }),
  );
});

test("equivalent excerpts with only case and punctuation differences can group", () => {
  const result = buildStories([
    article("a", {
      excerpt: "Acme demonstrated the Falcon prototype in public.",
    }),
    article("b", {
      excerpt: "ACME demonstrated the Falcon prototype — in public!",
    }),
  ]);
  assert.equal(result.groups.length, 1);
});

test("a lexical similarity chain remains related without merging paraphrases", () => {
  const articles = [
    article("a", {
      title: "Acme Falcon radar lidar optical infrared telemetry prototype",
    }),
    article("b", {
      title:
        "Acme Falcon radar lidar optical infrared telemetry prototype maritime",
    }),
    article("c", {
      title:
        "Acme Falcon radar lidar optical infrared telemetry maritime navigation",
    }),
  ];
  const result = buildStories(articles);
  assert.equal(result.groups.length, 0);
  assert.equal(result.related.length, 3);
  assert.deepEqual(buildStories([...articles].reverse()), result);
});

test("every member of a three-source group must fit the publication window", () => {
  const articles = [
    article("a", { publishedAt: "2026-09-01" }),
    article("b", { publishedAt: "2026-09-07" }),
    article("c", { publishedAt: "2026-09-13" }),
  ];
  assert.deepEqual(
    buildStories(articles).groups.map(({ articleIds }) => articleIds),
    [["a", "b"]],
  );
});

test("manual separation preserves relations and leaves remaining compatible sources grouped", () => {
  const articles = [article("a"), article("b"), article("c")];
  const result = buildStories(articles, new Set(["b"]));
  assert.deepEqual(
    result.groups.map(({ articleIds }) => articleIds),
    [["a", "c"]],
  );
  assert.deepEqual(
    result.related.map(({ articleIds }) => articleIds),
    [
      ["a", "b"],
      ["b", "c"],
    ],
  );
  assert.ok(
    result.related.every(({ reason }) => reason.includes("votre choix")),
  );
  assert.equal(buildStories(articles).groups[0].articleIds.length, 3);
});

test("an empty feed and duplicate input IDs never create singleton or duplicate groups", () => {
  assert.deepEqual(buildStories([]), { groups: [], related: [] });
  assert.deepEqual(buildStories([article("a"), article("a")]), {
    groups: [],
    related: [],
  });
  assert.deepEqual(
    buildStories([article("a"), article("b"), article("a")]).groups[0]
      .articleIds,
    ["a", "b"],
  );
});

test("changed named actors and reversed transaction directions cannot group", () => {
  for (const [first, second] of [
    [
      "AeroTech unveils Falcon drone for border reconnaissance missions",
      "SkyWorks unveils Falcon drone for border reconnaissance missions",
    ],
    [
      "Ukraine exports Falcon drones to Poland",
      "Poland exports Falcon drones to Ukraine",
    ],
    [
      "Falcon drones sent from Poland to Ukraine",
      "Falcon drones sent to Poland from Ukraine",
    ],
  ])
    assertRelated(
      article("a", { title: first }),
      article("b", { title: second }),
    );
});

test("reversed actors in available text cannot be hidden by an identical title", () => {
  assertRelated(
    article("a", { excerpt: "Acme purchases Falcon technology from Boreal." }),
    article("b", { excerpt: "Boreal purchases Falcon technology from Acme." }),
  );
});

test("full comparison text protects details beyond a truncated excerpt", () => {
  const excerpt = "Acme demonstrated the Falcon prototype.";
  const a: StoryArticle = {
    ...article("a", { excerpt }),
    comparisonText: `${excerpt} The sensor uses infrared.`,
  };
  const b: StoryArticle = {
    ...article("b", { excerpt }),
    comparisonText: `${excerpt} The sensor uses radar.`,
  };
  assert.equal(buildStories([a, b]).groups.length, 0);
  assert.equal(buildStories([a, b]).related.length, 1);
  assert.equal(
    buildStories([a, { ...b, comparisonText: a.comparisonText }]).groups.length,
    1,
  );
});

test("signed numerical facts stay distinct", () => {
  assertRelated(
    article("a", {
      title: "Acme Falcon reconnaissance drone operates at -10 degrees",
    }),
    article("b", {
      title: "Acme Falcon reconnaissance drone operates at 10 degrees",
    }),
  );
});
