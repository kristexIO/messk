import { db, type ChannelThread, type GroupThread } from './db';
import { appConfig } from './config';
import { socketManager } from './socket';
import { useAppStore } from '../store';
import { fetchWithTimeout } from './http';

type ServerGroup = {
  id: string;
  title: string;
  avatar?: string;
  role: string;
  createdAt: string;
};

type ServerGroupMember = {
  memberPubKey: string;
  role?: string;
};

type ServerChannel = {
  id: string;
  title: string;
  avatar?: string;
  ownerPubKey: string;
  role: string;
  createdAt: string;
};

type ServerChannelSubscriber = {
  subscriberPubKey: string;
  role?: string;
};

const GROUP_SYNC_TTL_MS = 30_000;
const CHANNEL_SYNC_TTL_MS = 30_000;

let lastGroupsSyncAt = 0;
let groupsSyncPromise: Promise<GroupThread[]> | null = null;
let lastChannelsSyncAt = 0;
let channelsSyncPromise: Promise<ChannelThread[]> | null = null;

function toFriendlyRequestError(status: number, fallback: string) {
  switch (status) {
    case 401:
      return 'Session expired. Please sign in again.';
    case 403:
      return 'You do not have access to this group.';
    case 404:
      return 'Group was not found on the server.';
    case 413:
      return 'The selected avatar is too large. Choose a smaller image or skip the cover.';
    default:
      return fallback;
  }
}

function toTimestamp(value: string | undefined): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...socketManager.getSessionHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(toFriendlyRequestError(response.status, `Request failed with status ${response.status}`));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function syncGroups(force = false): Promise<GroupThread[]> {
  if (!force && Date.now() - lastGroupsSyncAt < GROUP_SYNC_TTL_MS) {
    useAppStore.getState().setGroupSyncStatus({
      state: 'synced',
      lastSyncAt: lastGroupsSyncAt || Date.now(),
      error: null,
    });
    return db.groupThreads.orderBy('lastActivityAt').reverse().toArray();
  }

  if (groupsSyncPromise) {
    return groupsSyncPromise;
  }

  useAppStore.getState().setGroupSyncStatus({ state: 'syncing', error: null });
  groupsSyncPromise = (async () => {
  const payload = await fetchJson<{ groups: ServerGroup[] }>(`${appConfig.backendOrigin}/groups`, {
    method: 'GET',
  });

  const groups = await Promise.all(
    (payload.groups ?? []).map(async (group) => {
      const existing = await db.groupThreads.get(group.id);
      const record: GroupThread = {
        id: group.id,
        title: group.title,
        avatar: group.avatar?.trim() || null,
        role: group.role,
        members: existing?.members ?? [],
        memberCount: existing?.memberCount ?? 0,
        createdAt: toTimestamp(group.createdAt),
        lastActivityAt: existing?.lastActivityAt ?? toTimestamp(group.createdAt),
      };
      await db.groupThreads.put(record);
      return record;
    })
  );

  const groupIds = new Set(groups.map((group) => group.id));
  const staleGroups = await db.groupThreads.toArray();
  await Promise.all(
    staleGroups
      .filter((group) => !groupIds.has(group.id))
      .map((group) => db.groupThreads.delete(group.id))
  );
  const pendingInvites = await db.groupInvites.toArray();
  await Promise.all(
    pendingInvites
      .filter((invite) => groupIds.has(invite.groupId))
      .map((invite) => db.groupInvites.delete(invite.id))
  );

  lastGroupsSyncAt = Date.now();
  return groups;
  })();

  try {
    const groups = await groupsSyncPromise;
    useAppStore.getState().setGroupSyncStatus({
      state: 'synced',
      lastSyncAt: lastGroupsSyncAt || Date.now(),
      error: null,
    });
    return groups;
  } catch (error) {
    useAppStore.getState().setGroupSyncStatus({
      state: 'error',
      error: error instanceof Error ? error.message : 'Group sync failed',
    });
    throw error;
  } finally {
    groupsSyncPromise = null;
  }
}

export async function createGroup(input: {
  title: string;
  avatar?: string | null;
  members: string[];
}) {
  await fetchJson<{ id: string }>(`${appConfig.backendOrigin}/groups`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      avatar: input.avatar ?? '',
      members: input.members,
    }),
  });

  lastGroupsSyncAt = 0;
  return syncGroups(true);
}

export async function refreshGroupAvailability(groupId: string) {
  const groups = await syncGroups(true);
  return groups.find((group) => group.id === groupId) ?? null;
}

export async function addGroupMember(groupId: string, pubKey: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ pubKey }),
  });

  lastGroupsSyncAt = 0;
  return refreshGroupAvailability(groupId);
}

export async function listGroupMembers(groupId: string) {
  const payload = await fetchJson<{ members: ServerGroupMember[] }>(
    `${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}/members`,
    { method: 'GET' }
  );

  const members = (payload.members ?? [])
    .map((member) => ({
      memberPubKey: member?.memberPubKey,
      role: typeof member?.role === 'string' ? member.role : 'member',
    }))
    .filter((member): member is { memberPubKey: string; role: string } => typeof member.memberPubKey === 'string' && member.memberPubKey.length > 0);

  await db.groupThreads.update(groupId, {
    members: members.map((member) => member.memberPubKey),
    memberCount: members.length,
  });

  return members;
}

export async function updateGroupMemberRole(groupId: string, pubKey: string, role: 'admin' | 'member') {
  await fetchJson<void>(`${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'PATCH',
    body: JSON.stringify({ pubKey, role }),
  });

  lastGroupsSyncAt = 0;
  return refreshGroupAvailability(groupId);
}

export async function removeGroupMember(groupId: string, pubKey: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}/members?pubKey=${encodeURIComponent(pubKey)}`, {
    method: 'DELETE',
  });

  lastGroupsSyncAt = 0;
  return refreshGroupAvailability(groupId);
}

export async function leaveGroup(groupId: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  });

  lastGroupsSyncAt = 0;
  await db.groupThreads.delete(groupId);
}

export async function transferGroupOwnership(groupId: string, newOwnerPubKey: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ newOwnerPubKey }),
  });

  lastGroupsSyncAt = 0;
  return refreshGroupAvailability(groupId);
}

export async function deleteGroup(groupId: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  });

  lastGroupsSyncAt = 0;
  await db.groupThreads.delete(groupId);
}

export async function syncChannels(force = false): Promise<ChannelThread[]> {
  if (!force && Date.now() - lastChannelsSyncAt < CHANNEL_SYNC_TTL_MS) {
    useAppStore.getState().setChannelSyncStatus({
      state: 'synced',
      lastSyncAt: lastChannelsSyncAt || Date.now(),
      error: null,
    });
    return db.channelThreads.orderBy('lastActivityAt').reverse().toArray();
  }

  if (channelsSyncPromise) {
    return channelsSyncPromise;
  }

  useAppStore.getState().setChannelSyncStatus({ state: 'syncing', error: null });
  channelsSyncPromise = (async () => {
    const payload = await fetchJson<{ channels: ServerChannel[] }>(`${appConfig.backendOrigin}/channels`, {
      method: 'GET',
    });

    const channels = await Promise.all(
      (payload.channels ?? []).map(async (channel) => {
        const existing = await db.channelThreads.get(channel.id);
        const record: ChannelThread = {
          id: channel.id,
          title: channel.title,
          avatar: channel.avatar?.trim() || null,
          role: channel.role,
          ownerPubKey: channel.ownerPubKey,
          subscriberCount: existing?.subscriberCount ?? 0,
          createdAt: toTimestamp(channel.createdAt),
          lastActivityAt: existing?.lastActivityAt ?? toTimestamp(channel.createdAt),
        };
        await db.channelThreads.put(record);
        return record;
      })
    );

    const channelIds = new Set(channels.map((channel) => channel.id));
    const staleChannels = await db.channelThreads.toArray();
    await Promise.all(
      staleChannels
        .filter((channel) => !channelIds.has(channel.id))
        .map((channel) => db.channelThreads.delete(channel.id))
    );

    lastChannelsSyncAt = Date.now();
    return channels;
  })();

  try {
    const channels = await channelsSyncPromise;
    useAppStore.getState().setChannelSyncStatus({
      state: 'synced',
      lastSyncAt: lastChannelsSyncAt || Date.now(),
      error: null,
    });
    return channels;
  } catch (error) {
    useAppStore.getState().setChannelSyncStatus({
      state: 'error',
      error: error instanceof Error ? error.message : 'Channel sync failed',
    });
    throw error;
  } finally {
    channelsSyncPromise = null;
  }
}

export async function createChannel(input: { title: string; avatar?: string | null }) {
  await fetchJson<{ id: string }>(`${appConfig.backendOrigin}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      avatar: input.avatar ?? '',
    }),
  });

  lastChannelsSyncAt = 0;
  return syncChannels(true);
}

export async function refreshChannelAvailability(channelId: string) {
  const channels = await syncChannels(true);
  return channels.find((channel) => channel.id === channelId) ?? null;
}

export async function listChannelSubscribers(channelId: string) {
  const payload = await fetchJson<{ subscribers: ServerChannelSubscriber[] }>(
    `${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}/subscribers`,
    { method: 'GET' }
  );

  const subscribers = (payload.subscribers ?? [])
    .map((subscriber) => ({
      subscriberPubKey: subscriber?.subscriberPubKey,
      role: typeof subscriber?.role === 'string' ? subscriber.role : 'subscriber',
    }))
    .filter(
      (subscriber): subscriber is { subscriberPubKey: string; role: string } =>
        typeof subscriber.subscriberPubKey === 'string' && subscriber.subscriberPubKey.length > 0
    );

  await db.channelThreads.update(channelId, { subscriberCount: subscribers.length });

  return subscribers;
}

export async function addChannelSubscriber(channelId: string, pubKey: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}/subscribers`, {
    method: 'POST',
    body: JSON.stringify({ pubKey }),
  });

  lastChannelsSyncAt = 0;
  return refreshChannelAvailability(channelId);
}

export async function updateChannelSubscriberRole(
  channelId: string,
  pubKey: string,
  role: 'admin' | 'poster' | 'subscriber'
) {
  await fetchJson<void>(`${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}/subscribers`, {
    method: 'PATCH',
    body: JSON.stringify({ pubKey, role }),
  });

  lastChannelsSyncAt = 0;
  return refreshChannelAvailability(channelId);
}

export async function removeChannelSubscriber(channelId: string, pubKey: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}/subscribers?pubKey=${encodeURIComponent(pubKey)}`, {
    method: 'DELETE',
  });

  lastChannelsSyncAt = 0;
  return refreshChannelAvailability(channelId);
}

export async function transferChannelOwnership(channelId: string, newOwnerPubKey: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ newOwnerPubKey }),
  });

  lastChannelsSyncAt = 0;
  return refreshChannelAvailability(channelId);
}

export async function leaveChannel(channelId: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}`, {
    method: 'DELETE',
  });

  lastChannelsSyncAt = 0;
  await db.channelThreads.delete(channelId);
}

export async function deleteChannel(channelId: string) {
  await fetchJson<void>(`${appConfig.backendOrigin}/channels/${encodeURIComponent(channelId)}`, {
    method: 'DELETE',
  });

  lastChannelsSyncAt = 0;
  await db.channelThreads.delete(channelId);
}
