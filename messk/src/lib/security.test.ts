import { describe, expect, it } from 'vitest';
import { hashPin, verifyPin } from './security';

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
});
