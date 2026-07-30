/**
 * POST /api/vision/quality-assess — AI Product Quality Scanner (Feature 1)
 * + optional expiration-date detection (Feature 2). A domain service
 * endpoint, same shape as /api/meal-plan: this route only ever calls the
 * vision-LLM boundary (services/visionQualityService.ts) and validates its
 * output (services/visionQualityValidation.ts) — no cart mutation, no
 * other side effects. When the LLM tier isn't configured (no
 * LLM_API_KEY), this feature is honestly unavailable rather than
 * fabricating a verdict — see `getConfiguredVisionProvider`.
 */
import type { Request, Response } from 'express';
import type { VisionQualityRequest } from '../types/index.ts';
import { getConfiguredVisionProvider } from '../services/visionQualityService.ts';
import { validateVisionQualityOutput } from '../services/visionQualityValidation.ts';

// A base64 JPEG this small (~15MB of base64 text) already covers a much
// higher-resolution photo than a vision model needs — this is a sanity
// ceiling against a malformed/huge payload, not a real quality target
// (the mobile client already captures at a compressed quality setting).
const MAX_IMAGE_BASE64_LENGTH = 15_000_000;

export async function handleVisionQuality(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<VisionQualityRequest>;

  if (typeof body.image !== 'string' || body.image.length === 0) {
    res.status(400).json({ error: '`image` (base64 JPEG) must be a non-empty string.' });
    return;
  }
  if (body.image.length > MAX_IMAGE_BASE64_LENGTH) {
    res.status(400).json({ error: '`image` is too large.' });
    return;
  }
  if (body.productNameHint !== undefined && typeof body.productNameHint !== 'string') {
    res.status(400).json({ error: '`productNameHint`, when present, must be a string.' });
    return;
  }

  const provider = getConfiguredVisionProvider();
  if (!provider) {
    res.status(503).json({ error: 'Quality check is not available right now.' });
    return;
  }

  try {
    const raw = await provider({ image: body.image, productNameHint: body.productNameHint });
    const result = validateVisionQualityOutput(raw);
    if (!result) {
      res.status(502).json({ error: 'Could not get a reliable quality check for this photo. Please try again.' });
      return;
    }
    res.json(result);
  } catch {
    // Timeout, rate limit, provider error, malformed JSON — all treated
    // identically: the same honest "unavailable right now" the route
    // already reports when the feature isn't configured at all, never a
    // raw internal error surfaced to a shopper.
    res.status(503).json({ error: 'Quality check is not available right now.' });
  }
}
