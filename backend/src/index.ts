import express from 'express';
import cors from 'cors';
import type { ErrorRequestHandler } from 'express';
import { handleSearch } from './routes/search.ts';
import { handleProductImage } from './routes/productImage.ts';
import { handleTrip } from './routes/trip.ts';
import { handleWarmup } from './routes/warmup.ts';
import { handlePlanner } from './routes/planner.ts';
import { handleAssistantIntent } from './routes/assistant.ts';
import { handleMealPlan } from './routes/mealPlan.ts';
import { handleVisionQuality } from './routes/visionQuality.ts';
import { runWarmup } from './services/warmupService.ts';
import { perfLog } from './utils/perfLog.ts';

const app = express();

app.use(cors());

// A base64-encoded, compressed grocery photo (see the mobile client's
// imageCompressionService.ts) is still meaningfully larger than every
// other route's tiny JSON body — this MUST be registered, with its own
// larger-limit express.json(), BEFORE the global express.json() below.
//
// Root cause of a real, confirmed 413 bug: Express runs middleware in
// registration order. The global parser used to be registered first (a
// plain `app.use(express.json())`, Express's default ~100kb limit) and
// so it consumed/rejected every request body — including this route's —
// before this route's own, larger-limit parser ever got a chance to run.
// A route-specific parser registered AFTER a matching global one is
// simply never reached for an oversized body; the fix is registration
// order, not just a bigger number.
app.post('/api/vision/quality-assess', express.json({ limit: '8mb' }), handleVisionQuality);

app.use(express.json());

app.post('/api/search', handleSearch);
app.get('/api/product-image', handleProductImage);
app.post('/api/trip', handleTrip);
app.post('/api/warmup', handleWarmup);
app.post('/api/planner', handlePlanner);
app.post('/api/assistant/intent', handleAssistantIntent);
app.post('/api/meal-plan', handleMealPlan);

function isPayloadTooLargeError(err: unknown): err is { type?: string; status?: number } {
  return !!err && typeof err === 'object' && ((err as { type?: string }).type === 'entity.too.large');
}

// express.json() throws a SyntaxError for unparseable bodies, and a
// distinct (non-Error-subclass) "entity.too.large" error for an oversized
// one — mirror the web route's `Invalid JSON body.` response instead of
// Express's default HTML for the former, and a plain, actionable message
// instead of a raw "413 Payload Too Large" for the latter.
const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }
  if (isPayloadTooLargeError(err)) {
    const message = req.path === '/api/vision/quality-assess'
      ? 'Image is too large. Please try taking another photo.'
      : 'Request body is too large.';
    res.status(413).json({ error: message });
    return;
  }
  next(err);
};
app.use(jsonErrorHandler);

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`CartIQ_mobile backend listening on http://localhost:${PORT}`);
  perfLog('server:listening');

  // Fire-and-forget: pre-warm everything that doesn't depend on a shopper's
  // zip (Kroger token, Aldi/Sprouts sessions, Trader Joe's browser session
  // + store directory) as soon as the process is up, so the very first
  // request the server ever handles doesn't pay for it. Never awaited here
  // — a slow or failed warm-up must not delay/prevent the server from
  // accepting requests; see warmupService.ts.
  runWarmup().catch((err) => {
    console.error('[Warmup] Unhandled error during server-boot warm-up:', err);
  });
});
