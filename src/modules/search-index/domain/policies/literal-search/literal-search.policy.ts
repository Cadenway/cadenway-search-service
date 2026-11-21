const maximumGramWidth = 3;
const codeUnitBase = 2 ** 16;

/**
 * Normalizes a validated palette query as in the Ctrl+K mockup (App.dc.html).
 * The route owns the rules for rejecting blank or oversized input.
 */
export function normalizeLiteralSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Builds filter-safe terms from a name and optional task key, as matched by GET /v1/search.
 * The filter only selects candidates. Exact matching remains required before disclosure.
 */
export function buildLiteralSearchIndexTerms(name: string, taskKey?: string): readonly string[] {
  const text = literalSearchText(name, taskKey);
  const terms = new Set<string>();
  for (let width = 1; width <= maximumGramWidth; width++) {
    for (let offset = 0; offset <= text.length - width; offset++) {
      terms.add(encodeGram(text, offset, width));
    }
  }
  return [...terms];
}

/**
 * Selects up to three terms that every literal palette match must contain.
 * These terms can be combined by AND. A blank normalized query returns no terms.
 */
export function literalSearchProbeTerms(normalizedQuery: string): readonly string[] {
  if (normalizedQuery.length === 0) return [];

  const width = Math.min(normalizedQuery.length, maximumGramWidth);
  const lastOffset = normalizedQuery.length - width;
  const offsets = [0, Math.floor(lastOffset / 2), lastOffset];
  return [...new Set(offsets.map((offset) => encodeGram(normalizedQuery, offset, width)))];
}

/** Tests exact nonblank palette matches per GET /v1/search, retaining accents and punctuation. */
export function matchesLiteralSearch(
  normalizedQuery: string,
  name: string,
  taskKey?: string,
): boolean {
  return normalizedQuery.length > 0 && literalSearchText(name, taskKey).includes(normalizedQuery);
}

function literalSearchText(name: string, taskKey: string | undefined): string {
  const label = taskKey === undefined ? name : `${name} ${taskKey}`;
  return label.toLowerCase();
}

// UTF-16 windows preserve String.includes even for supplementary pairs and short fragments.
// Three 16-bit units fit exactly in a JS number. The width prefix distinguishes leading zeros.
function encodeGram(text: string, offset: number, width: number): string {
  let value = 0;
  for (let index = offset; index < offset + width; index++) {
    value = value * codeUnitBase + text.charCodeAt(index);
  }
  return `g${width.toString(10)}${value.toString(36)}`;
}
