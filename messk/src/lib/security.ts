import { REMEMBERED_IDENTITY_STORAGE_KEY, SETTINGS_STORAGE_KEY } from './storage';

const encoder = new TextEncoder();
const PIN_HASH_PREFIX = 'pbkdf2:v1';
const PIN_HASH_ITERATIONS = 210_000;
const REMEMBERED_IDENTITY_PREFIX = 'pinbox:v1';
const REMEMBERED_IDENTITY_ITERATIONS = 310_000;

type StoredSettings = {
  pinHash?: string | null;
};

type RememberedIdentityPayload = {
  publicKey: string;
  secretKey: string;
  savedAt: number;
};

type RememberedIdentityEnvelope = {
  version: string;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

function readSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredSettings : {};
  } catch {
    return {};
  }
}

function writeSettings(patch: StoredSettings): void {
  const nextSettings = {
    ...readSettings(),
    ...patch,
  };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
}

async function digestPin(pin: string): Promise<string> {
  const bytes = encoder.encode(pin);
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const digestBytes = new Uint8Array(digest);
    try {
      return Array.from(digestBytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } finally {
      digestBytes.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function derivePinHash(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const saltBytes = new Uint8Array(salt);
  const saltBuffer = saltBytes.buffer.slice(
    saltBytes.byteOffset,
    saltBytes.byteOffset + saltBytes.byteLength
  );
  const pinBytes = encoder.encode(pin);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      pinBytes,
      'PBKDF2',
      false,
      ['deriveBits']
    );
  } finally {
    pinBytes.fill(0);
  }
  try {
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: saltBuffer,
        iterations,
      },
      key,
      256
    );
    return new Uint8Array(bits);
  } finally {
    saltBytes.fill(0);
  }
}

async function derivePinAesKey(
  pin: string,
  salt: Uint8Array,
  iterations: number,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const pinBytes = encoder.encode(pin);
  let keyMaterial: CryptoKey;
  try {
    keyMaterial = await crypto.subtle.importKey(
      'raw',
      pinBytes,
      'PBKDF2',
      false,
      ['deriveKey']
    );
  } finally {
    pinBytes.fill(0);
  }

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      iterations,
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    usages
  );
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt, PIN_HASH_ITERATIONS);
  try {
    return [
      PIN_HASH_PREFIX,
      PIN_HASH_ITERATIONS.toString(),
      bytesToBase64(salt),
      bytesToBase64(hash),
    ].join(':');
  } finally {
    hash.fill(0);
  }
}

export async function verifyPin(pin: string, expectedHash: string): Promise<boolean> {
  if (!expectedHash.startsWith(`${PIN_HASH_PREFIX}:`)) {
    return (await digestPin(pin)) === expectedHash;
  }

  const parts = expectedHash.split(':');
  if (parts.length !== 5) {
    return false;
  }

  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }

  try {
    const salt = base64ToBytes(parts[3]);
    const expected = base64ToBytes(parts[4]);
    let actual: Uint8Array | null = null;
    try {
      actual = await derivePinHash(pin, salt, iterations);
      return constantTimeEqual(actual, expected);
    } finally {
      actual?.fill(0);
      expected.fill(0);
    }
  } catch {
    return false;
  }
}

export function getStoredPinHash(): string | null {
  return readSettings().pinHash ?? null;
}

export function persistPinHash(pinHash: string | null): void {
  writeSettings({ pinHash });
}

export function hasRememberedIdentity(): boolean {
  return Boolean(localStorage.getItem(REMEMBERED_IDENTITY_STORAGE_KEY));
}

export function clearRememberedIdentity(): void {
  localStorage.removeItem(REMEMBERED_IDENTITY_STORAGE_KEY);
}

export async function rememberIdentityWithPin(
  publicKey: string,
  secretKey: string,
  pin: string
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePinAesKey(pin, salt, REMEMBERED_IDENTITY_ITERATIONS, ['encrypt']);
  const payload = encoder.encode(
    JSON.stringify({
      publicKey,
      secretKey,
      savedAt: Date.now(),
    } satisfies RememberedIdentityPayload)
  );
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, payload);
    const envelope: RememberedIdentityEnvelope = {
      version: REMEMBERED_IDENTITY_PREFIX,
      iterations: REMEMBERED_IDENTITY_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
    localStorage.setItem(REMEMBERED_IDENTITY_STORAGE_KEY, JSON.stringify(envelope));
  } finally {
    payload.fill(0);
  }
}

export async function restoreRememberedIdentityWithPin(
  pin: string
): Promise<{ publicKey: string; secretKey: string } | null> {
  const raw = localStorage.getItem(REMEMBERED_IDENTITY_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const envelope = JSON.parse(raw) as Partial<RememberedIdentityEnvelope>;
    if (
      envelope.version !== REMEMBERED_IDENTITY_PREFIX ||
      typeof envelope.iterations !== 'number' ||
      typeof envelope.salt !== 'string' ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.ciphertext !== 'string'
    ) {
      return null;
    }

    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const key = await derivePinAesKey(pin, salt, envelope.iterations, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext)
    );
    const plaintextBytes = new Uint8Array(plaintext);
    try {
      const payload = JSON.parse(new TextDecoder().decode(plaintextBytes)) as Partial<RememberedIdentityPayload>;

      if (typeof payload.publicKey !== 'string' || typeof payload.secretKey !== 'string') {
        return null;
      }

      return {
        publicKey: payload.publicKey,
        secretKey: payload.secretKey,
      };
    } finally {
      plaintextBytes.fill(0);
    }
  } catch {
    return null;
  }
}
