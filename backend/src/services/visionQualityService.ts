/**
 * The vision-LLM boundary for the AI Product Quality Scanner (Feature 1)
 * and optional expiration-date detection (Feature 2) — the ONLY file in
 * this backend that may call an external vision-capable LLM provider for
 * this feature. Mirrors intentClassifierService.ts's own boundary
 * discipline: no SDK dependency (plain `fetch`, this app's established
 * convention), reuses the same LLM_API_KEY/LLM_API_URL/LLM_MODEL
 * environment configuration (the default model, gpt-4o-mini, is already
 * vision-capable — no separate provider decision needed), and returns raw,
 * UNVALIDATED output — see visionQualityValidation.ts's
 * `validateVisionQualityOutput`, the only place this is ever trusted.
 *
 * Hard safety rules, enforced by the system prompt below AND re-checked
 * independently by visionQualityValidation.ts (never trusted on the
 * prompt's word alone):
 *   - Never claim food is "safe" or "unsafe" — hedged language only
 *     ("appears", "may indicate", "visible signs suggest").
 *   - Very short, action-oriented response — a sentence, not a paragraph.
 *   - Expiration date is reported ONLY if genuinely visible in the photo
 *     — never guessed, never asked for separately.
 */
export interface VisionQualityInput {
  image: string; // base64 JPEG, no data URL prefix
  productNameHint?: string;
}

export type VisionProvider = (input: VisionQualityInput) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 8000; // a vision call is slower than text classification; still bounded

const QUALITY_SYSTEM_PROMPT = `You are a grocery product quality checker. You are given ONE photo of a single grocery item (e.g. a tomato, potato, or piece of fruit) and, optionally, the name the shopper believes it is.
Respond with ONLY a JSON object, no other text, shaped exactly like:
{ "verdict": "<one of: good, caution, avoid>", "explanation": "<one short sentence>", "detectedExpirationDate"?: "<short string, only if a real expiration/best-by date is visibly printed on packaging in the photo>" }
Rules:
- Evaluate only visible, physical signs: bruising, spots, discoloration, sprouting, mold, visible damage, ripeness.
- NEVER say a product "is safe" or "is unsafe" to eat, and never say it "is spoiled" or "is rotten" as a fact. Use hedged language only: "appears", "may indicate", "visible signs suggest".
- "explanation" must be ONE short, action-oriented sentence (e.g. "Looks good. Appears fresh with no major visible issues." or "Consider choosing another one. Visible soft spots may indicate reduced freshness.").
- Only include "detectedExpirationDate" if an actual printed date is visible in the photo. If none is visible, omit the field entirely — never guess one.
- Do not include reasoning, explanation of your process, or any text outside the JSON object.`;

/**
 * A real, working implementation — calls the same OpenAI-compatible chat
 * completions endpoint intentClassifierService.ts uses, with an image
 * content part added to the user message. Deliberately NOT wired in as
 * anyone's default without a configured key (see `getConfiguredVisionProvider`
 * below) — leaving LLM_API_KEY unset disables the entire feature (the
 * route reports "quality check unavailable"), exactly like the intent
 * classifier's own optional-LLM-tier convention. Never exercised by a
 * real network call in tests — every test injects a fake `VisionProvider`.
 */
export async function callVisionProvider(input: VisionQualityInput): Promise<unknown> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not configured.');
  }
  if (isOverVisionRateLimit()) {
    throw new Error(`Vision quality-check rate limit exceeded (${configuredRateLimit()}/min).`);
  }
  const apiUrl = process.env.LLM_API_URL ?? 'https://api.openai.com/v1/chat/completions';
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  const userText = input.productNameHint
    ? `The shopper believes this is: ${input.productNameHint}`
    : 'Evaluate this grocery item.';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: QUALITY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Vision provider returned HTTP ${res.status}`);
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Vision provider response missing message content.');
    }
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Cost control: same global-rate-limit pattern as intentClassifierService.ts,
// a separate counter since a vision call is a materially more expensive
// request than a text classification one. See that file's own comment for
// why a global (not per-shopper) limit is the right shape here — this
// route has no auth either.
const DEFAULT_VISION_RATE_LIMIT_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
let recentCallTimestamps: number[] = [];

function configuredRateLimit(): number {
  const raw = Number(process.env.VISION_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VISION_RATE_LIMIT_PER_MINUTE;
}

export function isOverVisionRateLimit(): boolean {
  const now = Date.now();
  recentCallTimestamps = recentCallTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recentCallTimestamps.length >= configuredRateLimit()) return true;
  recentCallTimestamps.push(now);
  return false;
}

export function resetVisionRateLimitForTests(): void {
  recentCallTimestamps = [];
}

/**
 * The one place `LLM_API_KEY`'s presence is checked for this feature.
 * Returns `undefined` when unconfigured — the route then reports the
 * feature as unavailable rather than attempting a call, same shape as
 * `intentClassifierService.ts`'s `getConfiguredClassifier`.
 */
export function getConfiguredVisionProvider(): VisionProvider | undefined {
  return process.env.LLM_API_KEY ? callVisionProvider : undefined;
}
