import { describe, expect, it } from 'vitest';
import {
  normalizeBackendOrigin,
  normalizeBackendOriginList,
  parseBackendOriginList,
} from './config';

describe('config', () => {
  it('normalizes backend origins without paths or credentials', () => {
    expect(normalizeBackendOrigin('https://Relay.Example/')).toBe('https://relay.example');
    expect(normalizeBackendOrigin('http://relay.example')).toBeUndefined();
    expect(normalizeBackendOrigin('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(normalizeBackendOrigin('HTTP://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(normalizeBackendOrigin('http://[::1]:8080/')).toBe('http://[::1]:8080');
    expect(normalizeBackendOrigin('https://relay.example/path')).toBeUndefined();
    expect(normalizeBackendOrigin('https://user:pass@relay.example')).toBeUndefined();
    expect(normalizeBackendOrigin('wss://relay.example')).toBeUndefined();
  });

  it('dedupes fallbacks and drops insecure remote origins', () => {
    expect(parseBackendOriginList('https://a.example, https://a.example/, http://b.example, http://localhost:8080')).toEqual([
      'https://a.example',
      'http://localhost:8080',
    ]);
    expect(normalizeBackendOriginList('https://primary.example', ['https://primary.example/', 'https://relay.example'])).toEqual([
      'https://primary.example',
      'https://relay.example',
    ]);
  });
});
