export type ConnectionHealthStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting';
export type ConnectionHealthThreadKind = 'direct' | 'group' | 'channel';
export type ConnectionHealthTone = 'ok' | 'warn' | 'danger';
export type ConnectionHealthIcon = 'clock' | 'sync' | 'wifi-off';

export type ConnectionHealthSyncStatus = {
  state: 'idle' | 'syncing' | 'synced' | 'error';
  error?: string | null;
};

export type ConnectionHealthItem = {
  id: string;
  title: string;
  detail: string;
  tone: ConnectionHealthTone;
  icon: ConnectionHealthIcon;
  live: 'polite' | 'assertive';
};

export type ConnectionHealthInput = {
  connectionStatus: ConnectionHealthStatus;
  threadKind: ConnectionHealthThreadKind;
  queuedDirectCount?: number;
  queuedDirectAttempts?: number;
  queuedRoomEventCount?: number;
  collectionSyncStatus?: ConnectionHealthSyncStatus | null;
};

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function roomLabel(threadKind: ConnectionHealthThreadKind) {
  return threadKind === 'channel' ? 'channel' : 'group';
}

function safeCount(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function buildConnectionHealthItems(input: ConnectionHealthInput): ConnectionHealthItem[] {
  const items: ConnectionHealthItem[] = [];
  const queuedDirectCount = safeCount(input.queuedDirectCount);
  const queuedDirectAttempts = safeCount(input.queuedDirectAttempts);
  const queuedRoomEventCount = safeCount(input.queuedRoomEventCount);
  const room = roomLabel(input.threadKind);

  if (input.connectionStatus !== 'connected') {
    if (input.connectionStatus === 'offline') {
      items.push({
        id: 'connection-offline',
        title: 'Offline',
        detail: 'Messages stay on this device and retry automatically when the secure channel returns.',
        tone: 'danger',
        icon: 'wifi-off',
        live: 'assertive',
      });
    } else if (input.connectionStatus === 'reconnecting') {
      items.push({
        id: 'connection-reconnecting',
        title: 'Reconnecting secure channel',
        detail: 'Delivery may be delayed. Queued sends stay encrypted locally until reconnect succeeds.',
        tone: 'warn',
        icon: 'wifi-off',
        live: 'polite',
      });
    } else {
      items.push({
        id: 'connection-connecting',
        title: 'Connecting secure channel',
        detail: 'The thread is readable while Messk establishes a realtime transport.',
        tone: 'warn',
        icon: 'sync',
        live: 'polite',
      });
    }
  }

  if (queuedDirectCount > 0) {
    items.push({
      id: 'direct-retry-queue',
      title: `${pluralize(queuedDirectCount, 'message')} waiting for delivery`,
      detail: `Stored locally in the retry queue. Attempts: ${queuedDirectAttempts}.`,
      tone: 'warn',
      icon: input.connectionStatus === 'connected' ? 'clock' : 'wifi-off',
      live: 'polite',
    });
  }

  if (queuedRoomEventCount > 0 && input.threadKind !== 'direct') {
    items.push({
      id: `${room}-retry-queue`,
      title: `${pluralize(queuedRoomEventCount, `${room} event`)} queued for reconnect`,
      detail: input.connectionStatus === 'connected'
        ? 'Encrypted room changes are waiting for secure resend and should flush shortly.'
        : 'Connection is unstable. Encrypted room changes will send automatically after reconnect.',
      tone: 'warn',
      icon: input.connectionStatus === 'connected' ? 'clock' : 'wifi-off',
      live: 'polite',
    });
  }

  if (input.collectionSyncStatus && input.threadKind !== 'direct' && input.collectionSyncStatus.state !== 'synced') {
    if (input.collectionSyncStatus.state === 'syncing' || input.collectionSyncStatus.state === 'idle') {
      items.push({
        id: `${room}-metadata-sync`,
        title: `Syncing ${room} metadata`,
        detail: 'You can keep reading the current thread while membership and permission state catches up.',
        tone: 'warn',
        icon: 'sync',
        live: 'polite',
      });
    } else if (input.collectionSyncStatus.state === 'error') {
      items.push({
        id: `${room}-metadata-sync-error`,
        title: `${room[0].toUpperCase()}${room.slice(1)} metadata needs refresh`,
        detail: 'Retry after reconnect. Raw server errors are hidden here so diagnostics do not expose identifiers.',
        tone: 'danger',
        icon: 'wifi-off',
        live: 'assertive',
      });
    }
  }

  return items;
}

export function getConnectionHealthToneClass(tone: ConnectionHealthTone) {
  if (tone === 'danger') {
    return 'border-red-400/20 bg-red-400/10 text-red-100';
  }
  if (tone === 'ok') {
    return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
  }
  return 'border-amber-300/20 bg-amber-300/10 text-amber-100';
}
