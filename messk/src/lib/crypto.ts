import { box, randomBytes } from 'tweetnacl';
import { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';

export interface KeyPair {
  publicKey: string;  // Base64
  secretKey: string;  // Base64
}

const X3DH_INFO = new TextEncoder().encode('messk-x3dh-v2-root-key');
const X3DH_SALT = new Uint8Array(32);

async function deriveX3DHRootKey(inputKeyMaterial: Uint8Array): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(inputKeyMaterial);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'HKDF',
      false,
      ['deriveBits']
    );
  } finally {
    keyBytes.fill(0);
  }
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: X3DH_SALT,
      info: X3DH_INFO,
    },
    key,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Encrypts a string message for a specific recipient
 * @param message The plaintext message
 * @param senderSecretKey Base64 sender's secret key
 * @param recipientPublicKey Base64 recipient's public key
 * @returns Base64 encoded payload (nonce + encrypted message)
 */
export function encryptMessage(
  message: string,
  senderSecretKey: string,
  recipientPublicKey: string
): string {
  const nonce = randomBytes(box.nonceLength);
  const messageUint8 = decodeUTF8(message);
  let senderSecretUint8: Uint8Array | null = null;

  try {
    senderSecretUint8 = decodeBase64(senderSecretKey);
    const recipientPublicUint8 = decodeBase64(recipientPublicKey);
    const encrypted = box(
      messageUint8,
      nonce,
      recipientPublicUint8,
      senderSecretUint8
    );

    // Pack nonce + encrypted message together so the recipient can decrypt
    // Structure: [24 bytes nonce][...encrypted message]
    const fullMessage = new Uint8Array(nonce.length + encrypted.length);
    fullMessage.set(nonce);
    fullMessage.set(encrypted, nonce.length);

    return encodeBase64(fullMessage);
  } finally {
    messageUint8.fill(0);
    senderSecretUint8?.fill(0);
  }
}

/**
 * Decrypts a network payload
 * @param payload Base64 (nonce + encrypted message)
 * @param recipientSecretKey Base64 recipient's secret key
 * @param senderPublicKey Base64 sender's public key
 * @returns Plaintext string, or null if decryption fails
 */
export function decryptMessage(
  payload: string,
  recipientSecretKey: string,
  senderPublicKey: string
): string | null {
  let recipientSecretUint8: Uint8Array | null = null;
  let decrypted: Uint8Array | null = null;
  try {
    const messageWithNonce = decodeBase64(payload);

    // Extract nonce (first 24 bytes)
    const nonce = messageWithNonce.slice(0, box.nonceLength);
    // Extract the actual encrypted message
    const encryptedMessage = messageWithNonce.slice(box.nonceLength);

    recipientSecretUint8 = decodeBase64(recipientSecretKey);
    const senderPublicUint8 = decodeBase64(senderPublicKey);

    decrypted = box.open(
      encryptedMessage,
      nonce,
      senderPublicUint8,
      recipientSecretUint8
    );

    if (!decrypted) {
      return null;
    }

    return encodeUTF8(decrypted);
  } catch (error) {
    console.error("Decryption error", error);
    return null;
  } finally {
    recipientSecretUint8?.fill(0);
    decrypted?.fill(0);
  }
}

export async function x3dhInitiate(
  myIdentityPriv: string,
  _myIdentityPub: string,
  peerIdentityPub: string,
  peerPreKeyPub: string | null,
  peerPQCPubKey: string | null
): Promise<{ sharedSecret: Uint8Array; ephemeralPub: string; pqcCiphertext?: string }> {
  const ephemeral = box.keyPair();
  let myPriv: Uint8Array | null = null;
  let dh1: Uint8Array | null = null;
  let dh2: Uint8Array | null = null;
  let dh3: Uint8Array | null = null;
  let combined: Uint8Array | null = null;
  try {
    myPriv = decodeBase64(myIdentityPriv);
    const peerPub = decodeBase64(peerIdentityPub);
    if (peerPreKeyPub) {
      const peerPrePub = decodeBase64(peerPreKeyPub);
      dh1 = box.before(peerPrePub, myPriv);
      dh3 = box.before(peerPrePub, ephemeral.secretKey);
    } else {
      dh1 = new Uint8Array(32);
      dh3 = new Uint8Array(32);
    }

    dh2 = box.before(peerPub, ephemeral.secretKey);

    if (peerPQCPubKey) {
      throw new Error('PQC handshake is disabled until a real ML-KEM implementation is available');
    }

    // The reserved zero component keeps the KDF shape stable while PQC is disabled.
    combined = new Uint8Array(32 * 4);
    combined.set(dh1, 0);
    combined.set(dh2, 32);
    combined.set(dh3, 64);

    return {
      sharedSecret: await deriveX3DHRootKey(combined),
      ephemeralPub: encodeBase64(ephemeral.publicKey)
    };
  } finally {
    myPriv?.fill(0);
    ephemeral.secretKey.fill(0);
    dh1?.fill(0);
    dh2?.fill(0);
    dh3?.fill(0);
    combined?.fill(0);
  }
}

/**
 * X3DH Initial Handshake (Responder side)
 */
export async function x3dhRespond(
  myIdentityPriv: string,
  myPreKeyPriv: string | null,
  myPQCPrivKey: string | null,
  peerIdentityPub: string,
  peerEphemeralPub: string,
  peerPQCCiphertext: string | null
): Promise<Uint8Array> {
  let myPriv: Uint8Array | null = null;
  let myPrePriv: Uint8Array | null = null;
  let dh1: Uint8Array | null = null;
  let dh2: Uint8Array | null = null;
  let dh3: Uint8Array | null = null;
  let combined: Uint8Array | null = null;
  try {
    myPriv = decodeBase64(myIdentityPriv);
    const peerPub = decodeBase64(peerIdentityPub);
    const peerEphPub = decodeBase64(peerEphemeralPub);
    if (myPreKeyPriv) {
      myPrePriv = decodeBase64(myPreKeyPriv);
      dh1 = box.before(peerPub, myPrePriv);
      dh3 = box.before(peerEphPub, myPrePriv);
    } else {
      dh1 = new Uint8Array(32);
      dh3 = new Uint8Array(32);
    }

    dh2 = box.before(peerEphPub, myPriv);

    if (myPQCPrivKey && peerPQCCiphertext) {
      throw new Error('PQC handshake is disabled until a real ML-KEM implementation is available');
    }

    combined = new Uint8Array(32 * 4);
    combined.set(dh1, 0);
    combined.set(dh2, 32);
    combined.set(dh3, 64);

    return await deriveX3DHRootKey(combined);
  } finally {
    myPriv?.fill(0);
    myPrePriv?.fill(0);
    dh1?.fill(0);
    dh2?.fill(0);
    dh3?.fill(0);
    combined?.fill(0);
  }
}
