// Run with: npm test
//
// Tests resolveIntent — pure, synchronous, deterministic keyword
// matching, no network. Same convention as every other pure-logic
// service test in this backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntent } from './intentRouterService.ts';

test('"find apples" resolves to search', () => {
  const intent = resolveIntent('find apples');
  assert.equal(intent.type, 'search');
});

test('"add eggs" resolves to add_to_cart', () => {
  const intent = resolveIntent('add eggs');
  assert.equal(intent.type, 'add_to_cart');
});

test('"make this cheaper" resolves to optimize_cart', () => {
  const intent = resolveIntent('make this cheaper');
  assert.equal(intent.type, 'optimize_cart');
});

test('an unrelated sentence resolves to unknown with confidence 0', () => {
  const intent = resolveIntent('the weather is nice today');
  assert.equal(intent.type, 'unknown');
  assert.equal(intent.confidence, 0);
});

test('confidence is always bounded between 0 and 1 inclusive, across every rule and unknown', () => {
  const inputs = [
    'find apples', 'add eggs', 'remove milk from my cart', 'make this cheaper',
    'compare prices', 'open the planner', 'set my budget to 100', 'plan my meals for the week',
    'what foods are high protein', 'gibberish unrelated text', '', '   ',
  ];
  for (const input of inputs) {
    const intent = resolveIntent(input);
    assert.ok(intent.confidence >= 0 && intent.confidence <= 1, `confidence out of bounds for "${input}": ${intent.confidence}`);
  }
});

test('empty or whitespace-only input resolves to unknown, never throws', () => {
  assert.doesNotThrow(() => resolveIntent(''));
  assert.doesNotThrow(() => resolveIntent('   '));
  assert.equal(resolveIntent('').type, 'unknown');
  assert.equal(resolveIntent('   ').type, 'unknown');
});

test('the full example set from the sprint brief resolves as specified', () => {
  assert.equal(resolveIntent('find bananas').type, 'search');
  assert.equal(resolveIntent('add milk to my cart').type, 'add_to_cart');
  assert.equal(resolveIntent('make my list cheaper').type, 'optimize_cart');
  assert.equal(resolveIntent('what foods are high protein').type, 'nutrition_question');
});

test('remove_from_cart and set_budget_target extract a real parameter from the input', () => {
  const removeIntent = resolveIntent('remove milk from my cart');
  assert.equal(removeIntent.type, 'remove_from_cart');
  assert.equal(removeIntent.parameters.item, 'milk from my cart');
  // No count stated — quantity stays undefined, meaning "remove the whole line."
  assert.equal(removeIntent.parameters.quantity, undefined);

  const budgetIntent = resolveIntent('set my budget to 100 dollars');
  assert.equal(budgetIntent.type, 'set_budget_target');
  assert.equal(budgetIntent.parameters.amount, 100);
});

test('remove_from_cart extracts a stated removal count as a real quantity, digit or word form', () => {
  assert.equal(resolveIntent('remove 2 bananas').parameters.quantity, 2);
  assert.equal(resolveIntent('remove two bananas').parameters.quantity, 2);
  assert.equal(resolveIntent('delete one of the apples').parameters.quantity, 1);
  // A number appearing only elsewhere in the sentence (not leading the
  // item text) is never picked up as a quantity — no count was actually stated.
  assert.equal(resolveIntent('remove milk from my cart').parameters.quantity, undefined);
});

test('meal_plan is checked before the more generic open_planner keyword "plan"', () => {
  assert.equal(resolveIntent('plan my meals for the week').type, 'meal_plan');
});

test('resolveIntent never returns a fabricated type outside the closed IntentType vocabulary', () => {
  const validTypes = new Set([
    'search', 'add_to_cart', 'remove_from_cart', 'compare_options', 'optimize_cart',
    'open_planner', 'set_budget_target', 'meal_plan', 'nutrition_question', 'start_shopping_session',
    'update_preferences', 'unknown',
  ]);
  const inputs = ['find apples', 'add eggs', 'random text', 'compare prices', 'budget please'];
  for (const input of inputs) {
    assert.ok(validTypes.has(resolveIntent(input).type));
  }
});

// ─── Word-boundary precision (Phase 3.1 hardening) ─────────────────────────

test('"add milk to cart" resolves to add_to_cart (real word-boundary example)', () => {
  assert.equal(resolveIntent('add milk to cart').type, 'add_to_cart');
});

test('"recommend something healthy" never resolves to add_to_cart — no real "add" word present', () => {
  assert.notEqual(resolveIntent('recommend something healthy').type, 'add_to_cart');
});

test('"make my shopping list cheaper" resolves to optimize_cart, not open_planner', () => {
  // Real regression: with a bare "shopping list" keyword on open_planner
  // (checked before optimize_cart), this used to wrongly resolve to
  // open_planner just because the phrase "shopping list" appears here too.
  assert.equal(resolveIntent('make my shopping list cheaper').type, 'optimize_cart');
});

test('"what is the cheapest milk" never resolves to optimize_cart — "cheapest" is not "cheaper"', () => {
  assert.notEqual(resolveIntent('what is the cheapest milk').type, 'optimize_cart');
});

test('a real substring false positive is fixed: "research" no longer matches the "search" keyword', () => {
  // Real regression: .includes('search') matched inside "research" —
  // "I'm doing research on prices" used to wrongly resolve to 'search'.
  assert.notEqual(resolveIntent("I'm doing research on prices").type, 'search');
});

test('a real substring false positive is fixed: "address" no longer matches the "add" keyword', () => {
  assert.notEqual(resolveIntent('my address changed').type, 'add_to_cart');
});

test('phrase matching still works for multi-word keywords after the word-boundary change', () => {
  assert.equal(resolveIntent('please search for bananas').type, 'search');
  assert.equal(resolveIntent('open the planner for me').type, 'open_planner');
  assert.equal(resolveIntent('what should i cook tonight').type, 'meal_plan');
});

// ─── Phase 3.2: nutrition_question / compare_options parameter extraction ──

test('"how much protein is in milk" extracts "milk" as the nutrition query', () => {
  const intent = resolveIntent('how much protein is in milk');
  assert.equal(intent.type, 'nutrition_question');
  assert.equal(intent.parameters.query, 'milk');
});

test('"calories in a banana" extracts "a banana" as the nutrition query', () => {
  const intent = resolveIntent('calories in a banana');
  assert.equal(intent.type, 'nutrition_question');
  assert.equal(intent.parameters.query, 'a banana');
});

test('a nutrition question with no "in <subject>" falls back to the full input as the query', () => {
  const intent = resolveIntent('what foods are high protein');
  assert.equal(intent.type, 'nutrition_question');
  assert.equal(intent.parameters.query, 'what foods are high protein');
});

test('compare_options extracts a query the same way search does', () => {
  const intent = resolveIntent('compare milk prices');
  assert.equal(intent.type, 'compare_options');
  assert.equal(intent.parameters.query, 'milk prices');
});

// ─── Phase 5.0: Conversational Grocery Planner meal_plan phrasing ──────────

test('"Plan dinners for this week" resolves to meal_plan with mealType "dinner" and no mealCount yet', () => {
  const intent = resolveIntent('Plan dinners for this week');
  assert.equal(intent.type, 'meal_plan');
  assert.equal(intent.parameters.mealType, 'dinner');
  assert.equal(intent.parameters.mealCount, undefined);
});

test('"plan 5 dinners" extracts both mealCount and mealType from the initial request', () => {
  const intent = resolveIntent('plan 5 dinners');
  assert.equal(intent.type, 'meal_plan');
  assert.equal(intent.parameters.mealCount, 5);
  assert.equal(intent.parameters.mealType, 'dinner');
});

test('"plan breakfast for the week" resolves to meal_plan with mealType "breakfast"', () => {
  const intent = resolveIntent('plan breakfast for the week');
  assert.equal(intent.type, 'meal_plan');
  assert.equal(intent.parameters.mealType, 'breakfast');
});

// ─── Phase 5.1: start_shopping_session ─────────────────────────────────────

test('"help me save money this week" starts a shopping session, not a bare optimize_cart', () => {
  assert.equal(resolveIntent('help me save money this week').type, 'start_shopping_session');
});

test('"build me a grocery plan" resolves to start_shopping_session', () => {
  assert.equal(resolveIntent('build me a grocery plan').type, 'start_shopping_session');
});

test('a bare "make this cheaper" is completely unaffected — still optimize_cart', () => {
  assert.equal(resolveIntent('make this cheaper').type, 'optimize_cart');
});

test('"keep groceries under $100" extracts a real, explicit budgetTarget', () => {
  const intent = resolveIntent('keep groceries under $100');
  assert.equal(intent.type, 'start_shopping_session');
  assert.equal(intent.parameters.budgetTarget, 100);
});

test('start_shopping_session with no stated amount leaves budgetTarget undefined — never guessed', () => {
  const intent = resolveIntent('build me a grocery plan');
  assert.equal(intent.parameters.budgetTarget, undefined);
});

test('"what should I buy" resolves to start_shopping_session with goal pre-filled to restock', () => {
  const intent = resolveIntent('what should I buy');
  assert.equal(intent.type, 'start_shopping_session');
  assert.equal(intent.parameters.goal, 'restock');
});

test('"show my previous shopping sessions" resolves to start_shopping_session with showHistory set', () => {
  const intent = resolveIntent('show my previous shopping sessions');
  assert.equal(intent.type, 'start_shopping_session');
  assert.equal(intent.parameters.showHistory, true);
});

test('"how did my shopping improve" also resolves to start_shopping_session with showHistory set', () => {
  const intent = resolveIntent('how did my shopping improve');
  assert.equal(intent.type, 'start_shopping_session');
  assert.equal(intent.parameters.showHistory, true);
});

test('a plain "build me a grocery plan" never sets showHistory — only the real history phrasing does', () => {
  const intent = resolveIntent('build me a grocery plan');
  assert.equal(intent.parameters.showHistory, undefined);
});

// Phase 5.5 Part 3 — "create my plan"/"create my shopping plan" are the
// exact trigger phrases this phase's own brief uses for the Magic Moment
// demo; confirmed missing from the keyword list before this phase and
// added to it (see this rule's `keywords` array above).
test('"create my plan" resolves to start_shopping_session', () => {
  assert.equal(resolveIntent('create my plan').type, 'start_shopping_session');
});

test('"create my shopping plan" resolves to start_shopping_session', () => {
  assert.equal(resolveIntent('create my shopping plan').type, 'start_shopping_session');
});

// ─── Phase 5.2: update_preferences ──────────────────────────────────────────

test('"Remember I prefer Aldi" extracts a real preferredStores update', () => {
  const intent = resolveIntent('Remember I prefer Aldi');
  assert.equal(intent.type, 'update_preferences');
  assert.equal(intent.parameters.field, 'preferredStores');
  assert.equal(intent.parameters.value, 'Aldi');
});

test('"Don\'t show me Walmart" extracts an avoidedStores update even for a store this app has no data for', () => {
  const intent = resolveIntent("Don't show me Walmart");
  assert.equal(intent.type, 'update_preferences');
  assert.equal(intent.parameters.field, 'avoidedStores');
  assert.equal(intent.parameters.value, 'Walmart');
});

test('"I prefer healthier options" extracts an optimizationPreference of healthiest', () => {
  const intent = resolveIntent('I prefer healthier options');
  assert.equal(intent.type, 'update_preferences');
  assert.equal(intent.parameters.field, 'optimizationPreference');
  assert.equal(intent.parameters.value, 'healthiest');
});

test('unrecognized text after "remember" style keywords never guesses a field/value', () => {
  const intent = resolveIntent('I prefer shopping at somewhere nice');
  assert.equal(intent.type, 'update_preferences');
  assert.equal(intent.parameters.field, undefined);
  assert.equal(intent.parameters.value, undefined);
});

test('"make this cheaper" is still optimize_cart — update_preferences never collides with it', () => {
  assert.equal(resolveIntent('make this cheaper').type, 'optimize_cart');
});

// ─── Phase 5.5 Part 5: Assistant Experience Polish ──────────────────────────

// AssistantScreen.tsx's own empty-state SUGGESTED_PROMPTS array — pinned
// here so a future change to this rule table can't silently break one of
// the exact phrases the app itself suggests tapping. (Two of the
// original four suggested prompts — "Plan meals" and "Find cheapest
// groceries" — were found to resolve to 'unknown'/'search' respectively
// and were corrected in this same phase; see AssistantScreen.tsx.)
test('every one of AssistantScreen.tsx\'s SUGGESTED_PROMPTS resolves to a real intent, never "unknown"', () => {
  const SUGGESTED_PROMPTS = ['Help me save money this week', 'Plan my meals', 'What should I buy?', 'Optimize my cart'];
  for (const prompt of SUGGESTED_PROMPTS) {
    assert.notEqual(resolveIntent(prompt).type, 'unknown');
  }
});
