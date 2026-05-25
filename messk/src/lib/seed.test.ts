import { describe, expect, it, vi } from 'vitest';
import { deriveKeysFromPhrase } from './seed';

describe('seed derivation hygiene', () => {
  it('wipes mutable seed and secret-key bytes after deriving identity strings', () => {
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill');

    try {
      const identity = deriveKeysFromPhrase(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );

      expect(identity.publicKey).toBeTruthy();
      expect(identity.secretKey).toBeTruthy();
      expect(fillSpy.mock.calls.filter(([value]) => value === 0).length).toBeGreaterThanOrEqual(3);
    } finally {
      fillSpy.mockRestore();
    }
  });
});
