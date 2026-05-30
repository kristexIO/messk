import { describe, expect, it } from 'vitest';
import { buildLocalKeyStatus } from './localKeyStatus';

describe('local key status', () => {
  it('describes local key posture without exposing raw keys', () => {
    const items = buildLocalKeyStatus({
      hasUnlockedIdentity: true,
      hasPin: false,
      isIdentityRemembered: false,
      autoLockMinutes: 0,
      databaseName: 'MessengerDBClean20260511-secret-public-key',
    });
    const serialized = JSON.stringify(items);

    expect(items.map((item) => item.id)).toEqual(['identity', 'pin', 'restore', 'database', 'autolock']);
    expect(items.find((item) => item.id === 'pin')?.tone).toBe('warn');
    expect(items.find((item) => item.id === 'database')?.value).toBe('Identity-scoped vault (...blic-key)');
    expect(serialized).not.toContain('secret-public-key');
    expect(serialized).not.toMatch(/seed phrase:|secretKey|private key/i);
  });

  it('marks remembered PIN restore and auto-lock as ready', () => {
    const items = buildLocalKeyStatus({
      hasUnlockedIdentity: true,
      hasPin: true,
      isIdentityRemembered: true,
      autoLockMinutes: 15,
      databaseName: 'MessengerDBClean20260511',
    });

    expect(items.find((item) => item.id === 'restore')?.value).toBe('PIN restore ready');
    expect(items.find((item) => item.id === 'autolock')?.tone).toBe('ok');
  });
});
