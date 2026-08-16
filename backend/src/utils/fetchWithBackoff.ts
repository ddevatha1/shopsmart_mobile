/**
 * A thin `fetch` wrapper that retries only HTTP 429 (rate-limited)
 * responses, with exponential backoff (honoring a numeric `Retry-After`
 * header when the server sends one) plus jitter. Every other outcome —
 * success, or any non-429 error status — returns immediately on the first
 * attempt, unchanged from a plain `fetch` call; callers keep doing their
 * own `res.ok` handling exactly as before.
 *
 * Built for Sprouts' anonymous session bootstrap (a real, observed
 * "homepage returned HTTP 429" in production — likely Render's shared
 * outbound IP range tripping Instacart-platform rate limiting), and reused
 * for the search request itself since it hits the same platform. Kept
 * generic/shared rather than Sprouts-specific in case Aldi (same
 * Instacart-backed platform) ever needs it too — not wired in there now,
 * since preserving Aldi's current behavior unchanged was an explicit
 * requirement here.
 */
export interface FetchWithBackoffOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function fetchWithBackoff(
  url: string,
  init: RequestInit | undefined,
  options: FetchWithBackoffOptions = {},
): Promise<Response> {
  const { retries = 3, baseDelayMs = 400, maxDelayMs = 4000 } = options;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= retries) return res;

    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader) * 1000
      : null;
    const backoffMs = Math.min(retryAfterMs ?? baseDelayMs * 2 ** attempt, maxDelayMs);
    const jitterMs = Math.random() * 150;

    // Drain the body so the underlying connection can be reused/closed
    // cleanly before retrying — leaving a 429 body unread is harmless but
    // wasteful across repeated retries.
    await res.text().catch(() => undefined);
    console.log(`[fetchWithBackoff] 429 from ${url} — retrying in ${Math.round(backoffMs + jitterMs)}ms (attempt ${attempt + 1}/${retries})`);
    await new Promise(resolve => setTimeout(resolve, backoffMs + jitterMs));
  }
}
