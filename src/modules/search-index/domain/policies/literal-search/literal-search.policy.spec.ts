import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildLiteralSearchIndexTerms,
  literalSearchProbeTerms,
  matchesLiteralSearch,
  normalizeLiteralSearchQuery,
} from './literal-search.policy.js';

describe('literal palette matching', () => {
  it('matches the task name and key joined by one space', () => {
    const query = normalizeLiteralSearchQuery('   SSO CAD-4  ');
    expect(query).toBe('sso cad-4');
    expect(matchesLiteralSearch(query, 'Refondre l’écran de connexion SSO', 'CAD-482')).toBe(true);
    expect(matchesLiteralSearch(query, 'Refondre l’écran de connexion SSO')).toBe(false);
    expect(matchesLiteralSearch('sso  cad-4', 'connexion SSO', 'CAD-482')).toBe(false);
  });

  it('matches an interior substring of a list name while keeping accents literal', () => {
    expect(matchesLiteralSearch(normalizeLiteralSearchQuery('  RINT 1  '), 'Sprint 14')).toBe(true);
    expect(matchesLiteralSearch(normalizeLiteralSearchQuery('écran'), 'Écran de connexion')).toBe(
      true,
    );
    expect(matchesLiteralSearch('ecran', 'Écran de connexion')).toBe(false);
    expect(matchesLiteralSearch('', 'Sprint 14')).toBe(false);
  });

  it('uses the same case conversion for supplementary letters, expansions and final sigma', () => {
    const name = 'Projet 𐐀 İ ΟΣ 😀';
    const terms = new Set(buildLiteralSearchIndexTerms(name));
    for (const text of ['𐐨', 'i\u0307', 'ος', '😀', '\ud83d']) {
      const query = normalizeLiteralSearchQuery(text);
      expect(matchesLiteralSearch(query, name)).toBe(true);
      expect(literalSearchProbeTerms(query).every((term) => terms.has(term))).toBe(true);
    }
  });

  it('returns at most three distinct filter-safe terms even for a long query', () => {
    expect(literalSearchProbeTerms('')).toEqual([]);
    expect(literalSearchProbeTerms('a'.repeat(200))).toHaveLength(1);

    const terms = literalSearchProbeTerms('É[quote" 𐐨'.repeat(20).toLowerCase());
    expect(terms).toHaveLength(3);
    for (const term of terms) expect(term).toMatch(/^g[123][0-9a-z]+$/u);
  });

  it('requires an exact match even when every filter term occurs separately', () => {
    const query = 'abcdef';
    const name = 'abc / bcd / def';
    const terms = buildLiteralSearchIndexTerms(name);
    expect(literalSearchProbeTerms(query).every((term) => terms.includes(term))).toBe(true);
    expect(matchesLiteralSearch(query, name)).toBe(false);
  });

  it('indexes necessary terms for every normalized substring of mixed Unicode text', () => {
    const label = fc
      .array(fc.constantFrom('É', 'ß', 'Σ', 'Ι', 'İ', '𐐀', '😀', 'a', '.', ' ', '\u0301', '\u0000'))
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(label, fc.nat(), fc.nat(), (name, offset, length) => {
        const taskKey = 'CAD-482';
        const searchable = `${name} ${taskKey}`.toLowerCase();
        const start = offset % searchable.length;
        const end = start + 1 + (length % (searchable.length - start));
        const query = normalizeLiteralSearchQuery(searchable.slice(start, end));
        if (query.length === 0) return;

        expect(matchesLiteralSearch(query, name, taskKey)).toBe(searchable.includes(query));
        const indexed = new Set(buildLiteralSearchIndexTerms(name, taskKey));
        const probes = literalSearchProbeTerms(query);
        expect(probes.length).toBeGreaterThan(0);
        expect(probes.length).toBeLessThanOrEqual(3);
        expect(probes.every((probe) => indexed.has(probe))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
