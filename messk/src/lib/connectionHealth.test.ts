import { describe, expect, it } from 'vitest';
import { buildConnectionHealthItems } from './connectionHealth';

describe('connection health indicators', () => {
  it('announces offline state without peer identifiers', () => {
    const items = buildConnectionHealthItems({
      connectionStatus: 'offline',
      threadKind: 'direct',
    });
    const rendered = JSON.stringify(items);

    expect(items[0]?.title).toBe('Offline');
    expect(items[0]?.live).toBe('assertive');
    expect(rendered).toMatch(/retry automatically/i);
    expect(rendered).not.toMatch(/pubkey|recipient|peer/i);
  });

  it('summarizes direct retry queue by count and attempts only', () => {
    const items = buildConnectionHealthItems({
      connectionStatus: 'connected',
      threadKind: 'direct',
      queuedDirectCount: 2,
      queuedDirectAttempts: 7,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'direct-retry-queue',
      title: '2 messages waiting for delivery',
      detail: 'Stored locally in the retry queue. Attempts: 7.',
    });
  });

  it('hides raw sync errors from group and channel metadata banners', () => {
    const secretError = 'failed for seed phrase and pubKey abc123 plus bearer token';
    const groupItems = buildConnectionHealthItems({
      connectionStatus: 'reconnecting',
      threadKind: 'group',
      collectionSyncStatus: { state: 'error', error: secretError },
    });
    const channelItems = buildConnectionHealthItems({
      connectionStatus: 'connected',
      threadKind: 'channel',
      queuedRoomEventCount: 1,
      collectionSyncStatus: { state: 'error', error: secretError },
    });
    const rendered = JSON.stringify([...groupItems, ...channelItems]);

    expect(rendered).toContain('Group metadata needs refresh');
    expect(rendered).toContain('Channel metadata needs refresh');
    expect(rendered).toContain('1 channel event queued for reconnect');
    expect(rendered).not.toContain('seed phrase');
    expect(rendered).not.toContain('abc123');
    expect(rendered).not.toContain('bearer token');
  });
});
