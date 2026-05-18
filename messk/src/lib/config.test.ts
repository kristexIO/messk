import { describe, expect, it } from 'vitest';
import {
  normalizeBackendOrigin,
  normalizeBackendOriginList,
  parseBackendOriginList,
} from './config';

describe('config', () => {
  it('normalizes backend origins without paths or credentials', () => {
    expect(normalizeBackendOrigin('https://Relay.Example/')).toBe('https://relay.example');
    expect(normalizeBackendOrigin('https://relay.example/path')).toBeUndefined();
    expect(normalizeBackendOrigin('https://user:pass@relay.example')).toBeUndefined();
    expect(normalizeBackendOrigin('wss://relay.example')).toBeUndefined();
  });

  it('dedupes fallback backend origins', () => {
    expect(parseBackendOriginList('https://a.example, https://a.example/, http://b.example')).toEqual([
      'https://a.example',
      'http://b.example',
    ]);
    expect(normalizeBackendOriginList('https://primary.example', ['https://primary.example/', 'https://relay.example'])).toEqual([
      'https://primary.example',
      'https://relay.example',
    ]);
  });
});
