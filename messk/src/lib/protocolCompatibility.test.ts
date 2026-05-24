import { describe, expect, it } from 'vitest';
import { assessProtocolCompatibility, protocolEndpointForWebSocketUrl } from './protocolCompatibility';

describe('protocolCompatibility', () => {
  it('maps websocket endpoints to the public protocol descriptor', () => {
    expect(protocolEndpointForWebSocketUrl('wss://messk.online/ws?pub=a')).toBe('https://messk.online/protocol');
    expect(protocolEndpointForWebSocketUrl('ws://127.0.0.1:8080/ws')).toBe('http://127.0.0.1:8080/protocol');
  });

  it('accepts only the supported state on the current wire protocol', () => {
    expect(assessProtocolCompatibility({
      protocolVersion: 1,
      requiredClientStateVersion: 'clean_20260511',
      supportedClientStateVersions: ['clean_20260511'],
    }, 'clean_20260511').compatible).toBe(true);
    expect(assessProtocolCompatibility({
      protocolVersion: 1,
      supportedClientStateVersions: ['clean_future'],
    }, 'clean_20260511').message).toContain('no longer supported');
    expect(assessProtocolCompatibility({
      protocolVersion: 2,
      supportedClientStateVersions: ['clean_20260511'],
    }, 'clean_20260511').message).toContain('incompatible protocol');
  });
});
