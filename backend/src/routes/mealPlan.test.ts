// Run with: npm test
//
// Same "call the handler function directly with fake req/res" convention
// as routes/assistant.test.ts — no supertest, no new dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { handleMealPlan } from './mealPlan.ts';

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

test('a valid request returns a real, deterministic meal plan with a 200', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 5, mealType: 'dinner' }), res);
  assert.equal(res.statusCode, 200);
  const body = res.jsonBody as { meals: unknown[]; groceryItems: string[] };
  assert.equal(body.meals.length, 5);
  assert.ok(body.groceryItems.length > 0);
});

test('mealType defaults to dinner when omitted', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 2 }), res);
  const body = res.jsonBody as { meals: { mealType: string }[] };
  assert.ok(body.meals.every((m) => m.mealType === 'dinner'));
});

test('a missing/invalid mealCount is rejected with 400', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({}), res);
  assert.equal(res.statusCode, 400);

  const resZero = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 0 }), resZero);
  assert.equal(resZero.statusCode, 400);
});

test('an invalid mealType is rejected with 400', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 3, mealType: 'lunch' }), res);
  assert.equal(res.statusCode, 400);
});

test('a non-string-array lowStockItems is rejected with 400', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 3, lowStockItems: [1, 2] }), res);
  assert.equal(res.statusCode, 400);
});

test('lowStockItems are folded in and surfaced as pantryAdditions', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 1, mealType: 'dinner', lowStockItems: ['rice'] }), res);
  const body = res.jsonBody as { pantryAdditions: string[] };
  assert.deepEqual(body.pantryAdditions, ['rice']);
});

test('mealCount above the cap is silently clamped, never a fabricated huge plan', () => {
  const res = fakeRes();
  handleMealPlan(fakeReq({ mealCount: 999, mealType: 'dinner' }), res);
  const body = res.jsonBody as { meals: unknown[] };
  assert.equal(body.meals.length, 14);
});
