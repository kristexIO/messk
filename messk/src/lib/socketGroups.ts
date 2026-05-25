import { randomBytes, secretbox } from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { encryptMessage } from './crypto';
import { db } from './db';
import type { IncomingEnvelopeLike } from './socketTypes';
import { syncGroups } from './community';

export type GroupSenderKeyPayload = {
  groupId: string;
  senderKey: string;
  memberFingerprint: string;
};

export function getGroupSenderKeyId(groupId: string, senderPubKey: string) {
  return `${groupId}:${senderPubKey}`;
}

export function getGroupMemberFingerprint(members: string[]) {
  return [...members].sort().join('|');
}

export function normalizeGroupMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((member): member is string => typeof member === 'string' && member.trim().length > 0);
}

export async function ensureGroupThreadAvailable(groupId: string) {
  const existing = await db.groupThreads.get(groupId);
  if (existing) {
    return existing;
  }

  try {
    await syncGroups(true);
  } catch (error) {
    console.warn('Failed to sync groups for incoming group event', error);
  }

  return db.groupThreads.get(groupId);
}

type EnsureGroupSenderKeyArgs = {
  groupId: string;
  myPublicKey: string;
  mySecretKey: string;
  reportGroupIssue: (code: string, message: string) => void;
  sendEnvelope: (payload: Record<string, unknown>) => void;
};

export async function ensureGroupSenderKey({
  groupId,
  myPublicKey,
  mySecretKey,
  reportGroupIssue,
  sendEnvelope,
}: EnsureGroupSenderKeyArgs): Promise<string> {
  const group = await db.groupThreads.get(groupId);
  if (!group) {
    reportGroupIssue('group-metadata-missing', 'Group details are not loaded yet. Try again in a moment.');
    throw new Error('Group metadata is not available yet');
  }

  const members = normalizeGroupMembers(group.members);
  const senderKeyId = getGroupSenderKeyId(groupId, myPublicKey);
  const memberFingerprint = getGroupMemberFingerprint(members);
  const existingKey = await db.groupSenderKeys.get(senderKeyId);

  if (existingKey && existingKey.memberFingerprint === memberFingerprint) {
    return existingKey.key;
  }

  const senderKeyBytes = randomBytes(secretbox.keyLength);
  let senderKey: string;
  try {
    senderKey = encodeBase64(senderKeyBytes);
  } finally {
    senderKeyBytes.fill(0);
  }
  await db.groupSenderKeys.put({
    id: senderKeyId,
    groupId,
    senderPubKey: myPublicKey,
    key: senderKey,
    memberFingerprint,
    createdAt: Date.now(),
    distributedAt: existingKey?.distributedAt,
  });

  await Promise.all(
    members
      .filter((memberPubKey) => memberPubKey !== myPublicKey)
      .map(async (memberPubKey) => {
        const encryptedPayload = encryptMessage(
          JSON.stringify({
            groupId,
            senderKey,
            memberFingerprint,
          } satisfies GroupSenderKeyPayload),
          mySecretKey,
          memberPubKey
        );

        sendEnvelope({
          type: 'group_sender_key',
          msg_id: crypto.randomUUID(),
          recipient_pub_key: memberPubKey,
          sender_pub_key: myPublicKey,
          data: encryptedPayload,
        });
      })
  );

  await db.groupSenderKeys.update(senderKeyId, { distributedAt: Date.now() });
  return senderKey;
}

type WaitForGroupSenderKeyArgs = {
  groupId: string;
  senderPubKey: string;
  reportTimeout?: boolean;
  reportGroupIssue: (code: string, message: string) => void;
  ensureGroupThreadAvailable: (groupId: string) => Promise<unknown>;
};

export async function waitForGroupSenderKey({
  groupId,
  senderPubKey,
  reportTimeout = true,
  reportGroupIssue,
  ensureGroupThreadAvailable: ensureThread,
}: WaitForGroupSenderKeyArgs) {
  const senderKeyId = getGroupSenderKeyId(groupId, senderPubKey);
  for (let attempt = 0; attempt < 20; attempt++) {
    const senderKey = await db.groupSenderKeys.get(senderKeyId);
    if (senderKey) {
      return senderKey;
    }
    if (attempt === 0 || attempt === 6) {
      await ensureThread(groupId);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (reportTimeout) {
    reportGroupIssue(`group-sender-key-timeout:${groupId}:${senderPubKey}`, 'Group encryption key did not arrive in time. Retry in a moment.');
  }
  return undefined;
}

export function getPendingGroupEventKey(groupId: string, senderPubKey: string) {
  return `${groupId}:${senderPubKey}`;
}

export function enqueuePendingGroupEvent(
  pendingGroupEvents: Map<string, IncomingEnvelopeLike[]>,
  env: IncomingEnvelopeLike
) {
  if (!env.group_id || !env.sender_pub_key) {
    return;
  }

  const key = getPendingGroupEventKey(env.group_id, env.sender_pub_key);
  const current = pendingGroupEvents.get(key) ?? [];
  const dedupeKey = env.type === 'group_message' ? env.msg_id : `${env.type}:${env.target_msg_id ?? env.msg_id ?? ''}`;
  if (
    dedupeKey &&
    current.some((item) => (item.type === 'group_message' ? item.msg_id : `${item.type}:${item.target_msg_id ?? item.msg_id ?? ''}`) === dedupeKey)
  ) {
    return;
  }
  current.push({ ...env });
  pendingGroupEvents.set(key, current.slice(-50));
}

export function takePendingGroupEvents(
  pendingGroupEvents: Map<string, IncomingEnvelopeLike[]>,
  groupId: string,
  senderPubKey: string
) {
  const key = getPendingGroupEventKey(groupId, senderPubKey);
  const pending = pendingGroupEvents.get(key) ?? [];
  pendingGroupEvents.delete(key);
  return pending;
}
