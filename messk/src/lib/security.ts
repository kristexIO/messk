const encoder = new TextEncoder();
const PIN_HASH_PREFIX = 'pbkdf2:v1';
const PIN_HASH_ITERATIONS = 210_000;

type StoredSettings = {
  pinHash?: string | null;
};

function readSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem('messenger_settings');
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
  localStorage.setItem('messenger_settings', JSON.stringify(nextSettings));
}

async function digestPin(pin: string): Promise<string> {
  const bytes = encoder.encode(pin);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
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
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt, PIN_HASH_ITERATIONS);
  return [
    PIN_HASH_PREFIX,
    PIN_HASH_ITERATIONS.toString(),
    bytesToBase64(salt),
    bytesToBase64(hash),
  ].join(':');
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
    const actual = await derivePinHash(pin, salt, iterations);
    return constantTimeEqual(actual, expected);
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
