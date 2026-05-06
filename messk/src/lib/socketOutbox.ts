import { db, type OutgoingDirectMessage, type OutgoingGroupEvent } from './db';

export type SelfSyncEnvelopePayload = {
  msgId: string;
  data: string;
  myPublicKey: string;
};

const SERVER_ACK_TYPES = new Set([
  'message',
  'group_message',
  'group_edit',
  'group_delete',
  'group_reaction',
  'group_sender_key',
  'channel_message',
  'channel_edit',
  'channel_delete',
  'channel_reaction',
  'channel_pin',
  'delivery_receipt',
  'read_receipt',
  'edit',
  'delete',
  'reaction',
]);

export function shouldHandleServerAck(ackType?: string | null) {
  if (!ackType) {
    return true;
  }
  return SERVER_ACK_TYPES.has(ackType);
}

export function sendJsonEnvelope(send: (payload: Record<string, unknown>) => void, payload: Record<string, unknown>) {
  send(payload);
}

export function sendDirectEnvelope(send: (payload: Record<string, unknown>) => void, message: OutgoingDirectMessage) {
  send({
    type: 'message',
    msg_id: message.id,
    recipient_pub_key: message.recipientPubKey,
    sender_pub_key: message.senderPubKey,
    data: message.data,
  });
}

export function sendSelfSyncEnvelope(
  send: (payload: Record<string, unknown>) => void,
  message: OutgoingDirectMessage,
  myPublicKey: string
) {
  if (!message.syncData) {
    return;
  }

  send({
    type: 'self_sync',
    msg_id: `${message.id}:self`,
    recipient_pub_key: myPublicKey,
    sender_pub_key: myPublicKey,
    data: message.syncData,
  });
}

export function sendSelfSyncPayload(
  send: (payload: Record<string, unknown>) => void,
  payload: SelfSyncEnvelopePayload
) {
  send({
    type: 'self_sync',
    msg_id: `${payload.msgId}:self`,
    recipient_pub_key: payload.myPublicKey,
    sender_pub_key: payload.myPublicKey,
    data: payload.data,
  });
}

export async function markDirectAttempt(message: OutgoingDirectMessage) {
  await db.outgoingDirectMessages.update(message.id, {
    attempts: message.attempts + 1,
    lastAttemptAt: Date.now(),
  });
}

export async function enqueueOutgoingDirectMessage(message: OutgoingDirectMessage) {
  await db.outgoingDirectMessages.put(message);
}

export async function enqueueOutgoingGroupEvent(event: OutgoingGroupEvent) {
  await db.outgoingGroupEvents.put(event);
}
