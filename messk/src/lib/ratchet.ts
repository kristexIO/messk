import { box, randomBytes, secretbox } from 'tweetnacl';
import { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import type { Session } from './db';
import { metadataPaddingTargetLen } from './protocolContract';

const MAX_PADDED_PAYLOAD_BYTES = 1024 * 1024;

function clearBytes(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const buffer of buffers) {
    buffer?.fill(0);
  }
}

// HKDF Implementation using Web Crypto API
async function hkdf(secret: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const secretBytes = new Uint8Array(secret);
  const saltBytes = new Uint8Array(salt);
  const infoBytes = new TextEncoder().encode(info);
  try {
    const key = await window.crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HKDF' },
      false,
      ['deriveBits']
    );

    const bits = await window.crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: saltBytes,
        info: infoBytes,
      },
      key,
      length * 8
    );

    return new Uint8Array(bits);
  } finally {
    clearBytes(secretBytes, saltBytes);
  }
}

// HMAC-SHA256 for Chain Ratchet
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(key);
  const dataBytes = new Uint8Array(data);
  try {
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
    return new Uint8Array(signature);
  } finally {
    clearBytes(keyBytes, dataBytes);
  }
}

export interface RatchetMessage {
  header: {
    ratchetPubKey: string; // Base64
    n: number; // Message number in current chain
    pn: number; // Number of messages in previous chain
  };
  ciphertext: string; // Base64
}

function buildAuthenticatedPlaintext(header: RatchetMessage['header'], plaintext: string): string {
  const baseEnvelope = {
    v: 1,
    header,
    plaintext
  };
  const emptyPaddingEnvelope = {
    ...baseEnvelope,
    padding: ''
  };
  const emptyPadding = JSON.stringify(emptyPaddingEnvelope);
  const targetLength = metadataPaddingTargetLen('interactive', emptyPadding.length);
  if (targetLength > MAX_PADDED_PAYLOAD_BYTES) {
    throw new Error('Message is too large after metadata padding');
  }
  return JSON.stringify({
    ...baseEnvelope,
    padding: '0'.repeat(Math.max(0, targetLength - emptyPadding.length))
  });
}

/**
 * Double Ratchet Session Logic
 */
export class RatchetSession {
  // Constants for KDF
  private static readonly ROOT_INFO = 'RatchetRootKey';
  private static readonly MESSAGE_KEY_SEED = new Uint8Array([0x01]);
  private static readonly NEXT_CHAIN_SEED = new Uint8Array([0x02]);

  /**
   * Root Chain: (rootKey, dhOutput) -> (rootKey, chainKey)
   */
  static async kdfRoot(rootKey: Uint8Array, dhOutput: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    const res = await hkdf(dhOutput, rootKey, this.ROOT_INFO, 64);
    try {
      return [res.slice(0, 32), res.slice(32, 64)];
    } finally {
      res.fill(0);
    }
  }

  /**
   * Chain Ratchet: chainKey -> (chainKey, messageKey)
   */
  static async kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    const messageKey = await hmac(chainKey, this.MESSAGE_KEY_SEED);
    try {
      const nextChainKey = await hmac(chainKey, this.NEXT_CHAIN_SEED);
      return [nextChainKey, messageKey];
    } catch (error) {
      messageKey.fill(0);
      throw error;
    }
  }

  /**
   * DH Ratchet
   */
  static diffieHellman(privKey: Uint8Array, pubKey: Uint8Array): Uint8Array {
    return box.before(pubKey, privKey);
  }
}

/**
 * Manages states and transitions of a Double Ratchet session
 */
export class RatchetManager {
  private static readonly MAX_SKIP = 50;

  private static skippedKeyId(ratchetPubKey: string, n: number): string {
    return `${ratchetPubKey}:${n}`;
  }

  private static validateMessage(msg: RatchetMessage): boolean {
    return Boolean(
      msg?.header?.ratchetPubKey &&
      Number.isInteger(msg.header.n) &&
      Number.isInteger(msg.header.pn) &&
      msg.header.n >= 0 &&
      msg.header.pn >= 0 &&
      msg.ciphertext
    );
  }

  private static decryptWithMessageKey(
    ciphertext: string,
    messageKey: Uint8Array,
    expectedHeader?: RatchetMessage['header']
  ): string | null {
    let decrypted: Uint8Array | null = null;
    try {
      const fullCipher = decodeBase64(ciphertext);
      if (fullCipher.length < secretbox.nonceLength + secretbox.overheadLength) {
        return null;
      }

      const nonce = fullCipher.slice(0, secretbox.nonceLength);
      const cipher = fullCipher.slice(secretbox.nonceLength);
      decrypted = secretbox.open(cipher, nonce, messageKey);
      if (!decrypted) {
        return null;
      }

      const decoded = encodeUTF8(decrypted);
      if (!expectedHeader) {
        return decoded;
      }

      try {
        const envelope = JSON.parse(decoded) as {
          v?: number;
          header?: RatchetMessage['header'];
          plaintext?: string;
        };
        if (envelope.v !== 1 || typeof envelope.plaintext !== 'string' || !envelope.header) {
          return decoded;
        }
        if (
          envelope.header.ratchetPubKey !== expectedHeader.ratchetPubKey ||
          envelope.header.n !== expectedHeader.n ||
          envelope.header.pn !== expectedHeader.pn
        ) {
          return null;
        }
        return envelope.plaintext;
      } catch {
        // Backward compatibility for messages sent before header binding.
        return decoded;
      }
    } catch {
      return null;
    } finally {
      decrypted?.fill(0);
    }
  }

  private static async skipMessageKeys(session: Session, until: number): Promise<boolean> {
    if (!session.recvChainKey || !session.recvRatchetPubKey) {
      return false;
    }

    if (until < session.recvChainIndex) {
      return true;
    }

    if (until - session.recvChainIndex > this.MAX_SKIP) {
      return false;
    }

    if (!session.recvChainKey) {
      session.recvChainKey = encodeBase64(new Uint8Array(32)); // Fallback to avoid null in loops
    }
    let chainKey = decodeBase64(session.recvChainKey);
    const skippedKeys = { ...(session.skippedKeys ?? {}) };

    try {
      for (let i = session.recvChainIndex; i < until; i++) {
        const [nextChainKey, messageKey] = await RatchetSession.kdfChain(chainKey);
        try {
          skippedKeys[this.skippedKeyId(session.recvRatchetPubKey, i)] = encodeBase64(messageKey);
        } finally {
          clearBytes(chainKey, messageKey);
        }
        chainKey = nextChainKey;
      }

      session.recvChainKey = encodeBase64(chainKey);
      session.recvChainIndex = until;
      session.skippedKeys = skippedKeys;
      return true;
    } finally {
      chainKey.fill(0);
    }
  }

  private static async ensureSendChain(session: Session): Promise<void> {
    if (session.sendChainKey) {
      return;
    }

    if (!session.recvRatchetPubKey) {
      throw new Error('Missing peer ratchet public key');
    }

    let newSendRatchet: ReturnType<typeof box.keyPair> | null = null;
    let currentRootKey: Uint8Array | null = null;
    let dhOutput: Uint8Array | null = null;
    let newRootKey: Uint8Array | null = null;
    let newSendChainKey: Uint8Array | null = null;
    try {
      newSendRatchet = box.keyPair();
      currentRootKey = decodeBase64(session.rootKey);
      dhOutput = RatchetSession.diffieHellman(
        newSendRatchet.secretKey,
        decodeBase64(session.recvRatchetPubKey)
      );

      [newRootKey, newSendChainKey] = await RatchetSession.kdfRoot(currentRootKey, dhOutput);

      session.rootKey = encodeBase64(newRootKey);
      session.sendChainKey = encodeBase64(newSendChainKey);
      session.sendRatchetPubKey = encodeBase64(newSendRatchet.publicKey);
      session.sendRatchetPrivKey = encodeBase64(newSendRatchet.secretKey);
      session.previousSendChainLength = session.sendChainIndex;
      session.sendChainIndex = 0;
    } finally {
      clearBytes(currentRootKey, dhOutput, newRootKey, newSendChainKey, newSendRatchet?.secretKey);
    }
  }

  /**
   * Encrypt a message using current session state
   */
  static async encrypt(session: Session, plaintext: string): Promise<RatchetMessage> {
    await this.ensureSendChain(session);
    const sendChainKey = session.sendChainKey;
    if (!sendChainKey) {
      throw new Error('Failed to initialize send chain');
    }

    const currentChainKey = decodeBase64(sendChainKey);
    let nextChainKey: Uint8Array | null = null;
    let messageKey: Uint8Array | null = null;
    let authenticatedPlaintextBytes: Uint8Array | null = null;
    try {
      [nextChainKey, messageKey] = await RatchetSession.kdfChain(currentChainKey);

      // Update session state
      session.sendChainKey = encodeBase64(nextChainKey);
      const n = session.sendChainIndex;
      session.sendChainIndex++;

      const header = {
        ratchetPubKey: session.sendRatchetPubKey,
        n: n,
        pn: session.previousSendChainLength
      };
      const authenticatedPlaintext = buildAuthenticatedPlaintext(header, plaintext);
      const nonce = randomBytes(secretbox.nonceLength);
      authenticatedPlaintextBytes = decodeUTF8(authenticatedPlaintext);
      const ciphertext = secretbox(authenticatedPlaintextBytes, nonce, messageKey);

      const fullCipher = new Uint8Array(nonce.length + ciphertext.length);
      fullCipher.set(nonce);
      fullCipher.set(ciphertext, nonce.length);

      return {
        header,
        ciphertext: encodeBase64(fullCipher)
      };
    } finally {
      clearBytes(currentChainKey, nextChainKey, messageKey, authenticatedPlaintextBytes);
    }
  }

  /**
   * Decrypt a message and update session state if necessary (DH Ratchet)
   */
  static async decrypt(session: Session, msg: RatchetMessage): Promise<string | null> {
    if (!this.validateMessage(msg)) {
      return null;
    }

    const skippedKeyId = this.skippedKeyId(msg.header.ratchetPubKey, msg.header.n);
    const skippedMessageKey = session.skippedKeys?.[skippedKeyId];
    if (skippedMessageKey) {
      const messageKey = decodeBase64(skippedMessageKey);
      let plaintext: string | null;
      try {
        plaintext = this.decryptWithMessageKey(msg.ciphertext, messageKey, msg.header);
      } finally {
        messageKey.fill(0);
      }
      if (!plaintext) {
        return null;
      }

      const skippedKeys = { ...(session.skippedKeys ?? {}) };
      delete skippedKeys[skippedKeyId];
      session.skippedKeys = skippedKeys;
      return plaintext;
    }

    const draftSession: Session = {
      ...session,
      skippedKeys: { ...(session.skippedKeys ?? {}) }
    };

    // 1. Check if it's a new DH ratchet step
    if (msg.header.ratchetPubKey !== draftSession.recvRatchetPubKey) {
      if (draftSession.recvChainKey && !(await this.skipMessageKeys(draftSession, msg.header.pn))) {
        return null;
      }
      
      // Perform DH Ratchet step
      let sendRatchetPrivKey: Uint8Array | null = null;
      let currentRootKey: Uint8Array | null = null;
      let dhOutput: Uint8Array | null = null;
      let newRootKey: Uint8Array | null = null;
      let newRecvChainKey: Uint8Array | null = null;
      try {
        sendRatchetPrivKey = decodeBase64(draftSession.sendRatchetPrivKey);
        currentRootKey = decodeBase64(draftSession.rootKey);
        dhOutput = RatchetSession.diffieHellman(
          sendRatchetPrivKey,
          decodeBase64(msg.header.ratchetPubKey)
        );

        [newRootKey, newRecvChainKey] = await RatchetSession.kdfRoot(currentRootKey, dhOutput);

        draftSession.rootKey = encodeBase64(newRootKey);
        draftSession.recvChainKey = encodeBase64(newRecvChainKey);
        draftSession.recvRatchetPubKey = msg.header.ratchetPubKey;
        draftSession.recvChainIndex = 0;

        // New sending DH ratchet
        const newSendRatchet = box.keyPair();
        let dhOutputSend: Uint8Array | null = null;
        let finalRootKey: Uint8Array | null = null;
        let newSendChainKey: Uint8Array | null = null;
        try {
          dhOutputSend = RatchetSession.diffieHellman(
            newSendRatchet.secretKey,
            decodeBase64(msg.header.ratchetPubKey)
          );

          [finalRootKey, newSendChainKey] = await RatchetSession.kdfRoot(newRootKey, dhOutputSend);

          draftSession.rootKey = encodeBase64(finalRootKey);
          draftSession.sendChainKey = encodeBase64(newSendChainKey);
          draftSession.sendRatchetPubKey = encodeBase64(newSendRatchet.publicKey);
          draftSession.sendRatchetPrivKey = encodeBase64(newSendRatchet.secretKey);
          draftSession.previousSendChainLength = draftSession.sendChainIndex;
          draftSession.sendChainIndex = 0;
        } finally {
          clearBytes(dhOutputSend, finalRootKey, newSendChainKey, newSendRatchet.secretKey);
        }
      } finally {
        clearBytes(sendRatchetPrivKey, currentRootKey, dhOutput, newRootKey, newRecvChainKey);
      }
    }

    // 2. Perform Chain Ratchet
    if (!(await this.skipMessageKeys(draftSession, msg.header.n))) {
      return null;
    }

    const recvChainKey = draftSession.recvChainKey;
    if (!recvChainKey) {
      return null;
    }

    const currentRecvChainKey = decodeBase64(recvChainKey);
    let nextRecvChainKey: Uint8Array | null = null;
    let messageKey: Uint8Array | null = null;
    try {
      [nextRecvChainKey, messageKey] = await RatchetSession.kdfChain(currentRecvChainKey);
      draftSession.recvChainKey = encodeBase64(nextRecvChainKey);
      draftSession.recvChainIndex++;

      // 3. Decrypt
      const plaintext = this.decryptWithMessageKey(msg.ciphertext, messageKey, msg.header);
      if (!plaintext) {
        return null;
      }

      Object.assign(session, draftSession);
      return plaintext;
    } finally {
      clearBytes(currentRecvChainKey, nextRecvChainKey, messageKey);
    }
  }
}
