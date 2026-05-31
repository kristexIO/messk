import { describe, expect, it } from 'vitest';
import { lazyRouteBudgets, lazyRouteCopies } from './lazyRoutes';

describe('lazy route loading contract', () => {
  it('keeps fallback copy generic and free of sensitive diagnostics', () => {
    const text = Object.values(lazyRouteCopies)
      .flatMap((copy) => Object.values(copy))
      .join(' ');

    expect(text).toMatch(/Loading chat workspace/i);
    expect(text).toMatch(/trust center/i);
    expect(text).not.toMatch(/seed phrase|secret key|\btoken\b|\bsdp\b|\bice\b|\bcandidate\b|public key|message text|raw diagnostics/i);
  });

  it('declares budgets for entry and lazy route chunks', () => {
    expect(lazyRouteBudgets.map((budget) => budget.id)).toEqual([
      'entry',
      'auth',
      'chat',
      'session',
      'trust',
    ]);
    expect(lazyRouteBudgets.every((budget) => budget.maxBytes > 0)).toBe(true);
    expect(lazyRouteBudgets.find((budget) => budget.id === 'entry')?.maxBytes).toBeLessThanOrEqual(200_000);
  });
});
