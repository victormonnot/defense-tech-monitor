function normalizeSearchText(value: string) {
  return (
    value
      .normalize("NFD")
      // Fold Latin accents without conflating distinct Cyrillic letters (й/и, ї/і).
      .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
      .normalize("NFC")
      .toLocaleLowerCase("fr-FR")
  );
}

/** Every query word must occur in the supplied fields, in any order. */
export function createSearchMatcher(query: string) {
  const words = normalizeSearchText(query).trim().split(/\s+/u).filter(Boolean);
  return (fields: readonly (string | null | undefined)[]): boolean => {
    if (!words.length) return true;
    const text = normalizeSearchText(fields.filter(Boolean).join(" "));
    return words.every((word) => text.includes(word));
  };
}
