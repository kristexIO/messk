import { describe, expect, it } from 'vitest';
import { shouldHandleServerAck } from './socketOutbox';

describe('shouldHandleServerAck', () => {
  it('accepts direct and community ack types', () => {
    expect(shouldHandleServerAck('message')).toBe(true);
    expect(shouldHandleServerAck('group_message')).toBe(true);
    expect(shouldHandleServerAck('channel_message')).toBe(true);
    expect(shouldHandleServerAck('channel_pin')).toBe(true);
  });

  it('ignores self-sync acknowledgements', () => {
    expect(shouldHandleServerAck('self_sync')).toBe(false);
  });

  it('treats missing ack types as legacy acks', () => {
    expect(shouldHandleServerAck(undefined)).toBe(true);
    expect(shouldHandleServerAck(null)).toBe(true);
  });
});
