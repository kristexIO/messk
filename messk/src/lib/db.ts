import Dexie, { type Table } from 'dexie';
import { randomBytes, secretbox } from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { parseRichTextMessage } from './message-format';

export interface MyKeyPair {
  id?: number;
  publicKey: string; // Base64
  secretKey: string; // Base64
}

export interface StoredMessage {
  id?: number;
  msgId: string; // UUID сообщения
  peerPublicKey: string; // the person we are chatting with
  senderPublicKey: string; // who actually sent it (could be us or them)
  text: string;
  timestamp: number;
  status: 'pending' | 'sent' | 'delivered' | 'read';
  reactions?: Record<string, string>;
  editedAt?: number;
  deletedAt?: number;
  editedBy?: string;
  deletedBy?: string;
  expiresAt?: number; // For disappearing messages
}

export interface Contact {
  pubKey: string;
  name: string;
  avatar?: string | null;
  lastMessageAt?: number;
  pinned?: boolean;
  draft?: string;
  archived?: boolean;
  mutedUntil?: number;
  verifiedIdentityFingerprint?: string;
  verifiedIdentityAt?: number;
}

export interface ThreadStat {
  threadId: string;
  unreadCount: number;
  lastMessagePreview?: string;
  lastMessageAt?: number;
}

export interface GroupThread {
  id: string;
  title: string;
  avatar?: string | null;
  role: string;
  members: string[];
  memberCount: number;
  createdAt: number;
  lastActivityAt?: number;
}

export interface ChannelThread {
  id: string;
  title: string;
  avatar?: string | null;
  role: string;
  ownerPubKey: string;
  subscriberCount: number;
  pinnedMsgId?: string | null;
  createdAt: number;
  lastActivityAt?: number;
}

export interface ChannelActivityEntry {
  id: string;
  channelId: string;
  type:
    | 'post_edited'
    | 'post_deleted'
    | 'post_pinned'
    | 'post_unpinned'
    | 'subscriber_added'
    | 'subscriber_removed'
    | 'role_changed'
    | 'ownership_transferred'
    | 'channel_deleted'
    | 'channel_left';
  actorPubKey: string;
  targetPubKey?: string;
  msgId?: string;
  details?: string;
  createdAt: number;
}

export interface GroupInvite {
  id: string;
  groupId: string;
  title: string;
  avatar?: string | null;
  inviterPubKey: string;
  role: string;
  memberCount: number;
  createdAt: number;
}

export interface OutgoingGroupEvent {
  id: string;
  type: 'group_message' | 'group_edit' | 'group_delete' | 'group_reaction';
  groupId: string;
  senderPubKey: string;
  data?: string;
  targetMsgId?: string;
  reaction?: string | null;
  createdAt: number;
}

export interface OutgoingDirectMessage {
  id: string;
  recipientPubKey: string;
  senderPubKey: string;
  data: string;
  createdAt: number;
  lastAttemptAt?: number;
  attempts: number;
}

export interface CallHistoryEntry {
  id: string;
  peerPubKey: string;
  direction: 'incoming' | 'outgoing';
  media: 'audio' | 'video';
  outcome: 'started' | 'connected' | 'missed' | 'declined' | 'ended' | 'failed';
  createdAt: number;
  endedAt?: number;
}

export interface GroupSenderKey {
  id: string;
  groupId: string;
  senderPubKey: string;
  key: string;
  memberFingerprint: string;
  createdAt: number;
  distributedAt?: number;
}

export interface Session {
  peerPublicKey: string;
  rootKey: string; // Base64
  sendChainKey: string | null; // Base64
  recvChainKey: string | null; // Base64
  sendRatchetPubKey: string; // Base64
  sendRatchetPrivKey: string; // Base64
  recvRatchetPubKey: string | null; // Base64
  sendChainIndex: number;
  recvChainIndex: number;
  previousSendChainLength: number;
  skippedKeys: Record<string, string>; // { "ratchetPubKey:index": "messageKey" }
  pqcSharedSecret?: string; // For Post-Quantum Security
}

export interface PreKey {
  id?: number;
  publicKey: string; // Base64
  secretKey: string; // Base64
}

const ENCRYPTED_PREFIX = 'enc:v1:';
const SESSION_SECRET_FIELDS = [
  'rootKey',
  'sendChainKey',
  'recvChainKey',
  'sendRatchetPrivKey',
  'recvRatchetPubKey',
  'skippedKeys',
  'pqcSharedSecret'
] as const;
const MESSAGE_SECRET_FIELDS = ['text', 'reactions'] as const;
const CONTACT_SECRET_FIELDS = ['draft'] as const;
const KEYPAIR_SECRET_FIELDS = ['secretKey'] as const;
const PREKEY_SECRET_FIELDS = ['secretKey'] as const;
const GROUP_SENDER_KEY_SECRET_FIELDS = ['key'] as const;
const DEFAULT_DB_NAME = 'MessengerDB';

let vaultKey: Uint8Array | null = null;
let vaultResetScheduled = false;

type MutableRecord = Record<string, unknown>;

function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function serializeSecretValue(value: unknown): string {
  if (value === undefined) {
    return JSON.stringify({ __type: 'undefined' });
  }
  return JSON.stringify(value);
}

function deserializeSecretValue<T>(value: string): T {
  const parsed = JSON.parse(value) as T | { __type: 'undefined' };
  if (typeof parsed === 'object' && parsed !== null && '__type' in parsed && parsed.__type === 'undefined') {
    return undefined as T;
  }
  return parsed as T;
}

function deriveVaultSubKey(field: string): Uint8Array {
  if (!vaultKey) {
    throw new Error('Cannot persist sensitive local data until keys are unlocked');
  }

  const nonce = deriveFieldNonce(`messk-local-vault:${field}`);
  const stream = secretbox(new Uint8Array(32), nonce, vaultKey);
  return stream.slice(0, 32);
}

function deriveFieldNonce(label: string): Uint8Array {
  const bytes = new TextEncoder().encode(label);
  const nonce = new Uint8Array(secretbox.nonceLength);
  let hash = 0x811c9dc5;

  for (let round = 0; round < nonce.length; round++) {
    hash ^= round + 1;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    nonce[round] = hash & 0xff;
  }

  return nonce;
}

function encryptSecretValue(value: unknown, field = 'default'): string {
  if (!vaultKey) {
    throw new Error('Cannot persist sensitive local data until keys are unlocked');
  }

  const encryptionKey = deriveVaultSubKey(field);
  const nonce = new Uint8Array(randomBytes(secretbox.nonceLength));
  const plaintext = new Uint8Array(new TextEncoder().encode(serializeSecretValue(value)));
  const ciphertext = secretbox(plaintext, nonce, encryptionKey);
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce);
  packed.set(ciphertext, nonce.length);
  return `${ENCRYPTED_PREFIX}${encodeBase64(packed)}`;
}

function decryptSecretValue<T>(value: unknown, field = 'default'): T {
  if (!isEncryptedValue(value)) {
    return value as T;
  }

  if (!vaultKey) {
    throw new Error('Encrypted local data is unavailable until keys are unlocked');
  }

  const packed = decodeBase64(value.slice(ENCRYPTED_PREFIX.length));
  const nonce = packed.slice(0, secretbox.nonceLength);
  const ciphertext = packed.slice(secretbox.nonceLength);
  let plaintext = secretbox.open(ciphertext, nonce, deriveVaultSubKey(field));
  if (!plaintext) {
    // Existing installs may have records encrypted with the original raw vault key.
    plaintext = secretbox.open(ciphertext, nonce, vaultKey);
  }
  if (!plaintext) {
    scheduleVaultReset(field);
    return getFieldFallback(field) as T;
  }

  return deserializeSecretValue<T>(new TextDecoder().decode(plaintext));
}

function getFieldFallback(field: string): unknown {
  switch (field) {
    case 'text':
      return '[Unable to decrypt local message]';
    case 'reactions':
    case 'skippedKeys':
      return {};
    case 'draft':
      return undefined;
    case 'recvChainKey':
    case 'sendChainKey':
    case 'recvRatchetPubKey':
    case 'pqcSharedSecret':
      return null;
    default:
      return '';
  }
}

function scheduleVaultReset(field: string) {
  if (vaultResetScheduled || typeof window === 'undefined') {
    return;
  }

  vaultResetScheduled = true;
  console.error(`Failed to decrypt secure local field "${field}". Falling back without resetting the local cache.`);
}



function mutateFields(
  value: MutableRecord,
  fields: readonly string[],
  transformer: (fieldValue: unknown, field: string) => unknown
) {
  for (const field of fields) {
    if (field in value) {
      value[field] = transformer(value[field], field);
    }
  }
}

function encryptFields<T>(
  value: T,
  fields: readonly string[]
): void {
  if (!value) return;

  const mutableValue = value as MutableRecord;

  const hasSensitiveField = fields.some((field) => field in mutableValue);
  if (!hasSensitiveField) return;

  if (!vaultKey) {
    throw new Error('Cannot persist sensitive local data until keys are unlocked');
  }

  mutateFields(mutableValue, fields, encryptSecretValue);
}

function decryptFields<T>(
  value: T,
  fields: readonly string[]
): T {
  if (!value) {
    return value;
  }

  // No need to clone on read, as mutating the object for the app view is safe
  mutateFields(value as MutableRecord, fields, decryptSecretValue);
  return value;
}

export function setVaultKey(secretKeyBase64: string | null) {
  vaultKey = secretKeyBase64 ? new Uint8Array(decodeBase64(secretKeyBase64)) : null;
}

export function getDatabaseNameForIdentity(publicKey: string | null) {
  if (!publicKey) {
    return DEFAULT_DB_NAME;
  }
  const safeKey = publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${DEFAULT_DB_NAME}-${safeKey}`;
}

export function switchActiveDatabase(publicKey: string | null) {
  const nextName = getDatabaseNameForIdentity(publicKey);
  if (db.name === nextName) {
    vaultResetScheduled = false;
    return db;
  }

  db.close();
  db = new MessengerDatabase(nextName);
  vaultResetScheduled = false;
  return db;
}

export async function prepareDatabaseForIdentity(publicKey: string, databaseName?: string) {
  if (databaseName) {
    vaultResetScheduled = false;
    return new MessengerDatabase(databaseName);
  }
  return switchActiveDatabase(publicKey);
}

export async function persistIdentityKeyPair(
  publicKey: string,
  secretKey: string,
  database = db
) {
  await database.transaction('rw', [database.keypairs], async () => {
    await database.keypairs.clear();
    await database.keypairs.put({ publicKey, secretKey });
  });
}

export async function migrateLocalDataToEncryptedAtRest(database = db) {
  if (!vaultKey) {
    throw new Error('Cannot migrate local data until keys are unlocked');
  }

  await database.transaction(
    'rw',
    [
      database.keypairs,
      database.messages,
      database.contacts,
      database.sessions,
      database.prekeys,
      database.groupSenderKeys,
    ],
    async () => {
      await rewriteTable(database.keypairs, KEYPAIR_SECRET_FIELDS);
      await rewriteTable(database.messages, MESSAGE_SECRET_FIELDS);
      await rewriteTable(database.contacts, CONTACT_SECRET_FIELDS);
      await rewriteTable(database.sessions, SESSION_SECRET_FIELDS);
      await rewriteTable(database.prekeys, PREKEY_SECRET_FIELDS);
      await rewriteTable(database.groupSenderKeys, GROUP_SENDER_KEY_SECRET_FIELDS);
    }
  );
}

function migrateEncryptedFields(value: MutableRecord, fields: readonly string[]) {
  for (const field of fields) {
    if (!(field in value) || isEncryptedValue(value[field])) {
      continue;
    }
    value[field] = encryptSecretValue(value[field], field);
  }
}

async function rewriteTable<T, Key>(table: Table<T, Key>, fields: readonly string[]) {
  await table.toCollection().modify((value) => {
    if (typeof value === 'object' && value !== null) {
      migrateEncryptedFields(value as MutableRecord, fields);
    }
  });
}

export class MessengerDatabase extends Dexie {
  keypairs!: Table<MyKeyPair, number>;
  messages!: Table<StoredMessage, number>;
  contacts!: Table<Contact, string>;
  threadStats!: Table<ThreadStat, string>;
  groupThreads!: Table<GroupThread, string>;
  channelThreads!: Table<ChannelThread, string>;
  channelActivity!: Table<ChannelActivityEntry, string>;
  groupInvites!: Table<GroupInvite, string>;
  outgoingGroupEvents!: Table<OutgoingGroupEvent, string>;
  outgoingDirectMessages!: Table<OutgoingDirectMessage, string>;
  callHistory!: Table<CallHistoryEntry, string>;
  groupSenderKeys!: Table<GroupSenderKey, string>;
  sessions!: Table<Session, string>;
  prekeys!: Table<PreKey, number>;

  constructor(name = DEFAULT_DB_NAME) {
    super(name);
    
    this.version(1).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, peerPublicKey, timestamp'
    });

    this.version(2).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt'
    });

    this.version(3).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(4).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(5).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(6).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(7).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      groupInvites: '&id, groupId, createdAt',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(8).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      groupInvites: '&id, groupId, createdAt',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(9).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      channelThreads: '&id, lastActivityAt, createdAt, title',
      groupInvites: '&id, groupId, createdAt',
      channelActivity: '&id, channelId, createdAt, type',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(10).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp',
      contacts: '&pubKey, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      channelThreads: '&id, lastActivityAt, createdAt, title',
      channelActivity: '&id, channelId, createdAt, type',
      groupInvites: '&id, groupId, createdAt',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(11).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp, [peerPublicKey+timestamp]',
      contacts: '&pubKey, lastMessageAt',
      threadStats: '&threadId, unreadCount, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      channelThreads: '&id, lastActivityAt, createdAt, title',
      channelActivity: '&id, channelId, createdAt, type',
      groupInvites: '&id, groupId, createdAt',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(12).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp, [peerPublicKey+timestamp]',
      contacts: '&pubKey, lastMessageAt',
      threadStats: '&threadId, unreadCount, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      channelThreads: '&id, lastActivityAt, createdAt, title',
      channelActivity: '&id, channelId, createdAt, type',
      groupInvites: '&id, groupId, createdAt',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(13).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp, [peerPublicKey+timestamp]',
      contacts: '&pubKey, lastMessageAt',
      threadStats: '&threadId, unreadCount, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      channelThreads: '&id, lastActivityAt, createdAt, title',
      channelActivity: '&id, channelId, createdAt, [channelId+createdAt], type',
      groupInvites: '&id, groupId, createdAt',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.version(14).stores({
      keypairs: '++id, &publicKey',
      messages: '++id, &msgId, peerPublicKey, timestamp, [peerPublicKey+timestamp]',
      contacts: '&pubKey, lastMessageAt',
      threadStats: '&threadId, unreadCount, lastMessageAt',
      groupThreads: '&id, lastActivityAt, createdAt, title',
      channelThreads: '&id, lastActivityAt, createdAt, title',
      channelActivity: '&id, channelId, createdAt, [channelId+createdAt], type',
      groupInvites: '&id, groupId, createdAt',
      outgoingGroupEvents: '&id, groupId, createdAt, type',
      outgoingDirectMessages: '&id, recipientPubKey, createdAt, lastAttemptAt',
      callHistory: '&id, peerPubKey, createdAt, outcome',
      groupSenderKeys: '&id, groupId, senderPubKey, createdAt',
      sessions: '&peerPublicKey',
      prekeys: '++id, &publicKey'
    });

    this.table('keypairs').hook('creating', (_primKey, obj) => encryptFields(obj, KEYPAIR_SECRET_FIELDS));
    this.table('keypairs').hook('updating', (mods) => encryptFields(mods, KEYPAIR_SECRET_FIELDS));
    this.table('keypairs').hook('reading', (obj) => decryptFields(obj, KEYPAIR_SECRET_FIELDS));

    this.table('messages').hook('creating', (_primKey, obj) => encryptFields(obj, MESSAGE_SECRET_FIELDS));
    this.table('messages').hook('updating', (mods) => encryptFields(mods, MESSAGE_SECRET_FIELDS));
    this.table('messages').hook('reading', (obj) => decryptFields(obj, MESSAGE_SECRET_FIELDS));

    this.table('contacts').hook('creating', (_primKey, obj) => encryptFields(obj, CONTACT_SECRET_FIELDS));
    this.table('contacts').hook('updating', (mods) => encryptFields(mods, CONTACT_SECRET_FIELDS));
    this.table('contacts').hook('reading', (obj) => decryptFields(obj, CONTACT_SECRET_FIELDS));

    this.table('groupSenderKeys').hook('creating', (_primKey, obj) => encryptFields(obj, GROUP_SENDER_KEY_SECRET_FIELDS));
    this.table('groupSenderKeys').hook('updating', (mods) => encryptFields(mods, GROUP_SENDER_KEY_SECRET_FIELDS));
    this.table('groupSenderKeys').hook('reading', (obj) => decryptFields(obj, GROUP_SENDER_KEY_SECRET_FIELDS));

    this.table('sessions').hook('creating', (_primKey, obj) => encryptFields(obj, SESSION_SECRET_FIELDS));
    this.table('sessions').hook('updating', (mods) => encryptFields(mods, SESSION_SECRET_FIELDS));
    this.table('sessions').hook('reading', (obj) => decryptFields(obj, SESSION_SECRET_FIELDS));

    this.table('prekeys').hook('creating', (_primKey, obj) => encryptFields(obj, PREKEY_SECRET_FIELDS));
    this.table('prekeys').hook('updating', (mods) => encryptFields(mods, PREKEY_SECRET_FIELDS));
    this.table('prekeys').hook('reading', (obj) => decryptFields(obj, PREKEY_SECRET_FIELDS));
  }
}

export let db = new MessengerDatabase();

function previewThreadMessage(message: Pick<StoredMessage, 'text' | 'deletedAt'>) {
  if (message.deletedAt) {
    return 'Message deleted';
  }
  if (message.text.startsWith('{"type":"file"')) {
    return 'Attachment';
  }
  if (message.text.startsWith('{"type":"voice"')) {
    return 'Voice message';
  }
  return parseRichTextMessage(message.text).text;
}

async function getCurrentIdentityPublicKey(database: MessengerDatabase = db) {
  const identity = await database.keypairs.toCollection().first();
  return identity?.publicKey ?? null;
}

export async function syncThreadStats(threadId: string, database: MessengerDatabase = db) {
  if (!threadId) return;

  const [messages, myPublicKey] = await Promise.all([
    database.messages.where('peerPublicKey').equals(threadId).toArray(),
    getCurrentIdentityPublicKey(database),
  ]);

  if (messages.length === 0) {
    await database.threadStats.delete(threadId);
    return;
  }

  const latestMessage = messages.reduce((current, message) => {
    if (!current || message.timestamp >= current.timestamp) {
      return message;
    }
    return current;
  }, undefined as StoredMessage | undefined);

  const unreadCount = messages.reduce((total, message) => {
    if (myPublicKey && message.senderPublicKey !== myPublicKey && message.status !== 'read') {
      return total + 1;
    }
    return total;
  }, 0);

  await database.threadStats.put({
    threadId,
    unreadCount,
    lastMessagePreview: latestMessage ? previewThreadMessage(latestMessage) : undefined,
    lastMessageAt: latestMessage?.timestamp,
  });
}

export async function syncThreadStatsForMany(threadIds: string[], database: MessengerDatabase = db) {
  const uniqueThreadIds = [...new Set(threadIds.filter((threadId) => typeof threadId === 'string' && threadId.length > 0))];
  await Promise.all(uniqueThreadIds.map((threadId) => syncThreadStats(threadId, database)));
}

export async function rebuildAllThreadStats(database: MessengerDatabase = db) {
  const messages = await database.messages.toArray();
  const threadIds = [...new Set(messages.map((message) => message.peerPublicKey))];
  await database.threadStats.clear();
  await syncThreadStatsForMany(threadIds, database);
}

export async function clearThreadStats(threadId: string, database: MessengerDatabase = db) {
  if (!threadId) return;
  await database.threadStats.delete(threadId);
}
