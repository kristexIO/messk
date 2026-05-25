import { describe, expect, it } from 'vitest';
import { relayEndpointOrigins, toWebSocketUrl } from './transportDiscovery';

describe('transportDiscovery', () => {
  it('keeps bootstrap websocket relay origins only', () => {
    expect(
      relayEndpointOrigins([
        {
          endpointOrigins: ['https://mesh.example'],
          transports: ['mesh_relay'],
        },
        {
          endpointOrigins: [
            'https://relay.example/',
            'https://relay.example',
            'ftp://bad.example',
            'https://bad.example/path',
            'https://user:pass@bad.example',
            'http://downgrade.example',
            'HTTP://127.0.0.1:8080/',
          ],
          transports: ['fallback_wss'],
        },
      ])
    ).toEqual(['https://relay.example', 'http://127.0.0.1:8080']);
  });

  it('maps http origins to websocket urls', () => {
    expect(toWebSocketUrl('https://relay.example')).toBe('wss://relay.example/ws');
    expect(toWebSocketUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/ws');
  });
});
