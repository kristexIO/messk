import { beforeEach, describe, expect, it, vi } from 'vitest';
import { box } from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { RatchetManager } from './ratchet';
import type { Session } from './db';

describe('RatchetManager', () => {
  let aliceIdentity: ReturnType<typeof box.keyPair>;
  let bobIdentity: ReturnType<typeof box.keyPair>;
  let aliceRatchet: ReturnType<typeof box.keyPair>;
  let bobRatchet: ReturnType<typeof box.keyPair>;

  beforeEach(() => {
    aliceIdentity = box.keyPair();
    bobIdentity = box.keyPair();
    aliceRatchet = box.keyPair();
    bobRatchet = box.keyPair();
  });

  function createSessionPair(): { alice: Session; bob: Session } {
    const sharedSecret = box.before(bobRatchet.publicKey, aliceRatchet.secretKey);

    return {
      alice: {
        peerPublicKey: encodeBase64(bobIdentity.publicKey),
        rootKey: encodeBase64(sharedSecret),
        sendChainKey: encodeBase64(sharedSecret),
        recvChainKey: null,
        sendRatchetPubKey: encodeBase64(aliceRatchet.publicKey),
        sendRatchetPrivKey: encodeBase64(aliceRatchet.secretKey),
        recvRatchetPubKey: encodeBase64(bobRatchet.publicKey),
        sendChainIndex: 0,
        recvChainIndex: 0,
        previousSendChainLength: 0,
        skippedKeys: {}
      },
      bob: {
        peerPublicKey: encodeBase64(aliceIdentity.publicKey),
        rootKey: encodeBase64(sharedSecret),
        sendChainKey: null,
        recvChainKey: encodeBase64(sharedSecret),
        sendRatchetPubKey: encodeBase64(bobRatchet.publicKey),
        sendRatchetPrivKey: encodeBase64(bobRatchet.secretKey),
        recvRatchetPubKey: encodeBase64(aliceRatchet.publicKey),
        sendChainIndex: 0,
        recvChainIndex: 0,
        previousSendChainLength: 0,
        skippedKeys: {}
      }
    };
  }

  it('encrypts and decrypts a first message round-trip', async () => {
    const { alice, bob } = createSessionPair();

    const message = await RatchetManager.encrypt(alice, 'hello secure world');
    const plaintext = await RatchetManager.decrypt(bob, message);

    expect(plaintext).toBe('hello secure world');
    expect(alice.sendChainIndex).toBe(1);
    expect(bob.recvChainIndex).toBe(1);
  });

  it('pads authenticated plaintext without changing decrypted text', async () => {
    const { alice, bob } = createSessionPair();

    const message = await RatchetManager.encrypt(alice, 'short');
    const packed = decodeBase64(message.ciphertext);
    const plaintextBytes = packed.length - 24 - 16;

    expect(plaintextBytes).toBeGreaterThanOrEqual(256);
    await expect(RatchetManager.decrypt(bob, message)).resolves.toBe('short');
  });

  it('supports multiple sequential messages on the same chain', async () => {
    const { alice, bob } = createSessionPair();

    const first = await RatchetManager.encrypt(alice, 'one');
    const second = await RatchetManager.encrypt(alice, 'two');

    await expect(RatchetManager.decrypt(bob, first)).resolves.toBe('one');
    await expect(RatchetManager.decrypt(bob, second)).resolves.toBe('two');
    expect(bob.recvChainIndex).toBe(2);
  });

  it('supports limited out-of-order messages with skipped keys', async () => {
    const { alice, bob } = createSessionPair();

    const first = await RatchetManager.encrypt(alice, 'one');
    const second = await RatchetManager.encrypt(alice, 'two');

    await expect(RatchetManager.decrypt(bob, second)).resolves.toBe('two');
    expect(bob.recvChainIndex).toBe(2);
    expect(Object.keys(bob.skippedKeys)).toHaveLength(1);

    await expect(RatchetManager.decrypt(bob, first)).resolves.toBe('one');
    expect(Object.keys(bob.skippedKeys)).toHaveLength(0);
  });

  it('does not advance receive state when authentication fails', async () => {
    const { alice, bob } = createSessionPair();

    const first = await RatchetManager.encrypt(alice, 'one');
    const second = await RatchetManager.encrypt(alice, 'two');
    const originalRecvChainKey = bob.recvChainKey;
    const originalRecvChainIndex = bob.recvChainIndex;

    const tampered = {
      ...first,
      ciphertext: first.ciphertext.slice(0, -2) + 'aa'
    };

    await expect(RatchetManager.decrypt(bob, tampered)).resolves.toBeNull();
    expect(bob.recvChainKey).toBe(originalRecvChainKey);
    expect(bob.recvChainIndex).toBe(originalRecvChainIndex);

    await expect(RatchetManager.decrypt(bob, first)).resolves.toBe('one');
    await expect(RatchetManager.decrypt(bob, second)).resolves.toBe('two');
  });

  it('rejects tampered ratchet headers for new messages', async () => {
    const { alice, bob } = createSessionPair();

    const message = await RatchetManager.encrypt(alice, 'header-bound');
    const tampered = {
      ...message,
      header: {
        ...message.header,
        n: message.header.n + 1
      }
    };

    await expect(RatchetManager.decrypt(bob, tampered)).resolves.toBeNull();
    await expect(RatchetManager.decrypt(bob, message)).resolves.toBe('header-bound');
  });

  it('rejects excessive skipped message gaps', async () => {
    const { alice, bob } = createSessionPair();
    let message = await RatchetManager.encrypt(alice, '0');

    for (let i = 1; i < 55; i++) {
      message = await RatchetManager.encrypt(alice, `${i}`);
    }

    await expect(RatchetManager.decrypt(bob, message)).resolves.toBeNull();
    expect(bob.recvChainIndex).toBe(0);
  });

  it('wipes mutable derived buffers while ratcheting a message', async () => {
    const { alice, bob } = createSessionPair();
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill');

    try {
      const message = await RatchetManager.encrypt(alice, 'wipe-check');
      await expect(RatchetManager.decrypt(bob, message)).resolves.toBe('wipe-check');
      expect(fillSpy.mock.calls.filter(([value]) => value === 0).length).toBeGreaterThan(5);
    } finally {
      fillSpy.mockRestore();
    }
  });
});
