import Dexie from 'dexie';
import { db, getDatabaseNameForIdentity, resetActiveDatabase, setVaultKey } from './db';
import { DEFAULT_DB_NAME, ONBOARDING_STORAGE_KEY, REMEMBERED_IDENTITY_STORAGE_KEY, SETTINGS_STORAGE_KEY } from './storage';

export type PanicResetResult = {
  localStorageKeys: string[];
  databaseNames: string[];
};

const APP_LOCAL_STORAGE_PREFIXES = ['messenger_', 'messk_'];

function readProfilePublicKeys(): string[] {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const settings = JSON.parse(raw) as { profiles?: unknown };
    if (!settings.profiles || typeof settings.profiles !== 'object') {
      return [];
    }
    return Object.keys(settings.profiles);
  } catch {
    return [];
  }
}

function isMesskDatabaseName(name: string | undefined): name is string {
  return Boolean(name && (name === DEFAULT_DB_NAME || name.startsWith(`${DEFAULT_DB_NAME}-`)));
}

async function listBrowserMesskDatabases(): Promise<string[]> {
  if (typeof indexedDB.databases !== 'function') {
    return [];
  }

  try {
    const databases = await indexedDB.databases();
    return databases.map((database) => database.name).filter(isMesskDatabaseName);
  } catch {
    return [];
  }
}

export async function getPanicResetDatabaseNames(currentPublicKey: string | null): Promise<string[]> {
  const knownNames = [
    getDatabaseNameForIdentity(null),
    getDatabaseNameForIdentity(currentPublicKey),
    ...readProfilePublicKeys().map((publicKey) => getDatabaseNameForIdentity(publicKey)),
    ...await listBrowserMesskDatabases(),
  ];

  return Array.from(new Set(knownNames.filter(isMesskDatabaseName)));
}

export function getPanicResetLocalStorageKeys(storage: Storage = localStorage): string[] {
  const keys = [
    SETTINGS_STORAGE_KEY,
    REMEMBERED_IDENTITY_STORAGE_KEY,
    ONBOARDING_STORAGE_KEY,
  ];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && APP_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keys.push(key);
    }
  }

  return Array.from(new Set(keys));
}

export async function panicResetLocalState(currentPublicKey: string | null): Promise<PanicResetResult> {
  const localStorageKeys = getPanicResetLocalStorageKeys();
  const databaseNames = await getPanicResetDatabaseNames(currentPublicKey);

  for (const key of localStorageKeys) {
    localStorage.removeItem(key);
  }

  setVaultKey(null);
  db.close();
  await Promise.all(databaseNames.map((databaseName) => Dexie.delete(databaseName).catch(() => undefined)));
  resetActiveDatabase(null);

  return {
    localStorageKeys,
    databaseNames,
  };
}
