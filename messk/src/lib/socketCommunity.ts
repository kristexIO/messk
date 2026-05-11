import { useAppStore } from '../store';
import { db } from './db';
import { getMessageNotificationPreview, isMentioningPubKey } from './message-format';
import { sendDesktopNotification } from './notifications';
import type { IncomingEnvelopeLike } from './socketTypes';
import {
  addMessageAndSync,
  applyMessageReaction,
  markMessageDeleted,
  markMessageEdited,
  recordChannelActivity,
  updateMessageAndSync,
} from './socketMessageStore';

export async function applyOptimisticGroupEdit(targetMsgId: string, plaintext: string) {
  await markMessageEdited(targetMsgId, plaintext);
}

export async function applyOptimisticGroupDelete(targetMsgId: string) {
  await markMessageDeleted(targetMsgId);
}

export async function applyOptimisticGroupReaction(targetMsgId: string, myPublicKey: string, reaction: string | null) {
  await applyMessageReaction(targetMsgId, myPublicKey, reaction);
}

export async function applyOptimisticChannelEdit(targetMsgId: string, plaintext: string) {
  await markMessageEdited(targetMsgId, plaintext);
}

export async function applyOptimisticChannelDelete(targetMsgId: string) {
  await markMessageDeleted(targetMsgId);
}

export async function applyOptimisticChannelReaction(targetMsgId: string, myPublicKey: string, reaction: string | null) {
  await applyMessageReaction(targetMsgId, myPublicKey, reaction);
}

export async function handleIncomingChannelMessage(env: IncomingEnvelopeLike): Promise<boolean> {
  if (!env.group_id || !env.sender_pub_key || !env.data || !env.msg_id) {
    return false;
  }

  const existingMsg = await db.messages.where('msgId').equals(env.msg_id).first();
  if (existingMsg) {
    if (existingMsg.id && env.sender_pub_key === useAppStore.getState().myPublicKey && existingMsg.status !== 'delivered') {
      await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
    }
    return true;
  }

  await addMessageAndSync({
    msgId: env.msg_id,
    peerPublicKey: env.group_id,
    senderPublicKey: env.sender_pub_key,
    text: env.data,
    timestamp: Date.now(),
    status: 'delivered',
    reactions: {},
  });

  await db.channelThreads.update(env.group_id, { lastActivityAt: Date.now() });

  const { myPublicKey } = useAppStore.getState();
  if (myPublicKey && env.sender_pub_key !== myPublicKey && isMentioningPubKey(env.data, myPublicKey)) {
    const channel = await db.channelThreads.get(env.group_id);
    const preview = getMessageNotificationPreview(env.data);
    sendDesktopNotification(`Mention in ${channel?.title ?? 'channel'}`, preview);
  }
  return true;
}

export async function handleIncomingChannelEdit(env: IncomingEnvelopeLike): Promise<boolean> {
  if (!env.group_id || !env.target_msg_id || !env.data || !env.sender_pub_key) {
    return false;
  }

  const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
  if (msg?.id && msg.peerPublicKey === env.group_id) {
    await markMessageEdited(env.target_msg_id, env.data, env.sender_pub_key);
    await recordChannelActivity({
      id: `channel-edit:${env.group_id}:${env.msg_id ?? env.target_msg_id}`,
      channelId: env.group_id,
      type: 'post_edited',
      actorPubKey: env.sender_pub_key,
      msgId: env.target_msg_id,
    });
    return true;
  }
  return false;
}

export async function handleIncomingChannelDelete(env: IncomingEnvelopeLike): Promise<boolean> {
  if (!env.group_id || !env.target_msg_id || !env.sender_pub_key) {
    return false;
  }

  const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
  if (msg?.id && msg.peerPublicKey === env.group_id) {
    await markMessageDeleted(env.target_msg_id, env.sender_pub_key);
    await recordChannelActivity({
      id: `channel-delete:${env.group_id}:${env.msg_id ?? env.target_msg_id}`,
      channelId: env.group_id,
      type: 'post_deleted',
      actorPubKey: env.sender_pub_key,
      msgId: env.target_msg_id,
    });
    return true;
  }
  return false;
}

export async function handleIncomingChannelReaction(env: IncomingEnvelopeLike): Promise<boolean> {
  if (!env.group_id || !env.target_msg_id || !env.sender_pub_key) {
    return false;
  }

  const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
  if (msg?.id && msg.peerPublicKey === env.group_id) {
    await applyMessageReaction(env.target_msg_id, env.sender_pub_key, env.reaction ?? null);
    return true;
  }
  return false;
}

export async function handleIncomingChannelPin(env: IncomingEnvelopeLike): Promise<boolean> {
  if (!env.group_id || !env.sender_pub_key) {
    return false;
  }

  const nextPinnedMsgId = env.target_msg_id?.trim() || null;
  await db.channelThreads.update(env.group_id, { pinnedMsgId: nextPinnedMsgId });
  await recordChannelActivity({
    id: `channel-pin:${env.group_id}:${env.msg_id ?? nextPinnedMsgId ?? 'clear'}`,
    channelId: env.group_id,
    type: nextPinnedMsgId ? 'post_pinned' : 'post_unpinned',
    actorPubKey: env.sender_pub_key,
    msgId: nextPinnedMsgId ?? undefined,
  });
  return true;
}
