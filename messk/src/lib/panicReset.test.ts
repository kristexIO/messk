import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { MessengerDatabase, getDatabaseNameForIdentity, setVaultKey } from './db';
import { panicResetLocalState } from './panicReset';
import { DEFAULT_DB_NAME, ONBOARDING_STORAGE_KEY, REMEMBERED_IDENTITY_STORAGE_KEY, SETTINGS_STORAGE_KEY } from './storage';

async function openDatabase(name: string) {
  const database = new MessengerDatabase(name);
  setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  await database.open();
  await database.keypairs.put({
    publicKey: `public-${name}`,
    secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  });
  database.close();
}

async function databaseNames() {
  const databases = await indexedDB.databases();
  return databases.map((database) => database.name).filter(Boolean);
}

describe('panic reset', () => {
  afterEach(async () => {
    setVaultKey(null);
    localStorage.clear();
    await Promise.all((await databaseNames()).map((name) => Dexie.delete(name as string).catch(() => undefined)));
  });

  it('removes Messk local storage and all Messk IndexedDB databases only', async () => {
    const currentPublicKey = 'current/account+/=';
    const rememberedPublicKey = 'remembered/account';
    const currentDbName = getDatabaseNameForIdentity(currentPublicKey);
    const rememberedDbName = getDatabaseNameForIdentity(rememberedPublicKey);
    const unrelatedDbName = `Unrelated-${crypto.randomUUID()}`;

    await openDatabase(DEFAULT_DB_NAME);
    await openDatabase(currentDbName);
    await openDatabase(rememberedDbName);
    const unrelated = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(unrelatedDbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('items');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    unrelated.close();

    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      pinHash: 'pbkdf2:v1:test',
      profiles: {
        [rememberedPublicKey]: { nickname: 'Remembered' },
      },
    }));
    localStorage.setItem(REMEMBERED_IDENTITY_STORAGE_KEY, 'pinbox:v1:test');
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    localStorage.setItem('messenger_future_secret', 'remove-me');
    localStorage.setItem('unrelated_setting', 'keep-me');

    const result = await panicResetLocalState(currentPublicKey);
    const remainingDatabases = await databaseNames();

    expect(result.localStorageKeys).toEqual(expect.arrayContaining([
      SETTINGS_STORAGE_KEY,
      REMEMBERED_IDENTITY_STORAGE_KEY,
      ONBOARDING_STORAGE_KEY,
      'messenger_future_secret',
    ]));
    expect(result.databaseNames).toEqual(expect.arrayContaining([
      DEFAULT_DB_NAME,
      currentDbName,
      rememberedDbName,
    ]));
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(REMEMBERED_IDENTITY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('messenger_future_secret')).toBeNull();
    expect(localStorage.getItem('unrelated_setting')).toBe('keep-me');
    expect(remainingDatabases).not.toContain(DEFAULT_DB_NAME);
    expect(remainingDatabases).not.toContain(currentDbName);
    expect(remainingDatabases).not.toContain(rememberedDbName);
    expect(remainingDatabases).toContain(unrelatedDbName);
  });
});
