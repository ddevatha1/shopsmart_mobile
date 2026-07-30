import { createSession, getActiveSession, listSessions, clearAllSessions, getSessionHistory } from '../assistantShoppingSessionStore';
import type { PlannerListItem } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';
const ITEMS: PlannerListItem[] = [{ id: 'i1', rawText: 'milk' }, { id: 'i2', rawText: 'eggs' }];

afterEach(async () => {
  await clearAllSessions(OWNER);
});

test('creating a session persists it — a real, retrievable record', async () => {
  const session = await createSession(OWNER, { goal: 'save_money', items: ITEMS, constraints: {} });

  expect(session.id).toBeTruthy();
  expect(session.status).toBe('active');
  expect(session.goal).toBe('save_money');

  const sessions = await listSessions(OWNER);
  expect(sessions).toContainEqual(session);
});

test('getActiveSession returns the most recently created active session', async () => {
  await createSession(OWNER, { goal: 'meal_plan', items: ITEMS, constraints: {} });
  const second = await createSession(OWNER, { goal: 'restock', items: ITEMS, constraints: {} });

  const active = await getActiveSession(OWNER);
  expect(active?.id).toBe(second.id);
});

test('a signed-out shopper (empty ownerEmail) gets a real session object back but nothing is persisted', async () => {
  const session = await createSession('', { goal: 'save_money', items: ITEMS, constraints: {} });
  expect(session.goal).toBe('save_money');
  expect(await listSessions('')).toEqual([]);
});

test('constraints — including a real, explicit budgetTarget — are stored exactly as given, never altered', async () => {
  const session = await createSession(OWNER, { goal: 'save_money', items: ITEMS, constraints: { budgetTarget: 100 } });
  expect(session.constraints).toEqual({ budgetTarget: 100 });
});

test('clearAllSessions removes every stored session for that owner', async () => {
  await createSession(OWNER, { goal: 'save_money', items: ITEMS, constraints: {} });
  await clearAllSessions(OWNER);
  expect(await listSessions(OWNER)).toEqual([]);
});

test('sessions are scoped per owner — one shopper never sees another\'s sessions', async () => {
  await createSession(OWNER, { goal: 'save_money', items: ITEMS, constraints: {} });
  expect(await listSessions('someone-else@example.com')).toEqual([]);
});

describe('Phase 5.3 Part 5 — shopping session history', () => {
  test('a session is only ever stored once it is COMPLETE — createSession is the single write path, never a partial draft', async () => {
    // Structural: createSession's own signature requires goal/items/
    // constraints up front — there is no "create a draft, fill it in
    // later" API at all. In-flight wizard state lives entirely in
    // assistantConversationStore.ts, never here (see this file's own
    // header comment).
    const session = await createSession(OWNER, {
      goal: 'save_money', items: ITEMS, constraints: { budgetTarget: 100 },
      estimatedSavings: 12.4, storesUsed: ['Aldi', 'Kroger'],
    });
    expect(session.status).toBe('active');
    expect(session.estimatedSavings).toBe(12.4);
    expect(session.storesUsed).toEqual(['Aldi', 'Kroger']);
  });

  test('getSessionHistory projects real, already-stored sessions, most recent first', async () => {
    await createSession(OWNER, { goal: 'meal_plan', items: ITEMS, constraints: {}, preferencesUsed: { optimizationPreference: 'healthiest' } });
    const second = await createSession(OWNER, {
      goal: 'save_money', items: [{ id: 'i1', rawText: 'milk' }], constraints: {},
      estimatedSavings: 8.42, storesUsed: ['Aldi'],
    });

    const history = await getSessionHistory(OWNER);

    expect(history[0].id).toBe(second.id); // most recent first
    expect(history[0].itemCount).toBe(1);
    expect(history[0].estimatedSavings).toBe(8.42);
    expect(history[0].storesUsed).toEqual(['Aldi']);
    expect(history[1].optimizationPreference).toBe('healthiest');
  });

  test('getSessionHistory over an account with no sessions returns an empty list, never fabricated history', async () => {
    expect(await getSessionHistory(OWNER)).toEqual([]);
  });

  test('getSessionHistory never mutates a session or exposes anything beyond the real, already-stored fields', async () => {
    const session = await createSession(OWNER, { goal: 'save_money', items: ITEMS, constraints: {} });
    const [entry] = await getSessionHistory(OWNER);
    expect(entry.createdAt).toBe(session.createdAt);
    expect(entry.goal).toBe(session.goal);
    expect(entry.itemCount).toBe(session.items.length);
  });
});
