// Run with: npm test
//
// Tests validateVisionQualityOutput — pure, synchronous, deterministic,
// no network. This is the one place raw vision-LLM output is ever
// trusted (or, in most of these tests, deliberately not trusted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVisionQualityOutput } from './visionQualityValidation.ts';

test('a well-formed, valid quality response is accepted as-is', () => {
  const result = validateVisionQualityOutput({
    verdict: 'good', explanation: 'Looks good. Appears fresh with no major visible issues.',
  });
  assert.deepEqual(result, { verdict: 'good', explanation: 'Looks good. Appears fresh with no major visible issues.' });
});

test('a valid response with a real detected expiration date carries it through', () => {
  const result = validateVisionQualityOutput({
    verdict: 'good', explanation: 'Looks fresh.', detectedExpirationDate: 'Aug 5',
  });
  assert.equal(result?.detectedExpirationDate, 'Aug 5');
});

test('an unrecognized verdict is rejected outright (returns null, never a guessed verdict)', () => {
  assert.equal(validateVisionQualityOutput({ verdict: 'excellent', explanation: 'Looks great.' }), null);
  assert.equal(validateVisionQualityOutput({ verdict: 'bad', explanation: 'Looks bad.' }), null);
});

test('a missing or empty explanation is rejected', () => {
  assert.equal(validateVisionQualityOutput({ verdict: 'good' }), null);
  assert.equal(validateVisionQualityOutput({ verdict: 'good', explanation: '' }), null);
  assert.equal(validateVisionQualityOutput({ verdict: 'good', explanation: '   ' }), null);
});

test('an explanation containing a forbidden safe/unsafe claim is rejected, even with a valid verdict', () => {
  assert.equal(validateVisionQualityOutput({ verdict: 'good', explanation: 'This product is safe to eat.' }), null);
  assert.equal(validateVisionQualityOutput({ verdict: 'avoid', explanation: 'This is unsafe to eat.' }), null);
  assert.equal(validateVisionQualityOutput({ verdict: 'avoid', explanation: 'This item is spoiled.' }), null);
});

test('an excessively long explanation is rejected rather than truncated and shown', () => {
  const longExplanation = 'This is a very long explanation. '.repeat(20);
  assert.equal(validateVisionQualityOutput({ verdict: 'good', explanation: longExplanation }), null);
});

test('an overly long detectedExpirationDate is dropped, but the rest of the result still validates', () => {
  const result = validateVisionQualityOutput({
    verdict: 'good', explanation: 'Looks fine.', detectedExpirationDate: 'x'.repeat(100),
  });
  assert.ok(result);
  assert.equal(result?.detectedExpirationDate, undefined);
});

test('a malformed detectedExpirationDate type is dropped silently, not fabricated as a string', () => {
  const result = validateVisionQualityOutput({ verdict: 'good', explanation: 'Looks fine.', detectedExpirationDate: 12345 });
  assert.ok(result);
  assert.equal(result?.detectedExpirationDate, undefined);
});

test('malformed top-level shapes (not a plain object) all return null, never throwing', () => {
  for (const bad of [null, undefined, 'a string', 42, true, [], ['verdict', 'good']]) {
    assert.doesNotThrow(() => validateVisionQualityOutput(bad));
    assert.equal(validateVisionQualityOutput(bad), null);
  }
});
