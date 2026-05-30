import { db, rebuildAllThreadStats, type Contact, type StoredMessage } from './db';
import type { Theme } from '../store';
import { randomBytes, secretbox } from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';

export interface BackupPayload {
  version: 1;
  exportedAt: string;
  profile: {
    nickname: string | null;
    avatar: string | null;
    theme: Theme;
  };
  contacts: Contact[];
  messages: StoredMessage[];
}

export interface EncryptedBackupPayload {
  version: 2;
  encrypted: true;
  exportedAt: string;
  manifest: EncryptedBackupManifest;
  kdf: {
    name: 'PBKDF2-SHA256';
    iterations: number;
    salt: string;
  };
  cipher: {
    name: 'XSalsa20-Poly1305';
    nonce: string;
    ciphertext: string;
  };
}

export interface EncryptedBackupManifest {
  schema: 'messk.encrypted-backup.v2';
  content: {
    profile: true;
    contacts: number;
    messages: number;
  };
  excludes: Array<'identity_seed' | 'identity_secret_key' | 'ratchet_sessions' | 'prekeys' | 'group_sender_keys'>;
}

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_ITEMS = 100_000;
const BACKUP_KDF_ITERATIONS = 310_000;
const ENCRYPTED_BACKUP_EXCLUDES: EncryptedBackupManifest['excludes'] = [
  'identity_seed',
  'identity_secret_key',
  'ratchet_sessions',
  'prekeys',
  'group_sender_keys',
];

export async function createBackup(profile: {
  nickname: string | null;
  avatar: string | null;
  theme: Theme;
}): Promise<BackupPayload> {
  const [contacts, messages] = await Promise.all([
    db.contacts.toArray(),
    db.messages.toArray()
  ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    profile,
    contacts,
    messages
  };
}

export function downloadBackup(payload: BackupPayload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `messk-backup-${payload.exportedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function createEncryptedBackup(
  profile: {
    nickname: string | null;
    avatar: string | null;
    theme: Theme;
  },
  password: string
): Promise<EncryptedBackupPayload> {
  assertBackupPassword(password);

  const backup = await createBackup(profile);
  const salt = new Uint8Array(randomBytes(16));
  const nonce = new Uint8Array(randomBytes(secretbox.nonceLength));
  const key = await deriveBackupKey(password, salt, BACKUP_KDF_ITERATIONS);
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = new Uint8Array(new TextEncoder().encode(JSON.stringify(backup)));
    const ciphertext = secretbox(plaintext, nonce, key);

    return {
      version: 2,
      encrypted: true,
      exportedAt: backup.exportedAt,
      manifest: createEncryptedBackupManifest(backup),
      kdf: {
        name: 'PBKDF2-SHA256',
        iterations: BACKUP_KDF_ITERATIONS,
        salt: encodeBase64(salt),
      },
      cipher: {
        name: 'XSalsa20-Poly1305',
        nonce: encodeBase64(nonce),
        ciphertext: encodeBase64(ciphertext),
      },
    };
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

export function createEncryptedBackupManifest(payload: BackupPayload): EncryptedBackupManifest {
  return {
    schema: 'messk.encrypted-backup.v2',
    content: {
      profile: true,
      contacts: payload.contacts.length,
      messages: payload.messages.length,
    },
    excludes: [...ENCRYPTED_BACKUP_EXCLUDES],
  };
}

export function downloadEncryptedBackup(payload: EncryptedBackupPayload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `messk-encrypted-backup-${payload.exportedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function parseBackupFile(file: File, password?: string): Promise<BackupPayload> {
  if (typeof file.size === 'number' && file.size > MAX_BACKUP_BYTES) {
    throw new Error('Backup file is too large');
  }

  const text = await file.text();
  if (text.length > MAX_BACKUP_BYTES) {
    throw new Error('Backup file is too large');
  }

  const parsed = JSON.parse(text) as unknown;
  if (isEncryptedBackupPayload(parsed)) {
    if (!password) {
      throw new Error('Backup password is required');
    }
    return decryptBackupPayload(parsed, password);
  }

  return normalizeBackupPayload(parsed);
}

async function decryptBackupPayload(payload: EncryptedBackupPayload, password: string): Promise<BackupPayload> {
  assertBackupPassword(password);

  const salt = decodeBase64(payload.kdf.salt);
  const nonce = decodeBase64(payload.cipher.nonce);
  const ciphertext = decodeBase64(payload.cipher.ciphertext);
  if (nonce.length !== secretbox.nonceLength || salt.length < 16) {
    throw new Error('Unsupported backup format');
  }

  const key = await deriveBackupKey(password, salt, payload.kdf.iterations);
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = secretbox.open(ciphertext, nonce, key);
    if (!plaintext) {
      throw new Error('Invalid backup password or corrupted backup');
    }

    return normalizeBackupPayload(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

function normalizeBackupPayload(value: unknown): BackupPayload {
  if (!isRecord(value)) {
    throw new Error('Unsupported backup format');
  }

  const contacts = value.contacts;
  const messages = value.messages;
  const profile = value.profile;

  if (value.version !== 1 || !Array.isArray(contacts) || !Array.isArray(messages) || !isRecord(profile)) {
    throw new Error('Unsupported backup format');
  }
  if (contacts.length > MAX_BACKUP_ITEMS || messages.length > MAX_BACKUP_ITEMS) {
    throw new Error('Backup contains too many records');
  }

  return {
    version: 1,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : new Date().toISOString(),
    profile: {
      nickname: typeof profile.nickname === 'string' ? profile.nickname : null,
      avatar: typeof profile.avatar === 'string' ? profile.avatar : null,
      theme: isTheme(profile.theme) ? profile.theme : 'dark',
    },
    contacts: contacts.map(normalizeContact),
    messages: messages.map(normalizeMessage),
  };
}

export async function restoreBackup(payload: BackupPayload) {
  await db.transaction('rw', db.contacts, db.messages, async () => {
    await db.contacts.clear();
    await db.messages.clear();
    if (payload.contacts.length > 0) {
      await db.contacts.bulkPut(payload.contacts);
    }
    if (payload.messages.length > 0) {
      await db.messages.bulkPut(payload.messages);
    }
  });
  await rebuildAllThreadStats();
}

function normalizeContact(value: unknown): Contact {
  if (!isRecord(value) || typeof value.pubKey !== 'string' || typeof value.name !== 'string') {
    throw new Error('Unsupported backup format');
  }

  return {
    pubKey: value.pubKey,
    name: value.name,
    lastMessageAt: typeof value.lastMessageAt === 'number' ? value.lastMessageAt : undefined,
    pinned: typeof value.pinned === 'boolean' ? value.pinned : undefined,
    draft: typeof value.draft === 'string' ? value.draft : undefined,
  };
}

function normalizeMessage(value: unknown): StoredMessage {
  if (
    !isRecord(value) ||
    typeof value.msgId !== 'string' ||
    typeof value.peerPublicKey !== 'string' ||
    typeof value.senderPublicKey !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.timestamp !== 'number' ||
    !isMessageStatus(value.status)
  ) {
    throw new Error('Unsupported backup format');
  }

  return {
    msgId: value.msgId,
    peerPublicKey: value.peerPublicKey,
    senderPublicKey: value.senderPublicKey,
    text: value.text,
    timestamp: value.timestamp,
    status: value.status,
    reactions: isStringRecord(value.reactions) ? value.reactions : undefined,
    editedAt: typeof value.editedAt === 'number' ? value.editedAt : undefined,
    deletedAt: typeof value.deletedAt === 'number' ? value.deletedAt : undefined,
    expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEncryptedBackupPayload(value: unknown): value is EncryptedBackupPayload {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.encrypted === true &&
    isRecord(value.kdf) &&
    value.kdf.name === 'PBKDF2-SHA256' &&
    typeof value.kdf.iterations === 'number' &&
    value.kdf.iterations >= 100_000 &&
    typeof value.kdf.salt === 'string' &&
    isRecord(value.cipher) &&
    value.cipher.name === 'XSalsa20-Poly1305' &&
    typeof value.cipher.nonce === 'string' &&
    typeof value.cipher.ciphertext === 'string' &&
    typeof value.exportedAt === 'string'
  );
}

function assertBackupPassword(password: string) {
  if (password.length < 10) {
    throw new Error('Backup password must be at least 10 characters');
  }
}

async function deriveBackupKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password);
  let keyMaterial: CryptoKey;
  try {
    keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordBytes,
      'PBKDF2',
      false,
      ['deriveBits']
    );
  } finally {
    passwordBytes.fill(0);
  }
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new Uint8Array(salt).buffer,
      iterations,
    },
    keyMaterial,
    secretbox.keyLength * 8
  );
  return new Uint8Array(bits);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'dark' || value === 'light' || value === 'forest';
}

function isMessageStatus(value: unknown): value is StoredMessage['status'] {
  return value === 'pending' || value === 'sent' || value === 'delivered' || value === 'read' || value === 'failed';
}
