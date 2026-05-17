import { describe, expect, it } from 'vitest';
import {
  SERVER_ACK_TYPES,
  clampHistoryLimit,
  displayMessageText,
  isDirectHistoryEvent,
  isDeletedMessagePayload,
  messagePayloadPreview,
  requiresEncryptedData,
  requiresTargetMessageId,
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
    expect(requiresEncryptedData('edit')).toBe(true);
    expect(requiresEncryptedData('delete')).toBe(false);
  });

  it('bounds history page size', () => {
    expect(clampHistoryLimit(0)).toBe(100);
    expect(clampHistoryLimit(42)).toBe(42);
    expect(clampHistoryLimit(999)).toBe(100);
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
