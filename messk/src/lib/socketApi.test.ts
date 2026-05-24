import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, setVaultKey, switchActiveDatabase } from './db';
import { SocketApiClient } from './socketApi';

describe('SocketApiClient', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    setVaultKey(null);
    db.close();
    await db.delete();
    switchActiveDatabase(null);
  });

  it('preserves verified identity state when refreshing public profile metadata', async () => {
    switchActiveDatabase(`socket-api-${crypto.randomUUID()}`);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();
    await db.contacts.put({
      pubKey: 'peer-key',
      name: 'Original',
      verifiedIdentityFingerprint: 'ABCD EFGH',
      verifiedIdentityAt: 123,
      pinnedMsgId: 'message-1',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ nickname: 'Updated' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )));

    const api = new SocketApiClient(() => 'session-token');
    await api.refreshContactProfile('peer-key', true);

    await expect(db.contacts.get('peer-key')).resolves.toMatchObject({
      name: 'Updated',
      verifiedIdentityFingerprint: 'ABCD EFGH',
      verifiedIdentityAt: 123,
      pinnedMsgId: 'message-1',
    });
  });
});
