/**
 * Ranks browser-extracted products against the shopper's actual search
 * query. This app already has a fuzzy/semantic relevance scorer for
 * exactly this job — `computeRelevance`/`classifyMatch` in
 * searchService.ts, used to rank and classify results from every direct-API
 * store — reused here rather than reimplemented, per this framework's
 * "don't trust the website's own search" principle: once ProductExtractor
 * finds *any* product-shaped array on a page (a real product list, but not
 * necessarily the shopper's search results — a "recommended for you" rail
 * matches just as well), something still has to decide which of those
 * products actually answer the query. That's this file's job, and it's the
 * same judgment call the rest of this app's search pipeline already makes.
 */
import { computeRelevance, classifyMatch } from '../searchService.ts';
import type { BrowserProduct, RankedProduct } from './types.ts';

// Same 0-100 scale computeRelevance already uses — filters out
// coincidental field-name matches with essentially no real relevance to
// the query (e.g. a "recommended" item that shares one common word).
const MIN_RELEVANCE_SCORE = 15;

export function rankProducts(query: string, products: BrowserProduct[]): RankedProduct[] {
  const ranked: RankedProduct[] = products
    .map(product => {
      const relevance = computeRelevance(query, product.name);
      const matchType = classifyMatch(query, { name: product.name, category: product.category });
      return { product, relevanceScore: relevance / 100, matchType };
    })
    // A confirmed category match (e.g. "Honeycrisp" categorized as
    // "apples") is a real relevance signal in its own right, even when the
    // product's own name shares little text with the query — classifyMatch
    // already decided it's 'direct' for exactly that reason, so it must
    // survive here regardless of the name-similarity score alone.
    .filter(r => r.matchType === 'direct' || r.relevanceScore * 100 >= MIN_RELEVANCE_SCORE);

  ranked.sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === 'direct' ? -1 : 1;
    return b.relevanceScore - a.relevanceScore;
  });

  return ranked;
}
