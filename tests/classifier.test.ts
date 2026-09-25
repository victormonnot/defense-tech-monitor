import assert from "node:assert/strict";
import test from "node:test";
import { containsTerm, rulesClassifier } from "../src/lib/classifier";
import type { Profile } from "../src/lib/types";

const profile = (
  keywords: string[],
  excludeKeywords: string[] = [],
): Profile => ({ keywords, excludeKeywords, minScore: 1 });

test("terms use Unicode word boundaries rather than matching inside other words", () => {
  assert.equal(containsTerm("Ukraine research bulletin", "AI"), false);
  assert.equal(containsTerm("A robotics repair bulletin", "AI"), false);
  assert.equal(containsTerm("préIApost", "AI"), false);
  assert.equal(containsTerm("New AI-based navigation", "AI"), true);
  assert.equal(containsTerm("Новий робот працює", "робот"), true);
  assert.equal(containsTerm("роботизація", "робот"), false);
});

test("matching handles accents, case, plurals and literal regular-expression characters", () => {
  assert.equal(containsTerm("AUTONOMIE et perception", "autonomie"), true);
  assert.equal(containsTerm("Système embarqué", "systeme embarque"), true);
  assert.equal(containsTerm("Several drones", "drone"), true);
  assert.equal(containsTerm("C++ software", "C++"), true);
  assert.equal(containsTerm("Anything at all", ".*"), false);
  assert.equal(containsTerm("Anything at all", "  "), false);
});

test("relevance counts matching profile terms once and explains the score", () => {
  const result = rulesClassifier.classify(
    "Drone, drone, drone with autonomous navigation.",
    profile(["drone", "autonomous", "robot"]),
  );
  assert.equal(result.score, 2);
  assert.deepEqual(result.reasons, ["Mot-clé : drone", "Mot-clé : autonomous"]);
  assert.ok(result.themes.includes("Drones"));
  assert.ok(result.themes.includes("Autonomie"));
  assert.ok(result.themes.includes("Perception & navigation"));
});

test("exclusions override relevance without erasing topic classification", () => {
  const result = rulesClassifier.classify(
    "A drone simulator game",
    profile(["drone"], ["game"]),
  );
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ["Exclusion : game"]);
  assert.ok(result.themes.includes("Drones"));
});

test("themes and relevance remain independent when the profile changes", () => {
  const text = "A fixture about autonomous robots.";
  const before = rulesClassifier.classify(text, profile(["funding"]));
  const after = rulesClassifier.classify(
    text,
    profile(["autonomous", "robot"]),
  );
  assert.equal(before.score, 0);
  assert.equal(after.score, 2);
  assert.deepEqual(after.themes, before.themes);
  assert.ok(after.themes.includes("Robotique"));
});

test("unmatched text receives no fabricated topics or relevance", () => {
  const result = rulesClassifier.classify(
    "Fixture weather bulletin from Ukraine.",
    profile(["AI"]),
  );
  assert.equal(result.score, 0);
  assert.deepEqual(result.themes, []);
  assert.deepEqual(result.reasons, ["Aucun mot-clé du profil"]);
});
