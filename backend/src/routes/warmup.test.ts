// Run with: npm test
//
// Same "call the handler function directly with fake req/res" convention
// as routes/mealPlan.test.ts. A VALID /api/warmup request is deliberately
// NOT exercised here, even though handleWarmup itself is safe to call
// (see its own header comment) — a real call synchronously kicks off
// ensureWarmupStarted, which fires the REAL Kroger/Aldi/Sprouts/Trader
// Joe's warm functions in the background. Those hit live network (no
// mocking seam exists for them — same reason warmupService.test.ts's own
// header comment gives for never calling runWarmup directly), which is
// unsafe for a unit test regardless of how fast the response itself
// returns: it was observed to leave real, un-awaited network calls
// running for 30+ seconds after the test process's own assertions had
// already passed. What IS covered here is fully network-free: the fast-
// reject path (never reaches ensureWarmupStarted at all) and
// handleHealth (never calls it in the first place).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { handleWarmup } from './warmup.ts';
import { handleHealth } from './health.ts';

function fakeReq(body: unknown = {}): Request {
  return { body } as Request;
}

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
}

function fakeRes(): Response & FakeRes {
  const res: FakeRes & { status: (code: number) => Response; json: (body: unknown) => Response } = {
    statusCode: 200,
    jsonBody: undefined,
    status(code: number) {
      res.statusCode = code;
      return res as unknown as Response;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res as unknown as Response;
    },
  };
  return res as unknown as Response & FakeRes;
}

test('handleWarmup rejects a malformed zipcode with 400, without ever starting a warm-up', () => {
  const res = fakeRes();
  handleWarmup(fakeReq({ zipcode: 'not-a-zip' }), res);
  assert.equal(res.statusCode, 400);
});

test('handleHealth responds synchronously with a plain ok status, no warm-up side effect', () => {
  const res = fakeRes();
  handleHealth(fakeReq({}), res);
  const body = res.jsonBody as { status: string; backendStatus: string; uptimeMs: number };
  assert.equal(body.status, 'ok');
  assert.ok(['starting', 'warming', 'ready'].includes(body.backendStatus));
  assert.ok(body.uptimeMs >= 0);
});
