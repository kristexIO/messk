import { afterEach, describe, expect, it } from 'vitest';
import { MessengerDatabase, getDatabaseNameForIdentity, migrateLocalDataToEncryptedAtRest, persistIdentityKeyPair, prepareDatabaseForIdentity, setVaultKey, switchActiveDatabase } from './db';

describe('MessengerDatabase', () => {
  const dbNames: string[] = [];
  const databases: MessengerDatabase[] = [];

  async function destroyDatabase(name: string) {
    const db = new MessengerDatabase(name);
    db.close();
    await db.delete();
  }

  afterEach(async () => {
    setVaultKey(null);
    databases.splice(0).forEach((db) => db.close());
    await Promise.all(dbNames.splice(0).map((name) => destroyDatabase(name)));
  });

  it('encrypts sensitive session fields at rest and decrypts them on read', async () => {
    const name = `MessengerDB-test-${crypto.randomUUID()}`;
    dbNames.push(name);
    const db = new MessengerDatabase(name);
    databases.push(db);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();

    await db.sessions.put({
      peerPublicKey: 'peer-key',
      rootKey: 'root-secret',
      sendChainKey: 'send-secret',
      recvChainKey: null,
      sendRatchetPubKey: 'public-ratchet',
      sendRatchetPrivKey: 'private-ratchet',
      recvRatchetPubKey: 'peer-ratchet',
      sendChainIndex: 0,
      recvChainIndex: 0,
      previousSendChainLength: 0,
      skippedKeys: { 1: 'skipped-secret' }
    });

    const raw = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const nativeDb = request.result;
        const tx = nativeDb.transaction('sessions', 'readonly');
        const getReq = tx.objectStore('sessions').get('peer-key');
        getReq.onerror = () => reject(getReq.error);
        getReq.onsuccess = () => {
          resolve(getReq.result as Record<string, unknown> | undefined);
          nativeDb.close();
        };
      };
    });

    expect(raw?.rootKey).toMatch(/^enc:v1:/);
    expect(raw?.sendRatchetPrivKey).toMatch(/^enc:v1:/);

    const stored = await db.sessions.get('peer-key');
    expect(stored?.rootKey).toBe('root-secret');
    expect(stored?.sendRatchetPrivKey).toBe('private-ratchet');
    expect(stored?.skippedKeys).toEqual({ 1: 'skipped-secret' });
  });

  it('rejects sensitive session writes while the vault is locked', async () => {
    const name = `MessengerDB-locked-${crypto.randomUUID()}`;
    dbNames.push(name);
    const db = new MessengerDatabase(name);
    databases.push(db);
    setVaultKey(null);
    await db.open();

    await expect(db.sessions.put({
      peerPublicKey: 'peer-key',
      rootKey: 'root-secret',
      sendChainKey: 'send-secret',
      recvChainKey: null,
      sendRatchetPubKey: 'public-ratchet',
      sendRatchetPrivKey: 'private-ratchet',
      recvRatchetPubKey: 'peer-ratchet',
      sendChainIndex: 0,
      recvChainIndex: 0,
      previousSendChainLength: 0,
      skippedKeys: {}
    })).rejects.toThrow(/keys are unlocked/);
  });

  it('encrypts local message text and reactions at rest', async () => {
    const name = `MessengerDB-message-${crypto.randomUUID()}`;
    dbNames.push(name);
    const db = new MessengerDatabase(name);
    databases.push(db);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();

    await db.messages.add({
      msgId: 'msg-1',
      peerPublicKey: 'peer-key',
      senderPublicKey: 'peer-key',
      text: 'secret local text',
      timestamp: 123,
      status: 'read',
      reactions: { alice: '👍' }
    });

    const raw = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const nativeDb = request.result;
        const tx = nativeDb.transaction('messages', 'readonly');
        const index = tx.objectStore('messages').index('msgId');
        const getReq = index.get('msg-1');
        getReq.onerror = () => reject(getReq.error);
        getReq.onsuccess = () => {
          resolve(getReq.result as Record<string, unknown> | undefined);
          nativeDb.close();
        };
      };
    });

    expect(raw?.text).toMatch(/^enc:v1:/);
    expect(raw?.reactions).toMatch(/^enc:v1:/);

    const stored = await db.messages.where('msgId').equals('msg-1').first();
    expect(stored?.text).toBe('secret local text');
    expect(stored?.reactions).toEqual({ alice: '👍' });
  });

  it('encrypts draft contact text at rest', async () => {
    const name = `MessengerDB-contact-${crypto.randomUUID()}`;
    dbNames.push(name);
    const db = new MessengerDatabase(name);
    databases.push(db);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();

    await db.contacts.put({
      pubKey: 'peer-key',
      name: 'Peer',
      draft: 'half-written secret'
    });

    const raw = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const nativeDb = request.result;
        const tx = nativeDb.transaction('contacts', 'readonly');
        const getReq = tx.objectStore('contacts').get('peer-key');
        getReq.onerror = () => reject(getReq.error);
        getReq.onsuccess = () => {
          resolve(getReq.result as Record<string, unknown> | undefined);
          nativeDb.close();
        };
      };
    });

    expect(raw?.draft).toMatch(/^enc:v1:/);
    await expect(db.contacts.get('peer-key')).resolves.toEqual(
      expect.objectContaining({ draft: 'half-written secret' })
    );
  });

  it('rejects sensitive message updates while the vault is locked', async () => {
    const name = `MessengerDB-message-locked-${crypto.randomUUID()}`;
    dbNames.push(name);
    const db = new MessengerDatabase(name);
    databases.push(db);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();

    const id = await db.messages.add({
      msgId: 'msg-1',
      peerPublicKey: 'peer-key',
      senderPublicKey: 'peer-key',
      text: 'secret local text',
      timestamp: 123,
      status: 'read'
    });

    setVaultKey(null);
    await expect(db.messages.update(id, { text: 'plaintext leak' })).rejects.toThrow(/keys are unlocked/);
  });

  it('migrates readable local data into encrypted-at-rest records', async () => {
    const name = `MessengerDB-migrate-encryption-${crypto.randomUUID()}`;
    dbNames.push(name);
    const db = new MessengerDatabase(name);
    databases.push(db);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();

    await db.messages.add({
      msgId: 'msg-1',
      peerPublicKey: 'peer-key',
      senderPublicKey: 'peer-key',
      text: 'already readable',
      timestamp: 123,
      status: 'read'
    });

    await migrateLocalDataToEncryptedAtRest(db);

    const raw = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const nativeDb = request.result;
        const tx = nativeDb.transaction('messages', 'readonly');
        const index = tx.objectStore('messages').index('msgId');
        const getReq = index.get('msg-1');
        getReq.onerror = () => reject(getReq.error);
        getReq.onsuccess = () => {
          resolve(getReq.result as Record<string, unknown> | undefined);
          nativeDb.close();
        };
      };
    });

    expect(raw?.text).toMatch(/^enc:v1:/);
  });

  it('upgrades an older schema to include secure tables', async () => {
    const name = `MessengerDB-migrate-${crypto.randomUUID()}`;
    dbNames.push(name);

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const nativeDb = request.result;
        nativeDb.createObjectStore('keypairs', { keyPath: 'id', autoIncrement: true }).createIndex('publicKey', 'publicKey', { unique: true });
        const messages = nativeDb.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        messages.createIndex('msgId', 'msgId', { unique: false });
        messages.createIndex('peerPublicKey', 'peerPublicKey', { unique: false });
        messages.createIndex('timestamp', 'timestamp', { unique: false });
        const contacts = nativeDb.createObjectStore('contacts', { keyPath: 'pubKey' });
        contacts.createIndex('lastMessageAt', 'lastMessageAt', { unique: false });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });

    const db = new MessengerDatabase(name);
    databases.push(db);
    await db.open();

    expect(db.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['keypairs', 'messages', 'contacts', 'sessions', 'prekeys'])
    );

    await expect(db.sessions.count()).resolves.toBe(0);
    await expect(db.prekeys.count()).resolves.toBe(0);
  });

  it('uses a separate database per identity', async () => {
    const firstIdentity = `pubkey-one-${crypto.randomUUID()}`;
    const secondIdentity = `pubkey-two-${crypto.randomUUID()}`;
    const firstName = getDatabaseNameForIdentity(firstIdentity);
    const secondName = getDatabaseNameForIdentity(secondIdentity);
    dbNames.push(firstName, secondName);

    const db = new MessengerDatabase(firstName);
    databases.push(db);
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.open();

    await persistIdentityKeyPair(firstIdentity, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', db);
    await db.messages.add({
      msgId: 'msg-1',
      peerPublicKey: 'peer-key',
      senderPublicKey: 'peer-key',
      text: 'secret local text',
      timestamp: 123,
      status: 'read'
    });
    db.close();

    await prepareDatabaseForIdentity(secondIdentity);
    switchActiveDatabase(null);

    const reopenedFirst = new MessengerDatabase(firstName);
    const reopenedSecond = new MessengerDatabase(secondName);
    databases.push(reopenedFirst, reopenedSecond);
    await reopenedFirst.open();
    await reopenedSecond.open();

    await expect(reopenedFirst.keypairs.count()).resolves.toBe(1);
    await expect(reopenedFirst.messages.count()).resolves.toBe(1);
    await expect(reopenedSecond.keypairs.count()).resolves.toBe(0);
    await expect(reopenedSecond.messages.count()).resolves.toBe(0);
  });
});
