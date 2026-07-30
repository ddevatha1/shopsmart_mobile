/**
 * Strict, backend-side validation of raw vision-LLM output — the same
 * "never trust raw provider JSON" discipline as
 * intentClassifierValidation.ts's `validateClassifierOutput`, applied to
 * the quality-scanner boundary instead of the intent-router one. Every
 * check fails closed: the first thing that doesn't check out means "no
 * verdict," never a partially-trusted result assembled from whatever
 * parts of a malformed response DID validate.
 */
import type { ProductQualityVerdict, VisionQualityResult } from '../types/index.ts';

const VALID_VERDICTS: ReadonlySet<string> = new Set<ProductQualityVerdict>(['good', 'caution', 'avoid']);

// A verdict this app will actually surface is a short sentence, not a
// paragraph — see this file's header requirement ("Very short.
// Action-oriented.") in the product brief. A wildly long response is
// treated as untrustworthy output (the model ignored its instructions),
// not truncated and shown anyway.
const MAX_EXPLANATION_LENGTH = 240;

// Phrases this app's system prompt explicitly forbids (see
// visionQualityService.ts's system prompt: "never say food is safe/unsafe").
// A response using one of these is rejected outright rather than shown —
// silently truncating or rewriting a model's own words would risk leaving
// a real unsafe-claim sentence fragment visible.
const FORBIDDEN_PHRASES = ['safe to eat', 'unsafe to eat', 'is safe', 'is unsafe', 'not safe', 'is spoiled', 'is rotten'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsForbiddenClaim(explanation: string): boolean {
  const lower = explanation.toLowerCase();
  return FORBIDDEN_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Turns raw, untyped vision-LLM output into a safe `VisionQualityResult`,
 * or `null` if the input doesn't earn trust (the caller reports "quality
 * check unavailable," never a guessed verdict). Never throws — any shape
 * of `raw`, including `null`, primitives, and arrays, returns `null`
 * rather than crashing the request.
 */
export function validateVisionQualityOutput(raw: unknown): VisionQualityResult | null {
  if (!isPlainObject(raw)) return null;

  const { verdict, explanation } = raw;
  if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict)) return null;
  if (typeof explanation !== 'string' || explanation.trim().length === 0) return null;
  if (explanation.length > MAX_EXPLANATION_LENGTH) return null;
  if (containsForbiddenClaim(explanation)) return null;

  const result: VisionQualityResult = { verdict: verdict as ProductQualityVerdict, explanation: explanation.trim() };

  // detectedExpirationDate is optional and, when present, only ever a
  // short real string the model read off the packaging — never trusted
  // if the shape is wrong, and never invented if absent.
  if (typeof raw.detectedExpirationDate === 'string' && raw.detectedExpirationDate.trim().length > 0
    && raw.detectedExpirationDate.length <= 40) {
    result.detectedExpirationDate = raw.detectedExpirationDate.trim();
  }

  return result;
}
