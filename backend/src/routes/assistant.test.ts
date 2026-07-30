// Run with: npm test
//
// Tests handleAssistantIntent directly with hand-built fake Express
// req/res objects — no supertest, no new dependency, same "call the
// handler function directly" convention this backend already has no
// precedent against (this is the first route-level test file; see
// package.json's test glob, extended this sprint to cover src/routes/).
//
// The handler is async as of Phase 4.1 (it now calls resolveHybridIntent)
// — every test awaits it. No LLM_API_KEY is set in this test environment,
// so the hybrid resolver's LLM tier is always skipped; these tests still
// exercise exactly the same deterministic-tier behavior as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { handleAssistantIntent } from './assistant.ts';

function fakeReq(body: unknown): Request {
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

test('valid text returns a real, classified intent with a 200', async () => {
  const res = fakeRes();
  await handleAssistantIntent(fakeReq({ text: 'find apples' }), res);
  assert.equal(res.statusCode, 200);
  const body = res.jsonBody as { intent: { type: string } };
  assert.equal(body.intent.type, 'search');
});

test('empty text resolves to an unknown intent — a normal 200, not a validation error', async () => {
  const res = fakeRes();
  await handleAssistantIntent(fakeReq({ text: '' }), res);
  assert.equal(res.statusCode, 200);
  const body = res.jsonBody as { intent: { type: string; confidence: number } };
  assert.equal(body.intent.type, 'unknown');
  assert.equal(body.intent.confidence, 0);
});

test('a missing/non-string `text` field is rejected with 400, never silently defaulted', async () => {
  const res = fakeRes();
  await handleAssistantIntent(fakeReq({}), res);
  assert.equal(res.statusCode, 400);

  const resWrongType = fakeRes();
  await handleAssistantIntent(fakeReq({ text: 42 }), resWrongType);
  assert.equal(resWrongType.statusCode, 400);
});

test('the route response is ONLY ever { intent } — it never executes an action or returns anything else', async () => {
  const res = fakeRes();
  await handleAssistantIntent(fakeReq({ text: 'add milk to cart' }), res);
  const body = res.jsonBody as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['intent']);
  // Classified correctly, but nothing beyond classification: no
  // `success`, `data`, `result`, or any sign a cart/search/planner call
  // happened — this route only ever calls resolveHybridIntent.
  assert.equal((body.intent as { type: string }).type, 'add_to_cart');
});

test('a well-formed context object is accepted', async () => {
  const res = fakeRes();
  await handleAssistantIntent(fakeReq({ text: 'find apples', context: { currentScreen: 'Search' } }), res);
  assert.equal(res.statusCode, 200);
});

test('a malformed context is rejected with 400', async () => {
  const res = fakeRes();
  await handleAssistantIntent(fakeReq({ text: 'find apples', context: 'not-an-object' }), res);
  assert.equal(res.statusCode, 400);

  const resBadScreen = fakeRes();
  await handleAssistantIntent(fakeReq({ text: 'find apples', context: { currentScreen: 42 } }), resBadScreen);
  assert.equal(resBadScreen.statusCode, 400);
});
