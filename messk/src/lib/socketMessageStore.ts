import { db, syncThreadStats, type ChannelActivityEntry, type StoredMessage } from './db';

export async function addMessageAndSync(message: StoredMessage) {
  await db.messages.add(message);
  await syncThreadStats(message.peerPublicKey);
}

export async function updateMessageAndSync(messageId: number, changes: Partial<StoredMessage>) {
  const existing = await db.messages.get(messageId);
  await db.messages.update(messageId, changes);
  if (existing?.peerPublicKey) {
    await syncThreadStats(existing.peerPublicKey);
  }
}

export async function updateMessageByMsgID(msgId: string, changes: Partial<StoredMessage>) {
  const existing = await db.messages.where('msgId').equals(msgId).first();
  if (existing?.id) {
    await updateMessageAndSync(existing.id, changes);
  }
  return existing;
}

export async function markMessageEdited(msgId: string, text: string, editedBy?: string) {
  return updateMessageByMsgID(msgId, {
    text,
    editedAt: Date.now(),
    editedBy,
    deletedAt: undefined,
  });
}

export async function markMessageDeleted(msgId: string, deletedBy?: string) {
  return updateMessageByMsgID(msgId, {
    text: '[Message deleted]',
    deletedAt: Date.now(),
    deletedBy,
    editedAt: undefined,
    reactions: {},
  });
}

export async function applyMessageReaction(msgId: string, actorPubKey: string, reaction: string | null) {
  const existing = await db.messages.where('msgId').equals(msgId).first();
  if (!existing?.id) {
    return existing;
  }

  const reactions = { ...(existing.reactions ?? {}) };
  if (reaction) {
    reactions[actorPubKey] = reaction;
  } else {
    delete reactions[actorPubKey];
  }
  await updateMessageAndSync(existing.id, { reactions });
  return existing;
}

export async function recordChannelActivity(
  entry: Omit<ChannelActivityEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: number }
) {
  await db.channelActivity.put({
    id: entry.id ?? crypto.randomUUID(),
    createdAt: entry.createdAt ?? Date.now(),
    ...entry,
  });
}
