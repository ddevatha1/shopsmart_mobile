// Shared text-formatting helpers used by every live store integration to
// normalize inconsistently-cased product/brand names and to derive a
// deterministic per-product seed for rating/review-count generation.

const LOWERCASE_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor',
  'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'with',
]);

export function toTitleCase(str: string): string {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim().split(' ')
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && LOWERCASE_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
