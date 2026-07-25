/**
 * Watches a page's live network traffic during a search and collects every
 * XHR/fetch JSON response — the raw material ProductExtractor.ts sifts
 * through afterward. Deliberately knows nothing about what a "product API"
 * looks like; that judgment belongs to ProductExtractor, not here. This
 * class's only job is "is this worth handing over at all" (an XHR/fetch
 * response, JSON content, a sane size) — non-JSON responses (images,
 * documents, analytics beacons) and oversized bodies are dropped at capture
 * time so a chatty page can't balloon memory or slow extraction down with
 * megabytes of unrelated payloads.
 */
import type { Page, Response } from 'playwright';
import type { CapturedResponse } from './types.ts';

// Plenty for a product-search JSON payload; small enough that a page with a
// large embedded blob (analytics snapshot, a bundled config dump) can't
// hoard memory during a single search.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export class NetworkCapture {
  readonly responses: CapturedResponse[] = [];
  private handler: ((response: Response) => Promise<void>) | null = null;
  private page: Page | null = null;

  attach(page: Page): void {
    const handler = async (response: Response): Promise<void> => {
      try {
        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

        const contentType = response.headers()['content-type'] ?? '';
        if (!contentType.includes('json')) return;

        const body = await response.body().catch(() => null);
        if (!body || body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) return;

        const json = JSON.parse(body.toString('utf-8'));
        this.responses.push({ url: response.url(), method: request.method(), status: response.status(), json });
      } catch {
        // Not valid JSON, body already consumed, or the page navigated away
        // mid-read — none of these are recoverable or worth surfacing;
        // just skip this one response.
      }
    };
    this.page = page;
    this.handler = handler;
    page.on('response', handler);
  }

  stop(): void {
    if (this.page && this.handler) this.page.off('response', this.handler);
    this.page = null;
    this.handler = null;
  }
}
