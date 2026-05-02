import type { StoredMessage } from './db';

export type IncomingEnvelope = {
  type: string;
  recipient_pub_key?: string;
  group_id?: string;
  target_msg_id?: string;
  sender_pub_key?: string;
  data?: string;
  msg_id?: string;
  ack_type?: string;
  prekey?: string | null;
  reaction?: string;
  challenge?: string;
  ephemeral?: string;
  session_token?: string;
  signed_prekey?: string | null;
  signed_prekey_sig?: string | null;
  message?: string;
  retry_after_sec?: number;
};

export type IncomingEnvelopeLike = IncomingEnvelope;

export type X3DHParams = {
  ephemeralPub: string;
  preKeyPubUsed?: string | null;
  pqcCiphertext?: string;
};

export type MessageStatus = StoredMessage['status'];
