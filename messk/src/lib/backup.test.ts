import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, createEncryptedBackup, parseBackupFile, restoreBackup } from './backup';
import { db, setVaultKey } from './db';

describe('backup utilities', () => {
  beforeEach(async () => {
    setVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await db.contacts.clear();
    await db.messages.clear();
  });

  afterEach(async () => {
    await db.contacts.clear();
    await db.messages.clear();
    setVaultKey(null);
  });

  it('creates and restores a backup payload', async () => {
    await db.contacts.put({
      pubKey: 'peer-1',
      name: 'Alice',
      pinned: true,
      draft: 'draft text',
      lastMessageAt: 123
    });
    await db.messages.add({
      msgId: 'msg-1',
      peerPublicKey: 'peer-1',
      senderPublicKey: 'peer-1',
      text: 'hello there',
      timestamp: 123,
      status: 'read',
      reactions: { 'peer-1': '👍' }
    });

    const backup = await createBackup({
      nickname: 'Tester',
      avatar: null,
      theme: 'forest'
    });

    expect(backup.version).toBe(1);
    expect(backup.profile.nickname).toBe('Tester');
    expect(backup.contacts).toHaveLength(1);
    expect(backup.messages).toHaveLength(1);

    await db.contacts.clear();
    await db.messages.clear();
    await restoreBackup(backup);

    await expect(db.contacts.toArray()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pubKey: 'peer-1', pinned: true, draft: 'draft text' })
      ])
    );
    await expect(db.messages.toArray()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msgId: 'msg-1', reactions: { 'peer-1': '👍' } })
      ])
    );
  });

  it('rejects unsupported backup payloads', async () => {
    const file = {
      text: async () => JSON.stringify({ version: 99, contacts: [], messages: [], profile: null })
    } as File;

    await expect(parseBackupFile(file)).rejects.toThrow('Unsupported backup format');
  });

  it('rejects oversized backup files', async () => {
    const file = {
      size: 11 * 1024 * 1024,
      text: async () => ''
    } as File;

    await expect(parseBackupFile(file)).rejects.toThrow('Backup file is too large');
  });

  it('normalizes parsed backup payloads before restore', async () => {
    const file = {
      size: 100,
      text: async () => JSON.stringify({
        version: 1,
        exportedAt: '2026-04-24T12:00:00Z',
        profile: { nickname: 'Tester', avatar: 123, theme: 'forest' },
        contacts: [{ pubKey: 'peer-1', name: 'Alice', pinned: true, draft: 'draft', extra: 'ignored' }],
        messages: [{
          msgId: 'msg-1',
          peerPublicKey: 'peer-1',
          senderPublicKey: 'peer-1',
          text: 'hello',
          timestamp: 123,
          status: 'read',
          reactions: { 'peer-1': 'ok' },
          unsafe: 'ignored'
        }]
      })
    } as File;

    const parsed = await parseBackupFile(file);

    expect(parsed.profile).toEqual({ nickname: 'Tester', avatar: null, theme: 'forest' });
    expect(parsed.contacts[0]).toEqual(expect.not.objectContaining({ extra: 'ignored' }));
    expect(parsed.messages[0]).toEqual(expect.not.objectContaining({ unsafe: 'ignored' }));
  });

  it('creates and parses encrypted backup payloads', async () => {
    await db.contacts.put({
      pubKey: 'peer-1',
      name: 'Alice',
      draft: 'secret draft'
    });
    await db.messages.add({
      msgId: 'msg-1',
      peerPublicKey: 'peer-1',
      senderPublicKey: 'peer-1',
      text: 'encrypted backup text',
      timestamp: 123,
      status: 'read'
    });

    const encrypted = await createEncryptedBackup({
      nickname: 'Tester',
      avatar: null,
      theme: 'dark'
    }, 'very safe password');

    expect(encrypted.version).toBe(2);
    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.manifest).toEqual({
      schema: 'messk.encrypted-backup.v2',
      content: {
        profile: true,
        contacts: 1,
        messages: 1,
      },
      excludes: ['identity_seed', 'identity_secret_key', 'ratchet_sessions', 'prekeys', 'group_sender_keys'],
    });
    expect(JSON.stringify(encrypted)).not.toContain('encrypted backup text');
    expect(JSON.stringify(encrypted)).not.toMatch(/secretKey|rootKey|sendRatchetPrivKey/i);

    const file = {
      size: 1000,
      text: async () => JSON.stringify(encrypted)
    } as File;

    await expect(parseBackupFile(file)).rejects.toThrow('Backup password is required');
    await expect(parseBackupFile(file, 'wrong password')).rejects.toThrow('Invalid backup password');

    const parsed = await parseBackupFile(file, 'very safe password');
    expect(parsed.messages[0]).toEqual(expect.objectContaining({ text: 'encrypted backup text' }));
    expect(parsed.contacts[0]).toEqual(expect.objectContaining({ draft: 'secret draft' }));
  });
});
