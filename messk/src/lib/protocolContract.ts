export const DIRECT_EVENT_TYPES = [
  'message',
  'edit',
  'delete',
  'reaction',
  'reply',
  'pin',
  'unpin',
  'attachment',
  'forward',
] as const;

export const TRANSPORT_KINDS = [
  'central_ws',
  'mesh_relay',
  'direct_p2p',
  'fallback_wss',
  'user_proxy',
] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export const DEFAULT_TRANSPORT_PRIORITY: TransportKind[] = [
  'central_ws',
  'mesh_relay',
  'direct_p2p',
  'fallback_wss',
  'user_proxy',
];

export const MESH_PROTOCOL_VERSION = 1;
export const MESH_TOPIC_PREFIX = 'messk/v1';
export const MESH_THREAD_KINDS = ['direct', 'group', 'channel'] as const;
export const MESH_DEFAULT_HOP_LIMIT = 3;
export const MESH_MAX_HOP_LIMIT = 8;
export const MESH_MAX_CIPHERTEXT_LEN = 1024 * 1024;

export type MeshThreadKind = (typeof MESH_THREAD_KINDS)[number];

export type BlindMeshEnvelope = {
  v: number;
  topic: string;
  msgId: string;
  ciphertext: string;
  hopLimit: number;
  expiresAtMs: number;
};

export const PADDING_PROFILES = ['disabled', 'interactive', 'balanced', 'high_privacy'] as const;

export type PaddingProfile = (typeof PADDING_PROFILES)[number];

export const PADDING_BUCKETS: Record<PaddingProfile, readonly number[]> = {
  disabled: [],
  interactive: [256, 1024, 4096, 16 * 1024],
  balanced: [2 * 1024, 16 * 1024, 64 * 1024],
  high_privacy: [16 * 1024, 64 * 1024, 256 * 1024],
};

export type MetadataBatchPolicy = {
  minBatchDelayMs: number;
  maxBatchDelayMs: number;
};

export const DEFAULT_METADATA_BATCH_POLICY: MetadataBatchPolicy = {
  minBatchDelayMs: 0,
  maxBatchDelayMs: 250,
};

export const SERVER_ACK_TYPES = new Set([
  'dummy',
  'message',
  'session_repair',
  'group_message',
  'group_edit',
  'group_delete',
  'group_reaction',
  'group_sender_key',
  'channel_message',
  'channel_edit',
  'channel_delete',
  'channel_reaction',
  'channel_pin',
  'delivery_receipt',
  'read_receipt',
  'edit',
  'delete',
  'reaction',
  'reply',
  'pin',
  'unpin',
  'attachment',
  'forward',
]);

export function isDirectHistoryEvent(type: string) {
  return (DIRECT_EVENT_TYPES as readonly string[]).includes(type);
}

export function isSupportedTransportKind(type: string): type is TransportKind {
  return (TRANSPORT_KINDS as readonly string[]).includes(type);
}

export function normalizeTransportPriority(priority: string[]): TransportKind[] {
  const seen = new Set<string>();
  const normalized = priority.filter((kind): kind is TransportKind => {
    if (!isSupportedTransportKind(kind) || seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
  return normalized.length ? normalized : [...DEFAULT_TRANSPORT_PRIORITY];
}

export function meshTopic(kind: MeshThreadKind, threadId: string) {
  const normalizedThreadId = normalizeMeshTopicSegment(threadId);
  if (!normalizedThreadId) return null;
  return `${MESH_TOPIC_PREFIX}/${kind}/${normalizedThreadId}`;
}

export function isValidMeshTopic(topic: string) {
  if (!topic.startsWith(`${MESH_TOPIC_PREFIX}/`)) return false;
  const [, , kind, threadId, extra] = topic.split('/');
  return Boolean(kind && threadId && !extra && isMeshThreadKind(kind) && normalizeMeshTopicSegment(threadId));
}

export function createBlindMeshEnvelope(
  kind: MeshThreadKind,
  threadId: string,
  msgId: string,
  ciphertext: string,
  expiresAtMs: number
): BlindMeshEnvelope | null {
  const topic = meshTopic(kind, threadId);
  const normalizedMsgId = normalizeMeshMessageId(msgId);
  if (!topic || !normalizedMsgId || !ciphertext.trim() || ciphertext.length > MESH_MAX_CIPHERTEXT_LEN) {
    return null;
  }
  return {
    v: MESH_PROTOCOL_VERSION,
    topic,
    msgId: normalizedMsgId,
    ciphertext,
    hopLimit: MESH_DEFAULT_HOP_LIMIT,
    expiresAtMs,
  };
}

export function validateBlindMeshEnvelope(envelope: BlindMeshEnvelope, nowMs: number) {
  return (
    envelope.v === MESH_PROTOCOL_VERSION &&
    isValidMeshTopic(envelope.topic) &&
    normalizeMeshMessageId(envelope.msgId) === envelope.msgId &&
    Boolean(envelope.ciphertext.trim()) &&
    envelope.ciphertext.length <= MESH_MAX_CIPHERTEXT_LEN &&
    Number.isInteger(envelope.hopLimit) &&
    envelope.hopLimit >= 0 &&
    envelope.hopLimit <= MESH_MAX_HOP_LIMIT &&
    Number.isFinite(envelope.expiresAtMs) &&
    envelope.expiresAtMs > nowMs
  );
}

export function nextMeshHop(envelope: BlindMeshEnvelope): BlindMeshEnvelope | null {
  if (envelope.hopLimit <= 0) return null;
  return {
    ...envelope,
    hopLimit: envelope.hopLimit - 1,
  };
}

export function meshDedupeKey(topic: string, msgId: string) {
  return `${topic}:${msgId}`;
}

export function metadataPaddingTargetLen(profile: PaddingProfile, payloadLength: number) {
  if (profile === 'disabled') return Math.max(0, Math.floor(payloadLength));
  const length = Math.max(0, Math.floor(payloadLength));
  const buckets = PADDING_BUCKETS[profile];
  for (const bucket of buckets) {
    if (length <= bucket) return bucket;
  }
  const block = buckets[buckets.length - 1] || Math.max(1, length);
  return Math.ceil(length / block) * block;
}

export function metadataBatchDelayMs(policy: MetadataBatchPolicy, threadId: string, msgId: string) {
  const minMs = Math.max(0, Math.floor(policy.minBatchDelayMs));
  const maxMs = Math.max(minMs, Math.floor(policy.maxBatchDelayMs));
  const windowMs = maxMs - minMs;
  if (windowMs === 0) return minMs;
  return minMs + (stableMetadataHash32([threadId, msgId]) % (windowMs + 1));
}

export function requiresTargetMessageId(type: string) {
  return ['edit', 'delete', 'reaction', 'reply', 'pin', 'unpin'].includes(type);
}

export function requiresEncryptedData(type: string) {
  return ['message', 'dummy', 'edit', 'reply', 'attachment', 'forward', 'session_repair'].includes(type);
}

export function clampHistoryLimit(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    return 100;
  }
  return Math.floor(limit);
}

export type MessagePayloadKind = 'text' | 'voice' | 'attachment' | 'call' | 'deleted';

export type MessagePayloadPreview = {
  kind: MessagePayloadKind;
  title: string;
  detail: string;
};

export function coerceMessageText(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return '';
    }
  }
  return String(raw);
}

export function messagePayloadPreview(raw: unknown): MessagePayloadPreview | null {
  const trimmed = coerceMessageText(raw).trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const value = parsed as Record<string, unknown>;
  const payloadType = stringField(value, 'type').toLowerCase();
  switch (payloadType) {
    case 'text': {
      const text = firstString(value, ['text', 'message', 'body']);
      return text ? { kind: 'text', title: text, detail: '' } : null;
    }
    case 'voice':
    case 'audio':
    case 'voice_message':
      return { kind: 'voice', title: 'Voice message', detail: voicePayloadDetail(value) };
    case 'file':
    case 'attachment':
    case 'image':
    case 'video':
    case 'document':
      return {
        kind: 'attachment',
        title: firstString(value, ['name', 'filename', 'file_name', 'title']) || defaultAttachmentTitle(payloadType),
        detail: attachmentPayloadDetail(value),
      };
    case 'call':
    case 'voice_call':
    case 'video_call':
    case 'call_offer':
    case 'call_answer':
    case 'call_reject':
    case 'call_end':
    case 'call_missed':
    case 'call_ice':
    case 'ice_candidate': {
      const callKind = firstString(value, ['kind', 'media', 'call_type']) || (payloadType.includes('video') ? 'Video' : 'Voice');
      const state = firstString(value, ['status', 'state']) || callStatusFromType(payloadType);
      return {
        kind: 'call',
        title: `${titleCaseFirst(callKind)} call`,
        detail: titleCaseFirst(state.replace(/_/g, ' ')),
      };
    }
    case 'deleted':
      return { kind: 'deleted', title: 'Message deleted', detail: '' };
    default:
      return null;
  }
}

export function displayMessageText(raw: unknown): string {
  const trimmed = coerceMessageText(raw).trim();
  if (!trimmed) return '';

  const preview = messagePayloadPreview(trimmed);
  if (preview) {
    return preview.detail ? `${preview.title} - ${preview.detail}` : preview.title;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Plain text stays plain text.
  }
  return trimmed;
}

export function isDeletedMessagePayload(raw: unknown): boolean {
  return messagePayloadPreview(raw)?.kind === 'deleted';
}

function firstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = stringField(value, key).trim();
    if (candidate) return candidate;
  }
  return '';
}

function stringField(value: Record<string, unknown>, key: string) {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : '';
}

function voicePayloadDetail(value: Record<string, unknown>) {
  const parts: string[] = [];
  const duration = Number(value.duration);
  if (Number.isFinite(duration)) parts.push(formatVoiceDuration(duration));
  if (firstString(value, ['url', 'download_url'])) parts.push('download ready');
  return parts.length ? parts.join(' - ') : 'ready';
}

function attachmentPayloadDetail(value: Record<string, unknown>) {
  const parts: string[] = [];
  const mime = firstString(value, ['mime', 'mimeType', 'mime_type', 'content_type']);
  const size = Number(value.size);
  if (mime) parts.push(mime);
  if (Number.isFinite(size) && size >= 0) parts.push(formatFileSize(size));
  return parts.length ? parts.join(' - ') : 'encrypted file';
}

function defaultAttachmentTitle(payloadType: string) {
  if (payloadType === 'image') return 'Image';
  if (payloadType === 'video') return 'Video';
  if (payloadType === 'document') return 'Document';
  return 'Attachment';
}

function callStatusFromType(payloadType: string) {
  if (payloadType === 'call_offer') return 'ringing';
  if (payloadType === 'call_answer') return 'answered';
  if (payloadType === 'call_reject') return 'rejected';
  if (payloadType === 'call_end') return 'ended';
  if (payloadType === 'call_missed') return 'missed';
  if (payloadType === 'call_ice' || payloadType === 'ice_candidate') return 'connecting';
  return 'ready';
}

function formatVoiceDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function titleCaseFirst(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

function isMeshThreadKind(value: string): value is MeshThreadKind {
  return (MESH_THREAD_KINDS as readonly string[]).includes(value);
}

function normalizeMeshTopicSegment(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return /^[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeMeshMessageId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null;
}

function stableMetadataHash32(parts: string[]) {
  const encoder = new TextEncoder();
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (const byte of encoder.encode(part)) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
