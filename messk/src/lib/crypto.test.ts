import { describe, expect, it, vi } from 'vitest';
import { box } from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { decryptMessage, encryptMessage, x3dhInitiate, x3dhRespond } from './crypto';

describe('X3DH key agreement', () => {
  it('derives the same domain-separated root key on both sides', async () => {
    const aliceIdentity = box.keyPair();
    const bobIdentity = box.keyPair();
    const bobPreKey = box.keyPair();

    const initiated = await x3dhInitiate(
      encodeBase64(aliceIdentity.secretKey),
      encodeBase64(aliceIdentity.publicKey),
      encodeBase64(bobIdentity.publicKey),
      encodeBase64(bobPreKey.publicKey),
      null
    );

    const responded = await x3dhRespond(
      encodeBase64(bobIdentity.secretKey),
      encodeBase64(bobPreKey.secretKey),
      null,
      encodeBase64(aliceIdentity.publicKey),
      initiated.ephemeralPub,
      null
    );

    expect(encodeBase64(initiated.sharedSecret)).toBe(encodeBase64(responded));
  });

  it('rejects placeholder PQC material until a real implementation is available', async () => {
    const aliceIdentity = box.keyPair();
    const bobIdentity = box.keyPair();

    await expect(
      x3dhInitiate(
        encodeBase64(aliceIdentity.secretKey),
        encodeBase64(aliceIdentity.publicKey),
        encodeBase64(bobIdentity.publicKey),
        null,
        'fake-pqc-key'
      )
    ).rejects.toThrow(/PQC handshake is disabled/);
  });

  it('wipes mutable direct-message buffers after encrypt and decrypt', () => {
    const alice = box.keyPair();
    const bob = box.keyPair();
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill');

    try {
      const encrypted = encryptMessage(
        'sensitive payload',
        encodeBase64(alice.secretKey),
        encodeBase64(bob.publicKey)
      );

      expect(decryptMessage(encrypted, encodeBase64(bob.secretKey), encodeBase64(alice.publicKey)))
        .toBe('sensitive payload');
      expect(fillSpy.mock.calls.filter(([value]) => value === 0).length).toBeGreaterThanOrEqual(4);
    } finally {
      fillSpy.mockRestore();
    }
  });
});
