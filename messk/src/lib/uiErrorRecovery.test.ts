import { describe, expect, it } from 'vitest';
import { getSafeUiErrorReport, getSafeUiRecoveryCopy } from './uiErrorRecovery';

describe('safe UI error recovery', () => {
  it('does not expose thrown message text or stacks in user copy', () => {
    const sensitiveError = new Error('seed phrase alpha bravo secret chat plaintext');
    const report = getSafeUiErrorReport('chat-surface', sensitiveError, 'at MessageBubble');
    const renderedCopy = Object.values(getSafeUiRecoveryCopy('chat-surface')).join(' ');
    const combined = `${JSON.stringify(report)} ${renderedCopy}`;

    expect(report.errorName).toBe('Error');
    expect(combined).not.toContain('seed phrase');
    expect(combined).not.toContain('secret chat plaintext');
    expect(renderedCopy).toMatch(/raw diagnostics stay hidden/i);
  });

  it('keeps invalid error names generic', () => {
    const report = getSafeUiErrorReport('chat-surface', { name: 'not used' });
    expect(report.errorName).toBe('object');
  });
});
