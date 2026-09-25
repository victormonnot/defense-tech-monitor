import assert from "node:assert/strict";
import test from "node:test";
import {
  FEED_PRESETS,
  GENERAL_FEED,
  GENERAL_FEED_ID,
  parseFeedInput,
} from "../src/lib/custom-feeds";

test("general and suggested feeds are valid independent starting configurations", () => {
  assert.equal(GENERAL_FEED_ID, "general");
  assert.deepEqual(parseFeedInput(GENERAL_FEED), GENERAL_FEED);
  assert.deepEqual(
    FEED_PRESETS.map((feed) => feed.id),
    ["drones", "ukraine", "startups"],
  );
  assert.equal(new Set(FEED_PRESETS.map((feed) => feed.instructions)).size, 3);
  for (const { id, ...feed } of FEED_PRESETS) {
    assert.notEqual(id, GENERAL_FEED_ID);
    assert.deepEqual(parseFeedInput(feed), feed);
    assert.equal(feed.minScore, 1.5);
    assert.equal(feed.minConfidence, 0.6);
    assert.equal(feed.enabled, true);
  }
});

test("editable feed fields support Unicode and multiline briefs without accepting persistence metadata", () => {
  const input = {
    ...GENERAL_FEED,
    id: "forged-id",
    isGeneral: true,
    archived: true,
    revision: 99,
    analysis: { ready: 999, pending: 0, failed: 0 },
    name: "  Déploiements робота 🤖  ",
    instructions:
      "  Suivre les évolutions.\nInclure :\n\tles besoins des utilisateurs.  ",
    exclusions: "  Bruit médiatique\r\nRépétitions sans nouvel apport  ",
  };
  const parsed = parseFeedInput(input);
  assert.deepEqual(parsed, {
    name: "Déploiements робота 🤖",
    instructions:
      "Suivre les évolutions.\nInclure :\n\tles besoins des utilisateurs.",
    exclusions: "Bruit médiatique\r\nRépétitions sans nouvel apport",
    minScore: 1.5,
    minConfidence: 0.6,
    sort: "relevance",
    enabled: true,
  });
  assert.equal(input.name, "  Déploiements робота 🤖  ");
  assert.equal(
    parseFeedInput({ ...GENERAL_FEED, name: "Cafe\u0301" }).name,
    "Café",
  );
});

test("feed validation enforces text bounds without truncating user intent", () => {
  const maximum = {
    ...GENERAL_FEED,
    name: "n".repeat(80),
    instructions: "i".repeat(4000),
    exclusions: "e".repeat(2000),
  };
  assert.deepEqual(parseFeedInput(maximum), maximum);
  assert.equal(
    parseFeedInput({ ...GENERAL_FEED, exclusions: "" }).exclusions,
    "",
  );
  for (const change of [
    { name: "" },
    { name: "  " },
    { name: "n".repeat(81) },
    { instructions: "" },
    { instructions: "\n\t " },
    { instructions: "i".repeat(4001) },
    { exclusions: "e".repeat(2001) },
    { name: 1 },
    { instructions: ["drones"] },
    { exclusions: null },
  ])
    assert.throws(() => parseFeedInput({ ...GENERAL_FEED, ...change }));
});

test("control characters cannot be hidden in feed names or instructions", () => {
  for (const field of ["name", "instructions", "exclusions"] as const) {
    for (const control of [
      "\u0000",
      "\u0007",
      "\u000b",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u202e",
      "\u2066",
    ]) {
      assert.throws(
        () =>
          parseFeedInput({ ...GENERAL_FEED, [field]: `before${control}after` }),
        /contrôle/,
        `${field} with ${JSON.stringify(control)}`,
      );
    }
  }
  for (const control of ["\n", "\r", "\t"]) {
    assert.throws(() =>
      parseFeedInput({ ...GENERAL_FEED, name: `before${control}after` }),
    );
  }
});

test("scores, confidence, activation and sorting are validated without coercion", () => {
  assert.equal(
    parseFeedInput({ ...GENERAL_FEED, minScore: 0, minConfidence: 0 }).minScore,
    0,
  );
  assert.equal(
    parseFeedInput({ ...GENERAL_FEED, minScore: 3, minConfidence: 1 })
      .minConfidence,
    1,
  );
  assert.equal(
    parseFeedInput({ ...GENERAL_FEED, minScore: 1.75, minConfidence: 0.65 })
      .minScore,
    1.75,
  );
  assert.equal(
    parseFeedInput({ ...GENERAL_FEED, sort: "date", enabled: false }).sort,
    "date",
  );
  for (const change of [
    { minScore: -0.1 },
    { minScore: 3.01 },
    { minScore: NaN },
    { minScore: Infinity },
    { minScore: "1.5" },
    { minScore: null },
    { minScore: true },
    { minConfidence: -0.01 },
    { minConfidence: 1.01 },
    { minConfidence: NaN },
    { minConfidence: Infinity },
    { minConfidence: "0.6" },
    { minConfidence: null },
    { enabled: "true" },
    { enabled: 1 },
    { enabled: null },
    { sort: "popular" },
    { sort: null },
  ])
    assert.throws(() => parseFeedInput({ ...GENERAL_FEED, ...change }));
  for (const value of [
    null,
    undefined,
    true,
    "feed",
    [],
    {},
    { ...GENERAL_FEED, enabled: undefined },
  ]) {
    assert.throws(() => parseFeedInput(value));
  }
});
