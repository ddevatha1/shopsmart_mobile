/**
 * Deliberately tiny — a budget is one optional number the shopper sets
 * once (see ProfileScreen), compared against the real running cart total.
 * No spending categories, no historical charts; just "how close am I."
 */
export interface BudgetStatus {
  budget: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  level: 'ok' | 'approaching' | 'over';
}

const APPROACHING_THRESHOLD_PERCENT = 80;

export function getBudgetStatus(budget: number | undefined, cartTotal: number): BudgetStatus | null {
  if (!budget || budget <= 0) return null;
  const percentUsed = Math.round((cartTotal / budget) * 100);
  return {
    budget,
    spent: cartTotal,
    remaining: Math.max(0, budget - cartTotal),
    percentUsed,
    level: cartTotal > budget ? 'over' : percentUsed >= APPROACHING_THRESHOLD_PERCENT ? 'approaching' : 'ok',
  };
}
