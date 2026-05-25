import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRememberedIdentity, hashPin, hasRememberedIdentity, rememberIdentityWithPin, restoreRememberedIdentityWithPin, verifyPin } from './security';

afterEach(() => {
  clearRememberedIdentity();
  localStorage.clear();
});

describe('PIN security', () => {
  it('hashes PINs with a salted PBKDF2 envelope', async () => {
    const first = await hashPin('1234');
    const second = await hashPin('1234');

    expect(first).toMatch(/^pbkdf2:v1:/);
    expect(second).toMatch(/^pbkdf2:v1:/);
    expect(first).not.toBe(second);
    await expect(verifyPin('1234', first)).resolves.toBe(true);
    await expect(verifyPin('0000', first)).resolves.toBe(false);
  });

  it('keeps legacy SHA-256 PIN hashes verifiable for existing users', async () => {
    const legacyHash = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

    await expect(verifyPin('1234', legacyHash)).resolves.toBe(true);
    await expect(verifyPin('0000', legacyHash)).resolves.toBe(false);
  });

  it('stores remembered identities behind a PIN-encrypted envelope', async () => {
    await rememberIdentityWithPin('pub-key', 'secret-key', '1234');

    expect(hasRememberedIdentity()).toBe(true);
    await expect(restoreRememberedIdentityWithPin('1234')).resolves.toEqual({
      publicKey: 'pub-key',
      secretKey: 'secret-key',
    });
    await expect(restoreRememberedIdentityWithPin('0000')).resolves.toBeNull();
  });

  it('wipes mutable PIN and remembered-identity plaintext buffers', async () => {
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill');

    try {
      const hash = await hashPin('2468');
      await expect(verifyPin('2468', hash)).resolves.toBe(true);
      await rememberIdentityWithPin('pub-key', 'secret-key', '2468');
      await expect(restoreRememberedIdentityWithPin('2468')).resolves.toEqual({
        publicKey: 'pub-key',
        secretKey: 'secret-key',
      });
      expect(fillSpy.mock.calls.filter(([value]) => value === 0).length).toBeGreaterThan(5);
    } finally {
      fillSpy.mockRestore();
    }
  });
});
