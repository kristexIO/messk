import { useAppStore } from '../store';
import { decryptMessage, encryptMessage, x3dhInitiate, x3dhRespond } from './crypto';
import { RatchetManager, type RatchetMessage } from './ratchet';
import { db, syncThreadStats, type ChannelActivityEntry, type OutgoingDirectMessage, type OutgoingGroupEvent, type Session, type StoredMessage } from './db';
import { box, randomBytes, secretbox } from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { sendDesktopNotification } from './notifications';
import { appConfig } from './config';
import { toast } from 'react-hot-toast';
import { fetchWithTimeout } from './http';
import { getMessageNotificationPreview, isMentioningPubKey } from './message-format';

const WS_URL = appConfig.wsUrl;
const DIRECT_RETRY_BASE_DELAY_MS = 3_000;
const DIRECT_RETRY_MAX_DELAY_MS = 30_000;
const SOCKET_FAST_RECONNECT_ATTEMPTS = 5;
const SOCKET_IDLE_RECONNECT_DELAY_MS = 60_000;

type IncomingEnvelope = {
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
};

type X3DHParams = {
  ephemeralPub: string;
  preKeyPubUsed?: string | null;
  pqcCiphertext?: string;
};

type RatchetPayload = RatchetMessage & {
  x3dh?: X3DHParams;
};

type GroupSenderKeyPayload = {
  groupId: string;
  senderKey: string;
  memberFingerprint: string;
};

type GroupInvitePayload = {
  groupId: string;
  title: string;
  avatar?: string;
  role: string;
  memberCount: number;
};

type GroupCipherEnvelope = {
  v: 1;
  mode: 'sender_key_v1';
  ciphertext: string;
};

type GroupEditPayload = {
  text: string;
};

type GroupReactionPayload = {
  reaction: string | null;
};

function getGroupSenderKeyId(groupId: string, senderPubKey: string) {
  return `${groupId}:${senderPubKey}`;
}

function getGroupMemberFingerprint(members: string[]) {
  return [...members].sort().join('|');
}

const groupIssueCooldowns = new Map<string, number>();

function reportGroupIssue(code: string, message: string) {
  const now = Date.now();
  const lastShownAt = groupIssueCooldowns.get(code) ?? 0;
  if (now - lastShownAt < 4000) {
    return;
  }
  groupIssueCooldowns.set(code, now);
  toast.error(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeGroupMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isNonEmptyString);
}

function parseGroupSenderKeyPayload(value: string): GroupSenderKeyPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<GroupSenderKeyPayload>;
    if (!isNonEmptyString(parsed.groupId) || !isNonEmptyString(parsed.senderKey)) {
      return null;
    }
    return {
      groupId: parsed.groupId,
      senderKey: parsed.senderKey,
      memberFingerprint: typeof parsed.memberFingerprint === 'string' ? parsed.memberFingerprint : '',
    };
  } catch {
    return null;
  }
}

function parseGroupInvitePayload(value: string): GroupInvitePayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<GroupInvitePayload>;
    if (
      !isNonEmptyString(parsed.groupId) ||
      !isNonEmptyString(parsed.title) ||
      !isNonEmptyString(parsed.role) ||
      typeof parsed.memberCount !== 'number'
    ) {
      return null;
    }
    return {
      groupId: parsed.groupId,
      title: parsed.title,
      avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
      role: parsed.role,
      memberCount: parsed.memberCount,
    };
  } catch {
    return null;
  }
}

function parseGroupEditPayload(value: string): GroupEditPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<GroupEditPayload>;
    if (!isNonEmptyString(parsed.text)) {
      return null;
    }
    return { text: parsed.text };
  } catch {
    return null;
  }
}

function parseGroupReactionPayload(value: string): GroupReactionPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<GroupReactionPayload>;
    if (parsed.reaction === null || typeof parsed.reaction === 'string') {
      return { reaction: parsed.reaction ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

async function addMessageAndSync(message: StoredMessage) {
  await db.messages.add(message);
  await syncThreadStats(message.peerPublicKey);
}

async function updateMessageAndSync(messageId: number, changes: Partial<StoredMessage>) {
  const existing = await db.messages.get(messageId);
  await db.messages.update(messageId, changes);
  if (existing?.peerPublicKey) {
    await syncThreadStats(existing.peerPublicKey);
  }
}

function parseGroupCipherEnvelope(value: string): GroupCipherEnvelope | null {
  try {
    const parsed = JSON.parse(value) as Partial<GroupCipherEnvelope>;
    if (parsed.v === 1 && parsed.mode === 'sender_key_v1' && typeof parsed.ciphertext === 'string') {
      return {
        v: 1,
        mode: 'sender_key_v1',
        ciphertext: parsed.ciphertext,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function recordChannelActivity(entry: Omit<ChannelActivityEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) {
  await db.channelActivity.put({
    id: entry.id ?? crypto.randomUUID(),
    createdAt: entry.createdAt ?? Date.now(),
    ...entry,
  });
}

export class SocketManager {
  private ws: WebSocket | null = null;
  private static instance: SocketManager;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lastConnectionErrorLogAt = 0;
  private authenticated = false;
  private sessionToken: string | null = null;
  private manualDisconnect = false;
  private pendingPreKeyResolvers = new Map<string, (pk: string | null) => void>();
  private authWaiters: (() => void)[] = [];
  private pendingGroupEvents = new Map<string, IncomingEnvelope[]>();
  private flushingGroupOutbox = false;
  private flushingDirectOutbox = false;
  private profileRefreshAt = new Map<string, number>();
  private profileRefreshInFlight = new Map<string, Promise<void>>();
  private lastKnownProfilesRefreshAt = 0;
  private outboxFlushTimer: ReturnType<typeof setInterval> | null = null;

  private releaseAuthWaiters() {
    if (this.authWaiters.length === 0) {
      return;
    }
    this.authWaiters.forEach((resolve) => resolve());
    this.authWaiters = [];
  }

  static getInstance(): SocketManager {
    if (!SocketManager.instance) {
      SocketManager.instance = new SocketManager();
    }
    return SocketManager.instance;
  }

  private startOutboxLoop() {
    if (this.outboxFlushTimer) {
      return;
    }
    this.outboxFlushTimer = setInterval(() => {
      if (!this.canSendImmediately()) {
        return;
      }
      void this.flushOutgoingDirectMessages();
      void this.flushOutgoingGroupEvents();
    }, 8_000);
  }

  private stopOutboxLoop() {
    if (!this.outboxFlushTimer) {
      return;
    }
    clearInterval(this.outboxFlushTimer);
    this.outboxFlushTimer = null;
  }

  private getDirectRetryDelay(attempts: number) {
    const exponent = Math.max(0, attempts - 1);
    const delay = DIRECT_RETRY_BASE_DELAY_MS * Math.pow(2, exponent);
    return Math.min(DIRECT_RETRY_MAX_DELAY_MS, delay);
  }

  private getReconnectDelay() {
    if (this.reconnectAttempts >= SOCKET_FAST_RECONNECT_ATTEMPTS) {
      return SOCKET_IDLE_RECONNECT_DELAY_MS;
    }
    return Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
  }

  private logConnectionProblem(error?: Event) {
    const now = Date.now();
    if (now - this.lastConnectionErrorLogAt < 15000) {
      return;
    }
    this.lastConnectionErrorLogAt = now;
    console.warn(`WebSocket is unavailable at ${WS_URL}. Check that the backend is running on the configured host and port.`, error);
  }

  connect(pubKey: string) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manualDisconnect = false;
    useAppStore.getState().setConnectionStatus(
      this.reconnectAttempts >= SOCKET_FAST_RECONNECT_ATTEMPTS
        ? 'offline'
        : this.reconnectAttempts > 0
          ? 'reconnecting'
          : 'connecting'
    );

    const url = `${WS_URL}?pub=${encodeURIComponent(pubKey)}`;
    if (this.reconnectAttempts === 0) {
      console.info('Connecting to WS:', url);
    }
    
    this.ws = new WebSocket(url);
    this.authenticated = false;

    this.ws.onopen = () => {
      console.log('WebSocket connection opened. Awaiting auth challenge...');
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    };

    this.ws.onmessage = async (event) => {
      try {
        const { mySecretKey } = useAppStore.getState();
        if (!mySecretKey) return;

        const env = JSON.parse(event.data) as IncomingEnvelope;

        // 1. Auth Challenge
        if (env.type === 'auth_challenge') {
          if (!env.challenge || !env.ephemeral) {
            this.ws?.close();
            return;
          }
          const plaintextChallenge = decryptMessage(env.challenge, mySecretKey, env.ephemeral);
          if (plaintextChallenge) {
            this.ws?.send(JSON.stringify({
              type: 'auth_response',
              challenge: plaintextChallenge
            }));
          } else {
            console.error('Failed to decrypt auth challenge');
            this.ws?.close();
          }
          return;
        }

        if (env.type === 'auth_success') {
          console.log('WebSocket authenticated successfully!');
          this.authenticated = true;
          this.sessionToken = env.session_token ?? null;
          this.reconnectAttempts = 0;
          useAppStore.getState().setConnectionStatus('connected');
          this.releaseAuthWaiters();
          this.startOutboxLoop();
          // Upload prekeys if we don't have enough
          this.ensurePreKeys(pubKey);
          void this.syncMyProfile();
          void this.refreshKnownProfiles();
          void this.flushOutgoingDirectMessages();
          void this.flushOutgoingGroupEvents();
          return;
        }

        if (env.type === 'prekey_bundle') {
          if (!env.recipient_pub_key) return;
          // Handle response to get_prekey
          this.pendingPreKeyResolvers.get(env.recipient_pub_key)?.(env.prekey ?? null);
          this.pendingPreKeyResolvers.delete(env.recipient_pub_key);
          return;
        }

        if (env.type === 'auth_error') {
          console.error('WebSocket authentication failed!');
          this.authenticated = false;
          this.sessionToken = null;
          this.releaseAuthWaiters();
          useAppStore.getState().setConnectionStatus('offline');
          this.ws?.close();
          return;
        }

        if (env.type === 'server_ack') {
          if (!env.msg_id) return;
          if (!env.ack_type || env.ack_type === 'message') {
            await this.handleServerAck(env.msg_id);
          }
          return;
        }

        // 2. Typing indicators
        if (env.type === 'typing') {
          if (!env.sender_pub_key) return;
          const senderPubKey = env.sender_pub_key;
          useAppStore.getState().setTyping(senderPubKey, true);
          // Auto-clear after 3 seconds
          setTimeout(() => useAppStore.getState().setTyping(senderPubKey, false), 3000);
          return;
        }

        // 3. Message interactions
        if (env.type === 'edit') {
           if (!env.sender_pub_key || !env.data || !env.msg_id) return;
           const plaintext = await this.decryptInSession(env.sender_pub_key, env.data);
           if (plaintext) {
               const msg = await db.messages.where('msgId').equals(env.msg_id).first();
               if (msg && msg.id) {
                  await updateMessageAndSync(msg.id, { text: plaintext, editedAt: Date.now(), deletedAt: undefined });
               }
           }
           return;
        }

        if (env.type === 'delete') {
            if (!env.msg_id) return;
            const msg = await db.messages.where('msgId').equals(env.msg_id).first();
            if (msg && msg.id) {
                await updateMessageAndSync(msg.id, {
                  text: '[Message deleted]',
                  deletedAt: Date.now(),
                  editedAt: undefined,
                  reactions: {}
                });
            }
            return;
        }

        if (env.type === 'reaction') {
            if (!env.msg_id || !env.sender_pub_key) return;
            const msg = await db.messages.where('msgId').equals(env.msg_id).first();
            if (msg && msg.id) {
                const reactions = { ...(msg.reactions ?? {}) };
                if (env.reaction) {
                  reactions[env.sender_pub_key] = env.reaction;
                } else {
                  delete reactions[env.sender_pub_key];
                }
                await updateMessageAndSync(msg.id, {
                  reactions
                });
            }
            return;
        }
        if (env.type === 'group_invite') {
          if (!env.sender_pub_key || !env.group_id || !env.data) return;

          const payload = parseGroupInvitePayload(env.data);
          if (!payload) {
            reportGroupIssue('group-invite-payload', 'Received an invalid group invite payload.');
            return;
          }

          await db.groupInvites.put({
            id: env.msg_id ?? `${payload.groupId}:${env.sender_pub_key}`,
            groupId: payload.groupId,
            title: payload.title,
            avatar: payload.avatar?.trim() || null,
            inviterPubKey: env.sender_pub_key,
            role: payload.role,
            memberCount: payload.memberCount,
            createdAt: Date.now(),
          });

          try {
            const community = await import('./community');
            const group = await community.refreshGroupAvailability(payload.groupId);
            if (group) {
              await db.groupInvites.where('groupId').equals(payload.groupId).delete();
              toast.success(`Group "${payload.title}" is now available.`);
            }
          } catch (error) {
            console.warn('Failed to refresh groups for invite', error);
          }
          return;
        }
        if (env.type === 'group_sender_key') {
          if (!env.sender_pub_key || !env.data) return;

          const plaintext = decryptMessage(env.data, mySecretKey, env.sender_pub_key);
          if (!plaintext) {
            reportGroupIssue('group-sender-key-decrypt', 'Failed to decrypt a group sender key update.');
            return;
          }

          const payload = parseGroupSenderKeyPayload(plaintext);
          if (!payload) {
            reportGroupIssue('group-sender-key-payload', 'Received an invalid group key payload.');
            return;
          }
          await this.ensureGroupThreadAvailable(payload.groupId);

          await db.groupSenderKeys.put({
            id: getGroupSenderKeyId(payload.groupId, env.sender_pub_key),
            groupId: payload.groupId,
            senderPubKey: env.sender_pub_key,
            key: payload.senderKey,
            memberFingerprint: payload.memberFingerprint,
            createdAt: Date.now(),
            distributedAt: Date.now(),
          });
          await this.flushPendingGroupEvents(payload.groupId, env.sender_pub_key);
          return;
        }
        if (env.type === 'group_message') {
          await this.handleIncomingGroupMessage(env);
          return;
        }
        if (env.type === 'group_edit') {
          await this.handleIncomingGroupEdit(env);
          return;
        }
        if (env.type === 'group_delete') {
          if (!env.group_id || !env.target_msg_id) return;
          await this.ensureGroupThreadAvailable(env.group_id);
          const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
          if (msg?.id && msg.peerPublicKey === env.group_id) {
            await updateMessageAndSync(msg.id, {
              text: '[Message deleted]',
              deletedAt: Date.now(),
              editedAt: undefined,
              reactions: {},
            });
          }
          return;
        }
        if (env.type === 'group_reaction') {
          await this.handleIncomingGroupReaction(env);
          return;
        }
        if (env.type === 'channel_message') {
          await this.handleIncomingChannelMessage(env);
          return;
        }
        if (env.type === 'channel_edit') {
          await this.handleIncomingChannelEdit(env);
          return;
        }
        if (env.type === 'channel_delete') {
          await this.handleIncomingChannelDelete(env);
          return;
        }
        if (env.type === 'channel_reaction') {
          await this.handleIncomingChannelReaction(env);
          return;
        }
        if (env.type === 'channel_pin') {
          await this.handleIncomingChannelPin(env);
          return;
        }
        if (env.type === 'message' || env.type === 'offline_message') {
          const isForMe = env.recipient_pub_key === pubKey;
          const isFromMe = env.sender_pub_key === pubKey;
          
          if (!isForMe && !isFromMe) return;

          const senderPubKey = env.sender_pub_key;
          const recipientPubKey = env.recipient_pub_key;
          const msgId = env.msg_id || crypto.randomUUID(); // Fallback if old format
          
          if (!senderPubKey || !recipientPubKey) {
              console.warn("Received message without sender or recipient. Ignoring.", env);
              return;
          }

          // Mirror echo from multi-device sync: the backend sends our own
          // message back so other devices can display it. On the *sending*
          // device we already saved it optimistically in send(), so we only
          // need to update the delivery status. Attempting to decrypt here
          // would corrupt the Double Ratchet session because the message
          // was encrypted with the *send* chain, not the receive chain.
          if (isFromMe && !isForMe) {
            console.log("Processing mirror echo for msg:", msgId);
            const existingMsg = await db.messages.where('msgId').equals(msgId).first();
            if (existingMsg?.id && existingMsg.status === 'sent') {
              await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
            }
            return;
          }

          // The peer is whoever we are talking to. 
          // If it's an incoming message, the peer is the sender.
          // If it's a sync message from another of our devices, the peer is the recipient.
          const peerPubKey = isFromMe ? recipientPubKey : senderPubKey;
          console.log("Incoming message from", senderPubKey, "for peer", peerPubKey);

          const existingMsg = await db.messages.where('msgId').equals(msgId).first();
          if (existingMsg) {
            if (existingMsg.id && existingMsg.status !== 'delivered' && existingMsg.status !== 'read') {
              await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
            }
            if (this.authenticated && senderPubKey !== pubKey) {
              this.ws?.send(JSON.stringify({
                type: 'delivery_receipt',
                recipient_pub_key: senderPubKey,
                sender_pub_key: pubKey,
                msg_id: msgId
              }));
            }
            return;
          }

          // Parse data to see if there's x3dh
          let x3dh: X3DHParams | undefined;
          try {
            const parsed = JSON.parse(env.data ?? '') as RatchetPayload;
            x3dh = parsed.x3dh;
          } catch {
            x3dh = undefined;
          }

          const plaintext = await this.decryptInSession(peerPubKey, env.data ?? '', x3dh);
          if (plaintext) {
            console.log("Successfully decrypted message from", senderPubKey);
                // Save new message to DB (cloned to avoid encryption mutation affecting this scope)
                await addMessageAndSync({
                  msgId,
                  peerPublicKey: peerPubKey,
                  senderPublicKey: senderPubKey,
                  text: plaintext,
                  timestamp: Date.now(),
                  status: 'delivered',
                  reactions: {}
                });

                // Native desktop notification
                if (senderPubKey !== pubKey) {
                  const contact = await db.contacts.get(peerPubKey);
                  const muted = Boolean(contact?.mutedUntil && contact.mutedUntil > Date.now());
                  if (muted) {
                    // Respect per-chat mute settings for desktop notifications.
                  } else {
                  const name = contact?.name || peerPubKey.substring(0, 8) + '...';
                  const preview = plaintext.startsWith('{"type"') ? '📎 Вложение' : plaintext.substring(0, 80);
                  sendDesktopNotification(`Сообщение от ${name}`, preview);
                }

                  }

                // Update contact
                const contactExists = await db.contacts.get(peerPubKey);
                if (!contactExists) {
                  await db.contacts.put({
                    pubKey: peerPubKey,
                    name: peerPubKey.substring(0, 8) + '...',
                    lastMessageAt: Date.now()
                  });
                } else {
                  await db.contacts.update(peerPubKey, { lastMessageAt: Date.now() });
                }
                void this.refreshContactProfile(peerPubKey);

            // Send delivery receipt back
            if (this.authenticated && senderPubKey !== pubKey) {
              this.ws?.send(JSON.stringify({
                type: 'delivery_receipt',
                recipient_pub_key: senderPubKey,
                sender_pub_key: pubKey,
                msg_id: msgId
              }));
            }
          } else {
             console.error("Failed to decrypt message from", senderPubKey);
          }
          return;
        }

        // 3. Delivery receipts
        if (env.type === 'delivery_receipt' && env.recipient_pub_key === pubKey) {
          if (!env.msg_id) return;
          const msg = await db.messages.where('msgId').equals(env.msg_id).first();
          if (msg && msg.id) {
             await updateMessageAndSync(msg.id, { status: 'delivered' });
          }
          return;
        }

        if (env.type === 'read_receipt' && env.recipient_pub_key === pubKey) {
          if (!env.msg_id) return;
          const msg = await db.messages.where('msgId').equals(env.msg_id).first();
          if (msg && msg.id) {
             await updateMessageAndSync(msg.id, { status: 'read' });
          }
          return;
        }

        // 4. WebRTC Signaling
        if (env.type === 'call_offer' || env.type === 'call_answer' || env.type === 'call_reject' || env.type === 'call_end' || env.type === 'ice_candidate') {
           window.dispatchEvent(new CustomEvent('webrtc_signal', { detail: env }));
           return;
        }

        // 5. Remote Wipe
        if (env.type === 'wipe_all') {
           console.warn('REMOTE WIPE SIGNAL RECEIVED. CLEARING ALL LOCAL DATA.');
           await db.delete();
           window.location.reload();
           return;
        }

      } catch (err) {
        console.error('Failed to process incoming message:', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.authenticated = false;
      this.sessionToken = null;
      this.stopOutboxLoop();
      this.releaseAuthWaiters();
      this.pendingPreKeyResolvers.forEach((resolve) => resolve(null));
      this.pendingPreKeyResolvers.clear();
      window.dispatchEvent(new CustomEvent('socket_disconnected'));

      if (this.manualDisconnect) {
        useAppStore.getState().setConnectionStatus('offline');
        return;
      }

      const delay = this.getReconnectDelay();
      const nextAttempt = this.reconnectAttempts + 1;
      const isBackgroundRetry = nextAttempt > SOCKET_FAST_RECONNECT_ATTEMPTS;
      useAppStore.getState().setConnectionStatus(isBackgroundRetry ? 'offline' : 'reconnecting');
      if (nextAttempt === 1 || nextAttempt === SOCKET_FAST_RECONNECT_ATTEMPTS || nextAttempt % 10 === 0) {
        console.info(
          isBackgroundRetry
            ? `WebSocket unavailable. Background retry ${nextAttempt} in ${Math.round(delay / 1000)}s.`
            : `WebSocket disconnected. Reconnect attempt ${nextAttempt} in ${Math.round(delay / 1000)}s.`
        );
      }
      this.reconnectAttempts = nextAttempt;
      
      this.reconnectTimer = setTimeout(() => this.connect(pubKey), delay);
    };

    this.ws.onerror = (err) => {
      this.logConnectionProblem(err);
      useAppStore.getState().setConnectionStatus('offline');
      this.ws?.close();
    };
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopOutboxLoop();
    this.releaseAuthWaiters();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.authenticated = false;
      this.sessionToken = null;
    }
    useAppStore.getState().setConnectionStatus('offline');
    this.pendingPreKeyResolvers.forEach((resolve) => resolve(null));
    this.pendingPreKeyResolvers.clear();
    window.dispatchEvent(new CustomEvent('socket_disconnected'));
  }

  isRealtimeReady() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  async ensureRealtimeReady(timeoutMs = 5000) {
    if (this.isRealtimeReady()) {
      return true;
    }

    const { myPublicKey } = useAppStore.getState();
    const wsState = this.ws?.readyState;
    if (
      myPublicKey &&
      (!this.ws || wsState === WebSocket.CLOSING || wsState === WebSocket.CLOSED)
    ) {
      this.connect(myPublicKey);
    }

    if (this.isRealtimeReady()) {
      return true;
    }

    if (!this.ws) {
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING) {
      return false;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const waiter = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.authWaiters = this.authWaiters.filter((candidate) => candidate !== waiter);
        resolve();
      };
      const timer = setTimeout(waiter, timeoutMs);
      this.authWaiters.push(waiter);
    });

    return this.isRealtimeReady();
  }

  getSessionHeaders(): HeadersInit {
    return this.sessionToken ? { 'X-Session-Token': this.sessionToken } : {};
  }

  async syncMyProfile() {
    const { nickname, avatar, username } = useAppStore.getState();
    if (!this.sessionToken) return;

    try {
      const response = await fetchWithTimeout(appConfig.profileUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getSessionHeaders(),
        },
        body: JSON.stringify({
          nickname: nickname ?? '',
          avatar: avatar ?? '',
          username: username,
        }),
      });
      if (response.status === 409) {
        throw new Error('Username is already taken');
      }
      if (!response.ok) {
        throw new Error('Failed to save profile');
      }
    } catch (error) {
      console.warn('Failed to sync profile', error);
      throw error;
    }
  }

  async refreshContactProfile(pubKey: string, force = false) {
    const now = Date.now();
    const lastRefreshedAt = this.profileRefreshAt.get(pubKey) ?? 0;
    if (!force && now - lastRefreshedAt < 5 * 60_000) {
      return;
    }

    const existingRequest = this.profileRefreshInFlight.get(pubKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async () => {
    try {
      const response = await fetchWithTimeout(`${appConfig.profileUrl}?pub=${encodeURIComponent(pubKey)}`, {
        headers: this.getSessionHeaders(),
      });
      if (!response.ok) return;

      const profile = await response.json() as {
        nickname?: string;
        avatar?: string;
        username?: string;
      };
      const fallbackName = pubKey.substring(0, 8) + '...';
      const existingContact = await db.contacts.get(pubKey);
      await db.contacts.put({
        pubKey,
        name: profile.nickname?.trim() || existingContact?.name || fallbackName,
        avatar: profile.avatar || existingContact?.avatar || undefined,
        username: profile.username || existingContact?.username || undefined,
        lastMessageAt: existingContact?.lastMessageAt ?? Date.now(),
        pinned: existingContact?.pinned,
        draft: existingContact?.draft,
        archived: existingContact?.archived,
        mutedUntil: existingContact?.mutedUntil,
      });
      this.profileRefreshAt.set(pubKey, Date.now());
    } catch (error) {
      console.warn('Failed to refresh contact profile', error);
    } finally {
      this.profileRefreshInFlight.delete(pubKey);
    }
    })();

    this.profileRefreshInFlight.set(pubKey, request);
    return request;
  }

  async resolveUsername(username: string): Promise<{ pubKey: string; nickname?: string; avatar?: string } | null> {
    try {
      const url = new URL(appConfig.profileUrl);
      url.pathname = '/resolve';
      url.searchParams.set('username', username);
      
      const response = await fetchWithTimeout(url.toString(), {
        headers: this.getSessionHeaders(),
      });
      if (!response.ok) return null;

      const profile = await response.json() as {
        pubKey: string;
        nickname?: string;
        avatar?: string;
      };
      
      return profile;
    } catch (error) {
      console.warn('Failed to resolve username', error);
      return null;
    }
  }

  async refreshKnownProfiles(force = false) {
    const now = Date.now();
    if (!force && now - this.lastKnownProfilesRefreshAt < 60_000) {
      return;
    }
    this.lastKnownProfilesRefreshAt = now;

    try {
      const contacts = await db.contacts.orderBy('lastMessageAt').reverse().limit(40).toArray();
      await Promise.allSettled(
        contacts.map((contact) => this.refreshContactProfile(contact.pubKey, force))
      );
    } catch (error) {
      console.warn('Failed to refresh known contact profiles', error);
    }
  }

  private async encryptWithSenderKey(senderKeyBase64: string, plaintext: string): Promise<string> {
    const nonce = randomBytes(secretbox.nonceLength);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertext = secretbox(plaintextBytes, nonce, decodeBase64(senderKeyBase64));
    const packed = new Uint8Array(nonce.length + ciphertext.length);
    packed.set(nonce);
    packed.set(ciphertext, nonce.length);
    return JSON.stringify({
      v: 1,
      mode: 'sender_key_v1',
      ciphertext: encodeBase64(packed),
    } satisfies GroupCipherEnvelope);
  }

  private async decryptWithSenderKey(senderKeyBase64: string, data: string): Promise<string | null> {
    try {
      const envelope = JSON.parse(data) as Partial<GroupCipherEnvelope>;
      if (envelope.mode !== 'sender_key_v1' || envelope.v !== 1 || !envelope.ciphertext) {
        return data;
      }

      const packed = decodeBase64(envelope.ciphertext);
      const nonce = packed.slice(0, secretbox.nonceLength);
      const ciphertext = packed.slice(secretbox.nonceLength);
      const plaintext = secretbox.open(ciphertext, nonce, decodeBase64(senderKeyBase64));
      if (!plaintext) {
        return null;
      }
      return new TextDecoder().decode(plaintext);
    } catch {
      return data;
    }
  }

  private async encryptInSession(
    recipientPubKey: string,
    plaintext: string,
    mySecretKey: string,
    myPublicKey: string
  ): Promise<string> {
    let session = await db.sessions.get(recipientPubKey);
    let x3dhParams: X3DHParams | null = null;
    let pqcCiphertext: string | undefined;

    if (!session) {
      const preKeyPub = await this.getPreKeyBundle(recipientPubKey);
      const x3dhRes = await x3dhInitiate(
        mySecretKey,
        myPublicKey,
        recipientPubKey,
        preKeyPub,
        null
      );

      const { sharedSecret, ephemeralPub } = x3dhRes;
      pqcCiphertext = x3dhRes.pqcCiphertext;

      const ratchetKP = box.keyPair();
      session = {
        peerPublicKey: recipientPubKey,
        rootKey: encodeBase64(sharedSecret),
        sendChainKey: encodeBase64(sharedSecret),
        recvChainKey: null,
        sendRatchetPubKey: encodeBase64(ratchetKP.publicKey),
        sendRatchetPrivKey: encodeBase64(ratchetKP.secretKey),
        recvRatchetPubKey: preKeyPub,
        sendChainIndex: 0,
        recvChainIndex: 0,
        previousSendChainLength: 0,
        skippedKeys: {}
      };

      await db.sessions.put({ ...session });
      x3dhParams = { ephemeralPub, preKeyPubUsed: preKeyPub };
    }

    const ratchetMsg = await RatchetManager.encrypt(session, plaintext);
    await db.sessions.put({ ...session });

    return JSON.stringify(
      x3dhParams
        ? { ...ratchetMsg, x3dh: { ...x3dhParams, pqcCiphertext } }
        : ratchetMsg
    );
  }

  private async ensureGroupSenderKey(
    groupId: string,
    myPublicKey: string,
    mySecretKey: string
  ): Promise<string> {
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

    const senderKey = encodeBase64(randomBytes(secretbox.keyLength));
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

          this.ws?.send(JSON.stringify({
            type: 'group_sender_key',
            msg_id: crypto.randomUUID(),
            recipient_pub_key: memberPubKey,
            sender_pub_key: myPublicKey,
            data: encryptedPayload,
          }));
        })
    );

    await db.groupSenderKeys.update(senderKeyId, { distributedAt: Date.now() });
    return senderKey;
  }

  private async waitForGroupSenderKey(groupId: string, senderPubKey: string, reportTimeout = true) {
    const senderKeyId = getGroupSenderKeyId(groupId, senderPubKey);
    for (let attempt = 0; attempt < 20; attempt++) {
      const senderKey = await db.groupSenderKeys.get(senderKeyId);
      if (senderKey) {
        return senderKey;
      }
      if (attempt === 0 || attempt === 6) {
        await this.ensureGroupThreadAvailable(groupId);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (reportTimeout) {
      reportGroupIssue(`group-sender-key-timeout:${groupId}:${senderPubKey}`, 'Group encryption key did not arrive in time. Retry in a moment.');
    }
    return undefined;
  }

  private async ensureGroupThreadAvailable(groupId: string) {
    const existing = await db.groupThreads.get(groupId);
    if (existing) {
      return existing;
    }

    try {
      const community = await import('./community');
      await community.syncGroups(true);
    } catch (error) {
      console.warn('Failed to sync groups for incoming group event', error);
    }

    return db.groupThreads.get(groupId);
  }

  private getPendingGroupEventKey(groupId: string, senderPubKey: string) {
    return `${groupId}:${senderPubKey}`;
  }

  private enqueuePendingGroupEvent(env: IncomingEnvelope) {
    if (!env.group_id || !env.sender_pub_key) {
      return;
    }

    const key = this.getPendingGroupEventKey(env.group_id, env.sender_pub_key);
    const current = this.pendingGroupEvents.get(key) ?? [];
    const dedupeKey = env.type === 'group_message' ? env.msg_id : `${env.type}:${env.target_msg_id ?? env.msg_id ?? ''}`;
    if (dedupeKey && current.some((item) => (item.type === 'group_message' ? item.msg_id : `${item.type}:${item.target_msg_id ?? item.msg_id ?? ''}`) === dedupeKey)) {
      return;
    }
    current.push({ ...env });
    this.pendingGroupEvents.set(key, current.slice(-50));
  }

  private async flushPendingGroupEvents(groupId: string, senderPubKey: string) {
    const key = this.getPendingGroupEventKey(groupId, senderPubKey);
    const pending = this.pendingGroupEvents.get(key);
    if (!pending?.length) {
      return;
    }

    this.pendingGroupEvents.delete(key);
    for (const env of pending) {
      if (env.type === 'group_message') {
        await this.handleIncomingGroupMessage(env);
      } else if (env.type === 'group_edit') {
        await this.handleIncomingGroupEdit(env);
      } else if (env.type === 'group_reaction') {
        await this.handleIncomingGroupReaction(env);
      }
    }
  }

  private async handleIncomingGroupMessage(env: IncomingEnvelope) {
    if (!env.group_id || !env.sender_pub_key || !env.data || !env.msg_id) return;
    await this.ensureGroupThreadAvailable(env.group_id);

    const existingMsg = await db.messages.where('msgId').equals(env.msg_id).first();
    if (existingMsg) {
      if (existingMsg.id && env.sender_pub_key === useAppStore.getState().myPublicKey && existingMsg.status !== 'delivered') {
        await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
      }
      return;
    }

    let plaintext = env.data;
    if (parseGroupCipherEnvelope(env.data)) {
      const senderKey = await this.waitForGroupSenderKey(env.group_id, env.sender_pub_key, false);
      if (!senderKey) {
        this.enqueuePendingGroupEvent(env);
        return;
      }

      const decrypted = await this.decryptWithSenderKey(senderKey.key, env.data);
      if (!decrypted) {
        reportGroupIssue('group-message-decrypt', 'Failed to decrypt a group message.');
        return;
      }
      plaintext = decrypted;
    }

    await addMessageAndSync({
      msgId: env.msg_id,
      peerPublicKey: env.group_id,
      senderPublicKey: env.sender_pub_key,
      text: plaintext,
      timestamp: Date.now(),
      status: 'delivered',
      reactions: {}
    });

    await db.groupThreads.update(env.group_id, { lastActivityAt: Date.now() });

    const { myPublicKey } = useAppStore.getState();
    if (myPublicKey && env.sender_pub_key !== myPublicKey && isMentioningPubKey(plaintext, myPublicKey)) {
      const group = await db.groupThreads.get(env.group_id);
      const preview = getMessageNotificationPreview(plaintext);
      sendDesktopNotification(`Mention in ${group?.title ?? 'group'}`, preview);
    }
  }

  private async enqueueOutgoingGroupEvent(event: OutgoingGroupEvent) {
    await db.outgoingGroupEvents.put(event);
  }

  private canSendImmediately() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  private async enqueueOutgoingDirectMessage(message: OutgoingDirectMessage) {
    await db.outgoingDirectMessages.put(message);
  }

  private sendDirectEnvelope(message: OutgoingDirectMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }

    this.ws.send(JSON.stringify({
      type: 'message',
      msg_id: message.id,
      recipient_pub_key: message.recipientPubKey,
      sender_pub_key: message.senderPubKey,
      data: message.data,
    }));
  }

  private async markDirectAttempt(message: OutgoingDirectMessage) {
    await db.outgoingDirectMessages.update(message.id, {
      attempts: message.attempts + 1,
      lastAttemptAt: Date.now(),
    });
  }

  private async handleServerAck(msgId: string) {
    const queued = await db.outgoingDirectMessages.get(msgId);
    if (queued) {
      await db.outgoingDirectMessages.delete(msgId);
    }

    const msg = await db.messages.where('msgId').equals(msgId).first();
    if (msg?.id && msg.status === 'pending') {
      await updateMessageAndSync(msg.id, { status: 'sent' });
    }
  }

  private async flushOutgoingDirectMessages() {
    if (this.flushingDirectOutbox || !this.canSendImmediately()) {
      return;
    }

    const { myPublicKey } = useAppStore.getState();
    if (!myPublicKey) {
      return;
    }

    this.flushingDirectOutbox = true;
    try {
      const queuedMessages = await db.outgoingDirectMessages.orderBy('createdAt').toArray();
      for (const message of queuedMessages) {
        if (message.senderPubKey !== myPublicKey) {
          continue;
        }
        const retryDelay = this.getDirectRetryDelay(message.attempts);
        if (message.lastAttemptAt && Date.now() - message.lastAttemptAt < retryDelay) {
          continue;
        }
        try {
          this.sendDirectEnvelope(message);
          await this.markDirectAttempt(message);
        } catch (error) {
          console.warn('Failed to flush queued direct message', message.id, error);
          break;
        }
      }
    } finally {
      this.flushingDirectOutbox = false;
    }
  }

  private async flushOutgoingGroupEvents() {
    if (this.flushingGroupOutbox || !this.canSendImmediately()) {
      return;
    }

    const { myPublicKey, mySecretKey } = useAppStore.getState();
    if (!myPublicKey || !mySecretKey) {
      return;
    }

    this.flushingGroupOutbox = true;
    try {
      const queuedEvents = await db.outgoingGroupEvents.orderBy('createdAt').toArray();
      for (const event of queuedEvents) {
        if (event.senderPubKey !== myPublicKey) {
          continue;
        }

        try {
          if (event.type === 'group_message' && event.data) {
            const senderKey = await this.ensureGroupSenderKey(event.groupId, myPublicKey, mySecretKey);
            this.ws?.send(JSON.stringify({
              type: 'group_message',
              msg_id: event.id,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: await this.encryptWithSenderKey(senderKey, event.data),
            }));
          } else if (event.type === 'group_edit' && event.data && event.targetMsgId) {
            const senderKey = await this.ensureGroupSenderKey(event.groupId, myPublicKey, mySecretKey);
            this.ws?.send(JSON.stringify({
              type: 'group_edit',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: await this.encryptWithSenderKey(senderKey, JSON.stringify({ text: event.data } satisfies GroupEditPayload)),
            }));
          } else if (event.type === 'group_delete' && event.targetMsgId) {
            this.ws?.send(JSON.stringify({
              type: 'group_delete',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
            }));
          } else if (event.type === 'group_reaction' && event.targetMsgId) {
            const senderKey = await this.ensureGroupSenderKey(event.groupId, myPublicKey, mySecretKey);
            this.ws?.send(JSON.stringify({
              type: 'group_reaction',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: await this.encryptWithSenderKey(senderKey, JSON.stringify({ reaction: event.reaction ?? null } satisfies GroupReactionPayload)),
            }));
          }

          await db.outgoingGroupEvents.delete(event.id);
        } catch (error) {
          console.warn('Failed to flush queued group event', event.type, error);
          break;
        }
      }
    } finally {
      this.flushingGroupOutbox = false;
    }
  }

  private async handleIncomingGroupEdit(env: IncomingEnvelope) {
    if (!env.group_id || !env.sender_pub_key || !env.target_msg_id || !env.data) return;
    await this.ensureGroupThreadAvailable(env.group_id);

    const senderKey = await this.waitForGroupSenderKey(env.group_id, env.sender_pub_key, false);
    if (!senderKey) {
      this.enqueuePendingGroupEvent(env);
      return;
    }

    const plaintext = await this.decryptWithSenderKey(senderKey.key, env.data);
    if (!plaintext) {
      reportGroupIssue('group-edit-decrypt', 'Failed to decrypt a group edit.');
      return;
    }

    const payload = parseGroupEditPayload(plaintext);
    if (!payload) {
      reportGroupIssue('group-edit-payload', 'Received an invalid group edit payload.');
      return;
    }

    const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
    if (msg?.id && msg.peerPublicKey === env.group_id) {
      await updateMessageAndSync(msg.id, {
        text: payload.text,
        editedAt: Date.now(),
        deletedAt: undefined,
      });
    }
  }

  private async handleIncomingGroupReaction(env: IncomingEnvelope) {
    if (!env.group_id || !env.sender_pub_key || !env.target_msg_id || !env.data) return;
    await this.ensureGroupThreadAvailable(env.group_id);

    const senderKey = await this.waitForGroupSenderKey(env.group_id, env.sender_pub_key, false);
    if (!senderKey) {
      this.enqueuePendingGroupEvent(env);
      return;
    }

    const plaintext = await this.decryptWithSenderKey(senderKey.key, env.data);
    if (!plaintext) {
      reportGroupIssue('group-reaction-decrypt', 'Failed to decrypt a group reaction.');
      return;
    }

    const payload = parseGroupReactionPayload(plaintext);
    if (!payload) {
      reportGroupIssue('group-reaction-payload', 'Received an invalid group reaction payload.');
      return;
    }

    const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
    if (msg?.id && msg.peerPublicKey === env.group_id) {
      const reactions = { ...(msg.reactions ?? {}) };
      if (payload.reaction) {
        reactions[env.sender_pub_key] = payload.reaction;
      } else {
        delete reactions[env.sender_pub_key];
      }
      await updateMessageAndSync(msg.id, { reactions });
    }
  }

  private async handleIncomingChannelMessage(env: IncomingEnvelope) {
    if (!env.group_id || !env.sender_pub_key || !env.data || !env.msg_id) return;

    const existingMsg = await db.messages.where('msgId').equals(env.msg_id).first();
    if (existingMsg) {
      if (existingMsg.id && env.sender_pub_key === useAppStore.getState().myPublicKey && existingMsg.status !== 'delivered') {
        await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
      }
      return;
    }

    await addMessageAndSync({
      msgId: env.msg_id,
      peerPublicKey: env.group_id,
      senderPublicKey: env.sender_pub_key,
      text: env.data,
      timestamp: Date.now(),
      status: 'delivered',
      reactions: {}
    });

    await db.channelThreads.update(env.group_id, { lastActivityAt: Date.now() });

    const { myPublicKey } = useAppStore.getState();
    if (myPublicKey && env.sender_pub_key !== myPublicKey && isMentioningPubKey(env.data, myPublicKey)) {
      const channel = await db.channelThreads.get(env.group_id);
      const preview = getMessageNotificationPreview(env.data);
      sendDesktopNotification(`Mention in ${channel?.title ?? 'channel'}`, preview);
    }
  }

  private async handleIncomingChannelEdit(env: IncomingEnvelope) {
    if (!env.group_id || !env.target_msg_id || !env.data || !env.sender_pub_key) return;

    const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
    if (msg?.id && msg.peerPublicKey === env.group_id) {
      await updateMessageAndSync(msg.id, {
        text: env.data,
        editedAt: Date.now(),
        editedBy: env.sender_pub_key,
        deletedAt: undefined,
      });
      await recordChannelActivity({
        id: `channel-edit:${env.group_id}:${env.msg_id ?? env.target_msg_id}`,
        channelId: env.group_id,
        type: 'post_edited',
        actorPubKey: env.sender_pub_key,
        msgId: env.target_msg_id,
      });
    }
  }

  private async handleIncomingChannelDelete(env: IncomingEnvelope) {
    if (!env.group_id || !env.target_msg_id || !env.sender_pub_key) return;

    const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
    if (msg?.id && msg.peerPublicKey === env.group_id) {
      await updateMessageAndSync(msg.id, {
        text: '[Message deleted]',
        deletedAt: Date.now(),
        deletedBy: env.sender_pub_key,
        editedAt: undefined,
        reactions: {},
      });
      await recordChannelActivity({
        id: `channel-delete:${env.group_id}:${env.msg_id ?? env.target_msg_id}`,
        channelId: env.group_id,
        type: 'post_deleted',
        actorPubKey: env.sender_pub_key,
        msgId: env.target_msg_id,
      });
    }
  }

  private async handleIncomingChannelReaction(env: IncomingEnvelope) {
    if (!env.group_id || !env.target_msg_id || !env.sender_pub_key) return;

    const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
    if (msg?.id && msg.peerPublicKey === env.group_id) {
      const reactions = { ...(msg.reactions ?? {}) };
      if (env.reaction) {
        reactions[env.sender_pub_key] = env.reaction;
      } else {
        delete reactions[env.sender_pub_key];
      }
      await updateMessageAndSync(msg.id, { reactions });
    }
  }

  private async handleIncomingChannelPin(env: IncomingEnvelope) {
    if (!env.group_id || !env.sender_pub_key) return;
    const nextPinnedMsgId = env.target_msg_id?.trim() || null;
    await db.channelThreads.update(env.group_id, { pinnedMsgId: nextPinnedMsgId });
    await recordChannelActivity({
      id: `channel-pin:${env.group_id}:${env.msg_id ?? nextPinnedMsgId ?? 'clear'}`,
      channelId: env.group_id,
      type: nextPinnedMsgId ? 'post_pinned' : 'post_unpinned',
      actorPubKey: env.sender_pub_key,
      msgId: nextPinnedMsgId ?? undefined,
    });
  }


  private async ensurePreKeys(pubKey: string) {
    const count = await db.prekeys.count();
    if (count < 50) {
      const newKeys = [];
      const pubKeysForUpload = [];
      for (let i = 0; i < 100 - count; i++) {
        const kp = box.keyPair();
        const pkBase64 = encodeBase64(kp.publicKey);
        const skBase64 = encodeBase64(kp.secretKey);
        newKeys.push({ publicKey: pkBase64, secretKey: skBase64 });
        pubKeysForUpload.push(pkBase64);
      }
      
      // Generate a stub Signed PreKey
      const spkPair = box.keyPair();
      const spkBase64 = encodeBase64(spkPair.publicKey);
      const spkSig = 'dummy_sig'; // TODO: replace with Ed25519 signature when identity keys are separated

      // Save prekeys to DB (clone to avoid in-place mutation)
      await db.prekeys.bulkAdd(newKeys.map(pk => ({ ...pk })));
      this.ws?.send(JSON.stringify({
        type: 'upload_prekeys',
        sender_pub_key: pubKey,
        prekeys: pubKeysForUpload,
        signed_prekey: spkBase64,
        signed_prekey_sig: spkSig
      }));
    }
  }

  private async decryptInSession(peerPubKey: string, data: string, x3dh?: X3DHParams): Promise<string | null> {
    const { mySecretKey } = useAppStore.getState();
    if (!mySecretKey) return null;

    let ratchetData: RatchetPayload;
    try {
      ratchetData = JSON.parse(data) as RatchetPayload;
    } catch {
      return null;
    }

    let session: Session | undefined = await db.sessions.get(peerPubKey);

    // Handle X3DH
    if (!session && x3dh) {
      const { ephemeralPub, preKeyPubUsed } = x3dh;
      let myPreKeyPriv: string | null = null;
      if (preKeyPubUsed) {
        const storedPreKey = await db.prekeys.where('publicKey').equals(preKeyPubUsed).first();
        if (storedPreKey) {
          myPreKeyPriv = storedPreKey.secretKey;
          await db.prekeys.delete(storedPreKey.id!);
        }
      }

      // Create session regardless of whether a prekey was used.
      // x3dhRespond handles null prekey by zeroing the DH components,
      // matching x3dhInitiate's fallback path.
      if (ephemeralPub) {
        const sharedSecret = await x3dhRespond(mySecretKey, myPreKeyPriv, null, peerPubKey, ephemeralPub, x3dh.pqcCiphertext ?? null);
        const ratchetKP = box.keyPair();
        session = {
          peerPublicKey: peerPubKey,
          rootKey: encodeBase64(sharedSecret),
          sendChainKey: null,
          recvChainKey: encodeBase64(sharedSecret),
          sendRatchetPubKey: encodeBase64(ratchetKP.publicKey),
          sendRatchetPrivKey: encodeBase64(ratchetKP.secretKey),
          recvRatchetPubKey: ratchetData.header.ratchetPubKey,
          sendChainIndex: 0,
          recvChainIndex: 0,
          previousSendChainLength: 0,
          skippedKeys: {}
        };
        await db.sessions.put({ ...session });
      }
    }

    if (!session) return null;

    const plaintext = await RatchetManager.decrypt(session, ratchetData);
    if (plaintext) {
      await db.sessions.put({ ...session });
    }
    return plaintext;
  }

  private async getPreKeyBundle(peerPubKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.pendingPreKeyResolvers.set(peerPubKey, resolve);
      this.ws?.send(JSON.stringify({
        type: 'get_prekey',
        recipient_pub_key: peerPubKey
      }));
      // Timeout
      setTimeout(() => {
        if (this.pendingPreKeyResolvers.has(peerPubKey)) {
          this.pendingPreKeyResolvers.delete(peerPubKey);
          resolve(null);
        }
      }, 5000);
    });
  }

  async send(recipientPubKey: string, plaintext: string, mySecretKey: string, myPublicKey: string) {
    if (this.ws?.readyState === WebSocket.OPEN && !this.authenticated) {
      console.log("Waiting for authentication before sending...");
      await new Promise<void>((resolve) => {
        this.authWaiters.push(resolve);
        // Timeout after 5s
        setTimeout(resolve, 5000);
      });
      if (!this.authenticated) throw new Error('Authentication timeout');
    }

    if (!this.canSendImmediately()) {
      const existingSession = await db.sessions.get(recipientPubKey);
      if (!existingSession) {
        throw new Error('Connect once with this contact before sending offline messages.');
      }
    }

    const msgId = crypto.randomUUID();
    const queuedMessage: OutgoingDirectMessage = {
      id: msgId,
      recipientPubKey,
      senderPubKey: myPublicKey,
      data: await this.encryptInSession(recipientPubKey, plaintext, mySecretKey, myPublicKey),
      createdAt: Date.now(),
      attempts: 0,
    };

    await addMessageAndSync({
      msgId,
      peerPublicKey: recipientPubKey,
      senderPublicKey: myPublicKey,
      text: plaintext,
      timestamp: queuedMessage.createdAt,
      status: 'pending',
      reactions: {}
    });
    await this.enqueueOutgoingDirectMessage(queuedMessage);

    if (this.canSendImmediately()) {
      this.sendDirectEnvelope(queuedMessage);
      await this.markDirectAttempt(queuedMessage);
    } else {
      toast('Queued and will send when connection is back.', { icon: 'вЏі' });
    }
  }

  async sendGroupMessage(groupId: string, plaintext: string, myPublicKey: string, mySecretKey: string) {
    const msgId = crypto.randomUUID();

    await addMessageAndSync({
      msgId,
      peerPublicKey: groupId,
      senderPublicKey: myPublicKey,
      text: plaintext,
      timestamp: Date.now(),
      status: this.canSendImmediately() ? 'delivered' : 'pending',
      reactions: {}
    });
    await db.groupThreads.update(groupId, { lastActivityAt: Date.now() });

    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: msgId,
        type: 'group_message',
        groupId,
        senderPubKey: myPublicKey,
        data: plaintext,
        createdAt: Date.now(),
      });
      toast('Queued and will send when connection is back.', { icon: '⏳' });
      return;
    }

    const senderKey = await this.ensureGroupSenderKey(groupId, myPublicKey, mySecretKey);
    this.ws?.send(JSON.stringify({
      type: 'group_message',
      msg_id: msgId,
      group_id: groupId,
      sender_pub_key: myPublicKey,
      data: await this.encryptWithSenderKey(senderKey, plaintext),
    }));
  }

  async sendGroupEdit(groupId: string, targetMsgId: string, plaintext: string, myPublicKey: string, mySecretKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'group_edit',
        groupId,
        senderPubKey: myPublicKey,
        data: plaintext,
        targetMsgId,
        createdAt: Date.now(),
      });
      toast('Group edit queued for reconnect.', { icon: '⏳' });
    } else {
      const senderKey = await this.ensureGroupSenderKey(groupId, myPublicKey, mySecretKey);
      this.ws?.send(JSON.stringify({
        type: 'group_edit',
        msg_id: eventId,
        target_msg_id: targetMsgId,
        group_id: groupId,
        sender_pub_key: myPublicKey,
        data: await this.encryptWithSenderKey(senderKey, JSON.stringify({ text: plaintext } satisfies GroupEditPayload)),
      }));
    }

    const msg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, { text: plaintext, editedAt: Date.now(), deletedAt: undefined });
    }
  }

  async sendGroupDelete(groupId: string, targetMsgId: string, myPublicKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'group_delete',
        groupId,
        senderPubKey: myPublicKey,
        targetMsgId,
        createdAt: Date.now(),
      });
      toast('Group delete queued for reconnect.', { icon: '⏳' });
    } else {
      this.ws?.send(JSON.stringify({
        type: 'group_delete',
        msg_id: eventId,
        target_msg_id: targetMsgId,
        group_id: groupId,
        sender_pub_key: myPublicKey,
      }));
    }

    const msg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, {
        text: '[Message deleted]',
        deletedAt: Date.now(),
        editedAt: undefined,
        reactions: {}
      });
    }
  }

  async sendGroupReaction(groupId: string, targetMsgId: string, reaction: string | null, myPublicKey: string, mySecretKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'group_reaction',
        groupId,
        senderPubKey: myPublicKey,
        targetMsgId,
        reaction,
        createdAt: Date.now(),
      });
      toast('Group reaction queued for reconnect.', { icon: '⏳' });
    } else {
      const senderKey = await this.ensureGroupSenderKey(groupId, myPublicKey, mySecretKey);
      this.ws?.send(JSON.stringify({
        type: 'group_reaction',
        msg_id: eventId,
        target_msg_id: targetMsgId,
        group_id: groupId,
        sender_pub_key: myPublicKey,
        data: await this.encryptWithSenderKey(senderKey, JSON.stringify({ reaction } satisfies GroupReactionPayload)),
      }));
    }

    const msg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (msg?.id) {
      const reactions = { ...(msg.reactions ?? {}) };
      if (reaction) {
        reactions[myPublicKey] = reaction;
      } else {
        delete reactions[myPublicKey];
      }
      await updateMessageAndSync(msg.id, { reactions });
    }
  }

  async sendChannelMessage(channelId: string, plaintext: string, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Socket disconnected');
    }
    if (!this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }

    const msgId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'channel_message',
      msg_id: msgId,
      group_id: channelId,
      sender_pub_key: myPublicKey,
      data: plaintext,
    }));

    await addMessageAndSync({
      msgId,
      peerPublicKey: channelId,
      senderPublicKey: myPublicKey,
      text: plaintext,
      timestamp: Date.now(),
      status: 'delivered',
      reactions: {}
    });
    await db.channelThreads.update(channelId, { lastActivityAt: Date.now() });
  }

  async sendChannelEdit(channelId: string, targetMsgId: string, plaintext: string, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'channel_edit',
      msg_id: eventId,
      target_msg_id: targetMsgId,
      group_id: channelId,
      sender_pub_key: myPublicKey,
      data: plaintext,
    }));

    const msg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, { text: plaintext, editedAt: Date.now(), deletedAt: undefined });
    }
  }

  async sendChannelDelete(channelId: string, targetMsgId: string, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'channel_delete',
      msg_id: eventId,
      target_msg_id: targetMsgId,
      group_id: channelId,
      sender_pub_key: myPublicKey,
    }));

    const msg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, {
        text: '[Message deleted]',
        deletedAt: Date.now(),
        editedAt: undefined,
        reactions: {}
      });
    }
  }

  async sendChannelReaction(channelId: string, targetMsgId: string, reaction: string | null, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'channel_reaction',
      msg_id: eventId,
      target_msg_id: targetMsgId,
      group_id: channelId,
      sender_pub_key: myPublicKey,
      reaction: reaction ?? '',
    }));

    const msg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (msg?.id) {
      const reactions = { ...(msg.reactions ?? {}) };
      if (reaction) {
        reactions[myPublicKey] = reaction;
      } else {
        delete reactions[myPublicKey];
      }
      await updateMessageAndSync(msg.id, { reactions });
    }
  }

  async sendChannelPin(channelId: string, targetMsgId: string | null, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'channel_pin',
      msg_id: eventId,
      target_msg_id: targetMsgId ?? '',
      group_id: channelId,
      sender_pub_key: myPublicKey,
      data: '',
    }));

    await db.channelThreads.update(channelId, { pinnedMsgId: targetMsgId });
  }

  sendTyping(recipientPubKey: string, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) return;
    this.ws.send(JSON.stringify({
      type: 'typing',
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey
    }));
  }

  async sendReadReceipt(recipientPubKey: string, msgId: string, myPublicKey: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) return;
    this.ws.send(JSON.stringify({
      type: 'read_receipt',
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey,
      msg_id: msgId
    }));

    const msg = await db.messages.where('msgId').equals(msgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, { status: 'read' });
    }
  }

  async sendEdit(recipientPubKey: string, msgId: string, plaintext: string) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !myPublicKey) return;

    const session = await db.sessions.get(recipientPubKey);
    if (!session) {
      throw new Error('Secure session not ready');
    }

    const ratchetMsg = await RatchetManager.encrypt(session, plaintext);
    await db.sessions.put(session);

    this.ws.send(JSON.stringify({
      type: 'edit',
      msg_id: msgId,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey,
      data: JSON.stringify(ratchetMsg)
    }));

    const msg = await db.messages.where('msgId').equals(msgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, { text: plaintext, editedAt: Date.now(), deletedAt: undefined });
    }
  }

  async sendDelete(recipientPubKey: string, msgId: string) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !myPublicKey) return;

    this.ws.send(JSON.stringify({
      type: 'delete',
      msg_id: msgId,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey
    }));

    const msg = await db.messages.where('msgId').equals(msgId).first();
    if (msg?.id) {
      await updateMessageAndSync(msg.id, {
        text: '[Message deleted]',
        deletedAt: Date.now(),
        editedAt: undefined,
        reactions: {}
      });
    }
  }

  async sendReaction(recipientPubKey: string, msgId: string, reaction: string | null) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !myPublicKey) return;

    this.ws.send(JSON.stringify({
      type: 'reaction',
      msg_id: msgId,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey,
      reaction: reaction ?? ''
    }));

    const msg = await db.messages.where('msgId').equals(msgId).first();
    if (msg?.id) {
      const reactions = { ...(msg.reactions ?? {}) };
      if (reaction) {
        reactions[myPublicKey] = reaction;
      } else {
        delete reactions[myPublicKey];
      }
      await updateMessageAndSync(msg.id, { reactions });
    }
  }

  sendSignal(recipientPubKey: string, type: 'call_offer' | 'call_answer' | 'call_reject' | 'call_end' | 'ice_candidate', signalData: unknown) {
    if (!recipientPubKey || !this.isRealtimeReady()) return false;
    const ws = this.ws;
    if (!ws) return false;
    ws.send(JSON.stringify({
      type,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: useAppStore.getState().myPublicKey,
      data: JSON.stringify(signalData)
    }));
    return true;
  }
}

export const socketManager = SocketManager.getInstance();
