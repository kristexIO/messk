import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METADATA_BATCH_POLICY,
  DEFAULT_TRANSPORT_PRIORITY,
  SERVER_ACK_TYPES,
  clampHistoryLimit,
  createBlindMeshEnvelope,
  displayMessageText,
  isDirectHistoryEvent,
  isDeletedMessagePayload,
  isValidMeshTopic,
  isSupportedTransportKind,
  messagePayloadPreview,
  meshDedupeKey,
  meshTopic,
  metadataBatchDelayMs,
  metadataPaddingTargetLen,
  nextMeshHop,
  normalizeTransportPriority,
  requiresEncryptedData,
  requiresTargetMessageId,
  validateBlindMeshEnvelope,
} from './protocolContract';

describe('protocolContract', () => {
  it('keeps direct history events recoverable and acknowledged', () => {
    for (const type of ['message', 'edit', 'delete', 'reaction', 'reply', 'pin', 'unpin', 'attachment', 'forward']) {
      expect(isDirectHistoryEvent(type)).toBe(true);
      expect(SERVER_ACK_TYPES.has(type)).toBe(true);
    }
  });

  it('requires target ids only for mutating direct controls', () => {
    for (const type of ['edit', 'delete', 'reaction', 'reply', 'pin', 'unpin']) {
      expect(requiresTargetMessageId(type)).toBe(true);
    }
    expect(requiresTargetMessageId('message')).toBe(false);
    expect(requiresTargetMessageId('attachment')).toBe(false);
  });

  it('marks encrypted body events', () => {
    expect(requiresEncryptedData('message')).toBe(true);
    expect(requiresEncryptedData('dummy')).toBe(true);
    expect(SERVER_ACK_TYPES.has('dummy')).toBe(true);
    expect(requiresEncryptedData('edit')).toBe(true);
    expect(requiresEncryptedData('delete')).toBe(false);
  });

  it('bounds history page size', () => {
    expect(clampHistoryLimit(0)).toBe(100);
    expect(clampHistoryLimit(42)).toBe(42);
    expect(clampHistoryLimit(999)).toBe(100);
  });

  it('keeps transport priority compatible with Rust core', () => {
    expect(DEFAULT_TRANSPORT_PRIORITY).toEqual(['central_ws', 'mesh_relay', 'direct_p2p', 'fallback_wss', 'user_proxy']);
    expect(isSupportedTransportKind('mesh_relay')).toBe(true);
    expect(isSupportedTransportKind('bad')).toBe(false);
    expect(normalizeTransportPriority(['fallback_wss', 'bad', 'fallback_wss', 'central_ws'])).toEqual([
      'fallback_wss',
      'central_ws',
    ]);
    expect(normalizeTransportPriority(['bad'])).toEqual(DEFAULT_TRANSPORT_PRIORITY);
  });

  it('keeps metadata padding buckets compatible with Rust core', () => {
    expect(metadataPaddingTargetLen('disabled', 7)).toBe(7);
    expect(metadataPaddingTargetLen('interactive', 7)).toBe(256);
    expect(metadataPaddingTargetLen('interactive', 257)).toBe(1024);
    expect(metadataPaddingTargetLen('balanced', 2049)).toBe(16 * 1024);
    expect(metadataPaddingTargetLen('high_privacy', 70 * 1024)).toBe(256 * 1024);
  });

  it('keeps metadata batch delay stable and bounded', () => {
    const first = metadataBatchDelayMs(DEFAULT_METADATA_BATCH_POLICY, 'thread-a', 'msg-a');
    expect(metadataBatchDelayMs(DEFAULT_METADATA_BATCH_POLICY, 'thread-a', 'msg-a')).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(250);
    expect(metadataBatchDelayMs({ minBatchDelayMs: 40, maxBatchDelayMs: 20 }, 'thread-a', 'msg-a')).toBe(40);
  });

  it('builds blind mesh envelopes without sender or recipient fields', () => {
    const envelope = createBlindMeshEnvelope('direct', 'Direct_ABCD-1234', 'msg-1', 'ciphertext', 10_000);

    expect(meshTopic('direct', 'Direct_ABCD-1234')).toBe('messk/v1/direct/direct_abcd-1234');
    expect(meshTopic('group', 'bad/thread')).toBeNull();
    expect(envelope).toMatchObject({
      topic: 'messk/v1/direct/direct_abcd-1234',
      msgId: 'msg-1',
      hopLimit: 3,
    });
    expect(JSON.stringify(envelope)).not.toContain('sender');
    expect(JSON.stringify(envelope)).not.toContain('recipient');
    expect(envelope && validateBlindMeshEnvelope(envelope, 1_000)).toBe(true);
    expect(envelope && nextMeshHop(envelope)?.hopLimit).toBe(2);
    expect(meshDedupeKey('topic', 'msg')).toBe('topic:msg');
  });

  it('rejects invalid mesh topics and expired envelopes', () => {
    const envelope = createBlindMeshEnvelope('channel', 'chan_a', 'msg-1', 'ciphertext', 10_000);

    expect(isValidMeshTopic('messk/v1/channel/chan_a')).toBe(true);
    expect(isValidMeshTopic('messk/v1/channel/bad/thread')).toBe(false);
    expect(envelope && validateBlindMeshEnvelope({ ...envelope, hopLimit: 99 }, 1_000)).toBe(false);
    expect(envelope && validateBlindMeshEnvelope(envelope, 10_001)).toBe(false);
    expect(createBlindMeshEnvelope('direct', 'thread', 'bad msg', 'ciphertext', 10_000)).toBeNull();
  });

  it('unwraps and summarizes stable message payloads', () => {
    expect(displayMessageText('{"type":"text","text":"ky"}')).toBe('ky');
    expect(displayMessageText('hello')).toBe('hello');
    expect(displayMessageText('{"type":"voice","url":"https://messk.online/download/a.webm","duration":62}')).toBe(
      'Voice message - 01:02 - download ready'
    );
    expect(displayMessageText('{"type":"file","name":"photo.png","mimeType":"image/png","size":2048}')).toBe(
      'photo.png - image/png - 2.0 KB'
    );
    expect(displayMessageText('{"type":"ice_candidate"}')).toBe('Voice call - Connecting');
    expect(isDeletedMessagePayload('{"type":"deleted"}')).toBe(true);
  });

  it('exposes payload kind for UI rendering', () => {
    expect(messagePayloadPreview('{"type":"voice"}')?.kind).toBe('voice');
    expect(messagePayloadPreview('{"type":"video_call","status":"missed"}')).toMatchObject({
      kind: 'call',
      title: 'Video call',
      detail: 'Missed',
    });
  });
});
