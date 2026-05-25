import { useAppStore } from '../store';
import { decryptMessage, encryptMessage, x3dhInitiate, x3dhRespond } from './crypto';
import { RatchetManager, type RatchetMessage } from './ratchet';
import {
  db,
  reconcileDirectContactsFromMessages,
  type OutgoingDirectMessage,
  type OutgoingGroupEvent,
  type Session,
  type StoredMessage,
} from './db';
import { box, randomBytes, secretbox } from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { sendDesktopNotification } from './notifications';
import { appConfig } from './config';
import { toast } from 'react-hot-toast';
import { getMessageNotificationPreview, isMentioningPubKey } from './message-format';
import { refreshGroupAvailability } from './community';
import { SocketApiClient, type DirectHistoryRecord, type ResolvedUserProfile, type SessionListResponse } from './socketApi';
import {
  addMessageAndSync,
  applyMessageReaction,
  markMessageDeleted,
  markMessageEdited,
  updateMessageAndSync,
  updateMessageByMsgID,
} from './socketMessageStore';
import {
  applyOptimisticChannelDelete,
  applyOptimisticChannelEdit,
  applyOptimisticChannelReaction,
  applyOptimisticGroupDelete,
  applyOptimisticGroupEdit,
  applyOptimisticGroupReaction,
  handleIncomingChannelDelete as handleIncomingChannelDeleteEvent,
  handleIncomingChannelEdit as handleIncomingChannelEditEvent,
  handleIncomingChannelMessage as handleIncomingChannelMessageEvent,
  handleIncomingChannelPin as handleIncomingChannelPinEvent,
  handleIncomingChannelReaction as handleIncomingChannelReactionEvent,
} from './socketCommunity';
import { type IncomingEnvelope, type X3DHParams } from './socketTypes';
import {
  enqueueOutgoingDirectMessage,
  enqueueOutgoingGroupEvent,
  markDirectAttempt,
  sendDirectEnvelope,
  sendJsonEnvelope,
  sendSelfSyncEnvelope,
  sendSelfSyncPayload,
  shouldHandleServerAck,
} from './socketOutbox';
import {
  ensureGroupSenderKey,
  ensureGroupThreadAvailable,
  enqueuePendingGroupEvent,
  getGroupSenderKeyId,
  takePendingGroupEvents,
  type GroupSenderKeyPayload,
  waitForGroupSenderKey,
} from './socketGroups';
import { LOCAL_STATE_VERSION } from './storage';
import { DEFAULT_METADATA_BATCH_POLICY, metadataBatchDelayMs } from './protocolContract';
import { verifyWebSocketProtocol } from './protocolCompatibility';
import { resolveWebSocketUrls } from './transportDiscovery';

const WS_URL = appConfig.wsUrl;
const DIRECT_RETRY_BASE_DELAY_MS = 3_000;
const DIRECT_RETRY_MAX_DELAY_MS = 30_000;
const SOCKET_FAST_RECONNECT_ATTEMPTS = 5;
const SOCKET_IDLE_RECONNECT_DELAY_MS = 60_000;
const SESSION_RESET_COOLDOWN_MS = 15_000;
const DIRECT_CRYPTO_STATE_VERSION = 2;
const messageStatusRank: Record<StoredMessage['status'], number> = {
  failed: -1,
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

type RatchetPayload = RatchetMessage & {
  x3dh?: X3DHParams;
};

function parseEnvelopeX3DH(data?: string): X3DHParams | undefined {
  if (!data) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as RatchetPayload;
    return parsed.x3dh;
  } catch {
    return undefined;
  }
}

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

type SelfSyncDirectMessagePayload = {
  kind: 'direct_message';
  msgId: string;
  peerPubKey: string;
  senderPubKey: string;
  text: string;
  timestamp: number;
  status: StoredMessage['status'];
};

type SelfSyncDirectEditPayload = {
  kind: 'direct_edit';
  msgId: string;
  peerPubKey: string;
  text: string;
  editedAt: number;
};

type SelfSyncDirectDeletePayload = {
  kind: 'direct_delete';
  msgId: string;
  peerPubKey: string;
  deletedAt: number;
};

type SelfSyncDirectReactionPayload = {
  kind: 'direct_reaction';
  msgId: string;
  peerPubKey: string;
  actorPubKey: string;
  reaction: string | null;
};

type SelfSyncPayload =
  | SelfSyncDirectMessagePayload
  | SelfSyncDirectEditPayload
  | SelfSyncDirectDeletePayload
  | SelfSyncDirectReactionPayload;

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

function parseSelfSyncPayload(value: string): SelfSyncPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<SelfSyncPayload>;
    if (!isNonEmptyString(parsed.kind) || !isNonEmptyString(parsed.msgId) || !isNonEmptyString(parsed.peerPubKey)) {
      return null;
    }
    if (parsed.kind === 'direct_message') {
      if (
        !isNonEmptyString(parsed.senderPubKey) ||
        typeof parsed.text !== 'string' ||
        typeof parsed.timestamp !== 'number' ||
        (parsed.status !== 'pending' && parsed.status !== 'sent' && parsed.status !== 'delivered' && parsed.status !== 'read')
      ) {
        return null;
      }
      return {
        kind: 'direct_message',
        msgId: parsed.msgId,
        peerPubKey: parsed.peerPubKey,
        senderPubKey: parsed.senderPubKey,
        text: parsed.text,
        timestamp: parsed.timestamp,
        status: parsed.status,
      };
    }
    if (parsed.kind === 'direct_edit') {
      if (typeof parsed.text !== 'string' || typeof parsed.editedAt !== 'number') {
        return null;
      }
      return {
        kind: 'direct_edit',
        msgId: parsed.msgId,
        peerPubKey: parsed.peerPubKey,
        text: parsed.text,
        editedAt: parsed.editedAt,
      };
    }
    if (parsed.kind === 'direct_delete') {
      if (typeof parsed.deletedAt !== 'number') {
        return null;
      }
      return {
        kind: 'direct_delete',
        msgId: parsed.msgId,
        peerPubKey: parsed.peerPubKey,
        deletedAt: parsed.deletedAt,
      };
    }
    if (parsed.kind === 'direct_reaction') {
      if (!isNonEmptyString(parsed.actorPubKey) || (parsed.reaction !== null && typeof parsed.reaction !== 'string')) {
        return null;
      }
      return {
        kind: 'direct_reaction',
        msgId: parsed.msgId,
        peerPubKey: parsed.peerPubKey,
        actorPubKey: parsed.actorPubKey,
        reaction: parsed.reaction ?? null,
      };
    }
    return null;
  } catch {
    return null;
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
  private syncingDirectHistory = new Set<string>();
  private directHistoryCursorByPeer = new Map<string, number>();
  private outboxFlushTimer: ReturnType<typeof setInterval> | null = null;
  private directBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private transportUrls: string[] = appConfig.wsUrls;
  private transportDiscoveryInFlight: Promise<void> | null = null;
  private compatibleTransportUrls = new Set<string>();
  private protocolChecks = new Map<string, Promise<void>>();
  private lastProtocolCompatibilityMessage = '';
  private activeWsUrl = appConfig.wsUrl;
  private lastRateLimitedToastAt = 0;
  private lastSessionResetNoticeAt = new Map<string, number>();
  private api = new SocketApiClient(() => this.sessionToken);

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
      this.clearDirectBatchTimers();
      return;
    }
    clearInterval(this.outboxFlushTimer);
    this.outboxFlushTimer = null;
    this.clearDirectBatchTimers();
  }

  private clearDirectBatchTimers() {
    for (const timer of this.directBatchTimers.values()) {
      clearTimeout(timer);
    }
    this.directBatchTimers.clear();
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
    console.warn(`WebSocket is unavailable at ${this.activeWsUrl}. Check that the backend is running on the configured host and port.`, error);
  }

  private refreshTransportDiscovery() {
    if (this.transportDiscoveryInFlight) {
      return;
    }
    this.transportDiscoveryInFlight = resolveWebSocketUrls()
      .then((urls) => {
        if (urls.length > 0) {
          this.transportUrls = urls;
        }
      })
      .finally(() => {
        this.transportDiscoveryInFlight = null;
      });
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

    this.refreshTransportDiscovery();
    const wsBaseUrl = this.transportUrls[this.reconnectAttempts % this.transportUrls.length] ?? WS_URL;
    if (!this.compatibleTransportUrls.has(wsBaseUrl)) {
      if (!this.protocolChecks.has(wsBaseUrl)) {
        const check = verifyWebSocketProtocol(wsBaseUrl, LOCAL_STATE_VERSION)
          .then((result) => {
            if (!result.compatible) {
              useAppStore.getState().setConnectionStatus('offline');
              if (result.message !== this.lastProtocolCompatibilityMessage) {
                this.lastProtocolCompatibilityMessage = result.message;
                toast.error(result.message);
              }
              if (!this.manualDisconnect && !this.reconnectTimer) {
                const delay = this.getReconnectDelay();
                this.reconnectAttempts += 1;
                this.reconnectTimer = setTimeout(() => {
                  this.reconnectTimer = null;
                  this.connect(pubKey);
                }, delay);
              }
              return;
            }
            this.compatibleTransportUrls.add(wsBaseUrl);
            this.lastProtocolCompatibilityMessage = '';
            if (!this.manualDisconnect) {
              this.connect(pubKey);
            }
          })
          .finally(() => {
            this.protocolChecks.delete(wsBaseUrl);
          });
        this.protocolChecks.set(wsBaseUrl, check);
      }
      return;
    }
    this.activeWsUrl = wsBaseUrl;
    const url = `${wsBaseUrl}?pub=${encodeURIComponent(pubKey)}&state=${encodeURIComponent(LOCAL_STATE_VERSION)}`;
    if (this.reconnectAttempts === 0) {
      console.info('Connecting to WS:', url);
    }
    
    this.ws = new WebSocket(url);
    this.authenticated = false;

    this.ws.onopen = () => {
      console.log('WebSocket connection opened. Awaiting auth challenge...');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
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
          await this.migrateLegacyDirectCryptoState(pubKey);
          this.releaseAuthWaiters();
          this.startOutboxLoop();
          // Upload prekeys if we don't have enough
          void this.ensurePreKeys(pubKey);
          void this.refreshOwnProfile(pubKey);
          void this.syncMyProfile();
          void this.refreshKnownProfiles();
          void reconcileDirectContactsFromMessages().catch((error) => {
            console.warn('Failed to reconcile direct chats from local history', error);
          });
          void this.syncKnownDirectHistory(pubKey);
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
          if (shouldHandleServerAck(env.ack_type)) {
            await this.handleServerAck(env.msg_id);
          }
          return;
        }
        if (env.type === 'rate_limited') {
          const now = Date.now();
          if (now - this.lastRateLimitedToastAt > 2500) {
            this.lastRateLimitedToastAt = now;
            const retry = typeof env.retry_after_sec === 'number' && env.retry_after_sec > 0
              ? ` Retry in ${Math.ceil(env.retry_after_sec)}s.`
              : '';
            toast.error(`${env.message || 'Too many actions. Please slow down.'}${retry}`);
          }
          return;
        }
        if (env.type === 'dummy') {
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

        if (env.type === 'session_repair') {
          if (!env.sender_pub_key || env.recipient_pub_key !== pubKey || !env.data) {
            return;
          }

          await db.sessions.delete(env.sender_pub_key);
          const plaintext = await this.decryptInSession(env.sender_pub_key, env.data, parseEnvelopeX3DH(env.data));
          if (plaintext) {
            this.acknowledgeOfflineEnvelope(env);
            void this.flushOutgoingDirectMessages();
          } else {
            await db.sessions.delete(env.sender_pub_key);
            this.sendSessionResetNotice(env.sender_pub_key, pubKey);
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }

        if (env.type === 'session_reset') {
          if (!env.sender_pub_key || env.recipient_pub_key !== pubKey) {
            return;
          }
          await this.handlePeerSessionReset(env.sender_pub_key);
          this.acknowledgeOfflineEnvelope(env);
          return;
        }

        // 3. Message interactions
        if (env.type === 'edit') {
           const targetMsgId = env.target_msg_id || env.msg_id;
           if (!env.sender_pub_key || !env.data || !env.msg_id || !targetMsgId) return;
           const plaintext = await this.decryptInSession(env.sender_pub_key, env.data);
           if (plaintext) {
               await markMessageEdited(targetMsgId, plaintext, env.sender_pub_key);
               this.acknowledgeOfflineEnvelope(env);
           } else {
             if (env.sender_pub_key !== pubKey) {
               await db.sessions.delete(env.sender_pub_key);
               this.sendSessionResetNotice(env.sender_pub_key, pubKey);
             }
             this.acknowledgeOfflineEnvelope(env);
           }
           return;
        }

        if (env.type === 'delete') {
            const targetMsgId = env.target_msg_id || env.msg_id;
            if (!env.msg_id || !targetMsgId) return;
            await markMessageDeleted(targetMsgId, env.sender_pub_key);
            this.acknowledgeOfflineEnvelope(env);
            return;
        }

        if (env.type === 'reaction') {
            const targetMsgId = env.target_msg_id || env.msg_id;
            if (!env.msg_id || !targetMsgId || !env.sender_pub_key) return;
            await applyMessageReaction(targetMsgId, env.sender_pub_key, env.reaction ?? null);
            this.acknowledgeOfflineEnvelope(env);
            return;
        }
        if (env.type === 'pin' || env.type === 'unpin') {
          await this.handleDirectPinEnvelope(env, pubKey);
          this.acknowledgeOfflineEnvelope(env);
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
          this.acknowledgeOfflineEnvelope(env);

          try {
            const group = await refreshGroupAvailability(payload.groupId);
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
          this.acknowledgeOfflineEnvelope(env);
          await this.flushPendingGroupEvents(payload.groupId, env.sender_pub_key);
          return;
        }
        if (env.type === 'group_message') {
          if (await this.handleIncomingGroupMessage(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'group_edit') {
          if (await this.handleIncomingGroupEdit(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
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
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'group_reaction') {
          if (await this.handleIncomingGroupReaction(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'channel_message') {
          if (await this.handleIncomingChannelMessage(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'channel_edit') {
          if (await this.handleIncomingChannelEdit(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'channel_delete') {
          if (await this.handleIncomingChannelDelete(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'channel_reaction') {
          if (await this.handleIncomingChannelReaction(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'channel_pin') {
          if (await this.handleIncomingChannelPin(env)) {
            this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }
        if (env.type === 'self_sync') {
          if (!env.data || env.sender_pub_key !== pubKey) return;

          const plaintext = decryptMessage(env.data, mySecretKey, pubKey);
          if (!plaintext) {
            return;
          }

          const payload = parseSelfSyncPayload(plaintext);
          if (!payload) {
            return;
          }

          const existingMsg = await db.messages.where('msgId').equals(payload.msgId).first();
          if (payload.kind === 'direct_message') {
            if (existingMsg?.id) {
              if (messageStatusRank[payload.status] > messageStatusRank[existingMsg.status]) {
                await updateMessageAndSync(existingMsg.id, { status: payload.status });
              }
              this.acknowledgeOfflineEnvelope(env);
              return;
            }

            await addMessageAndSync({
              msgId: payload.msgId,
              peerPublicKey: payload.peerPubKey,
              senderPublicKey: payload.senderPubKey,
              text: payload.text,
              timestamp: payload.timestamp,
              status: payload.status,
              reactions: {}
            });

            await this.upsertDirectContact(payload.peerPubKey, payload.timestamp, { unarchive: true });
            void this.refreshContactProfile(payload.peerPubKey);
            this.acknowledgeOfflineEnvelope(env);
            return;
          }

          if (!existingMsg?.id) {
            return;
          }

          if (payload.kind === 'direct_edit') {
            await updateMessageAndSync(existingMsg.id, {
              text: payload.text,
              editedAt: payload.editedAt,
              deletedAt: undefined,
            });
            this.acknowledgeOfflineEnvelope(env);
            return;
          }

          if (payload.kind === 'direct_delete') {
            await updateMessageAndSync(existingMsg.id, {
              text: '[Message deleted]',
              deletedAt: payload.deletedAt,
              editedAt: undefined,
              reactions: {},
            });
            this.acknowledgeOfflineEnvelope(env);
            return;
          }

          if (payload.kind === 'direct_reaction') {
            const nextReactions = { ...(existingMsg.reactions ?? {}) };
            if (payload.reaction) {
              nextReactions[payload.actorPubKey] = payload.reaction;
            } else {
              delete nextReactions[payload.actorPubKey];
            }
            await updateMessageAndSync(existingMsg.id, { reactions: nextReactions });
            this.acknowledgeOfflineEnvelope(env);
            return;
          }
          return;
        }
        if (env.type === 'message' || env.type === 'offline_message') {
          const myPubKey = pubKey.trim();
          const senderPubKey = env.sender_pub_key?.trim();
          const recipientPubKey = env.recipient_pub_key?.trim();
          const msgId = env.msg_id || crypto.randomUUID(); // Fallback if old format
          
          if (!senderPubKey || !recipientPubKey) {
              console.warn("Received message without sender or recipient. Ignoring.", env);
              return;
          }

          const isForMe = recipientPubKey === myPubKey;
          const isFromMe = senderPubKey === myPubKey;

          if (!isForMe && !isFromMe) return;

          if (senderPubKey === recipientPubKey) {
            console.warn("Ignoring self-addressed direct message:", msgId);
            const existingMsg = await db.messages.where('msgId').equals(msgId).first();
            if (existingMsg?.id && existingMsg.status !== 'delivered' && existingMsg.status !== 'read') {
              await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
            }
            this.acknowledgeOfflineEnvelope(env);
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
            this.acknowledgeOfflineEnvelope(env);
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
            this.acknowledgeOfflineEnvelope(env);
            return;
          }

          const x3dh = parseEnvelopeX3DH(env.data);

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
                await this.upsertDirectContact(peerPubKey, Date.now(), { unarchive: true });
                void this.refreshContactProfile(peerPubKey);
                if (senderPubKey !== pubKey) {
                  this.sendSelfSyncDirectMessage({
                    kind: 'direct_message',
                    msgId,
                    peerPubKey,
                    senderPubKey,
                    text: plaintext,
                    timestamp: Date.now(),
                    status: 'delivered',
                  });
                }

            // Send delivery receipt back
            if (this.authenticated && senderPubKey !== pubKey) {
              this.ws?.send(JSON.stringify({
                type: 'delivery_receipt',
                recipient_pub_key: senderPubKey,
                sender_pub_key: pubKey,
                msg_id: msgId
              }));
            }
            this.acknowledgeOfflineEnvelope(env);
          } else {
             console.error("Failed to decrypt message from", senderPubKey);
             if (senderPubKey !== pubKey) {
               await db.sessions.delete(peerPubKey);
               this.sendSessionResetNotice(senderPubKey, pubKey);
             }
             this.acknowledgeOfflineEnvelope(env);
          }
          return;
        }

        // 3. Delivery receipts
        if (env.type === 'delivery_receipt' && env.recipient_pub_key === pubKey) {
          if (!env.msg_id) return;
          await updateMessageByMsgID(env.msg_id, { status: 'delivered' });
          return;
        }

        if (env.type === 'read_receipt' && env.recipient_pub_key === pubKey) {
          if (!env.msg_id) return;
          await updateMessageByMsgID(env.msg_id, { status: 'read' });
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  async recoverTransport(timeoutMs = 5000) {
    const { myPublicKey } = useAppStore.getState();
    if (!myPublicKey) {
      return false;
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      this.connect(myPublicKey);
    }

    const ready = await this.ensureRealtimeReady(timeoutMs);
    if (!ready) {
      return false;
    }

    void this.flushOutgoingDirectMessages();
    void this.flushOutgoingGroupEvents();
    return true;
  }

  getSessionHeaders(): HeadersInit {
    return this.api.getSessionHeaders();
  }

  async listSessions() {
    return this.api.listSessions() as Promise<SessionListResponse>;
  }

  async revokeSession(token: string) {
    await this.api.revokeSession(token);
  }

  async revokeOtherSessions() {
    return this.api.revokeOtherSessions();
  }

  async syncMyProfile() {
    await this.api.syncMyProfile();
  }

  async refreshOwnProfile(pubKey?: string, force = false) {
    await this.api.refreshOwnProfile(pubKey, force);
  }

  async refreshContactProfile(pubKey: string, force = false) {
    return this.api.refreshContactProfile(pubKey, force);
  }

  async resolveUsername(username: string): Promise<ResolvedUserProfile | null> {
    await this.ensureRealtimeReady();
    return this.api.resolveUsername(username);
  }

  async refreshKnownProfiles(force = false) {
    await this.api.refreshKnownProfiles(force);
  }

  async syncDirectHistory(peerPubKey: string) {
    const peer = peerPubKey.trim();
    const { myPublicKey } = useAppStore.getState();
    if (!peer || !myPublicKey || peer === myPublicKey) {
      return;
    }

    if (this.syncingDirectHistory.has(peer)) {
      return;
    }

    const ready = await this.ensureRealtimeReady(5000);
    if (!ready) {
      return;
    }

    this.syncingDirectHistory.add(peer);
    try {
      const localMessageCount = await db.messages.where('peerPublicKey').equals(peer).count();
      let cursor = localMessageCount === 0 ? 0 : this.getDirectHistoryCursor(myPublicKey, peer);
      let pages = 0;

      while (pages < 5) {
        pages += 1;
        const response = await this.api.fetchDirectHistory(peer, cursor, 100);
        let pageCompleted = true;
        for (const record of response.messages) {
          const applied = await this.applyDirectHistoryRecord(record, myPublicKey);
          if (!applied) {
            pageCompleted = false;
            break;
          }
        }

        if (!pageCompleted) {
          break;
        }
        if (response.nextCursor <= cursor) {
          break;
        }
        cursor = response.nextCursor;
        this.setDirectHistoryCursor(myPublicKey, peer, cursor);

        if (response.messages.length < response.limit) {
          break;
        }
      }
    } catch (error) {
      console.warn(`Failed to sync direct history for ${peer.substring(0, 10)}...`, error);
    } finally {
      this.syncingDirectHistory.delete(peer);
    }
  }

  private getDirectHistoryCursor(myPublicKey: string, peerPubKey: string) {
    const cached = this.directHistoryCursorByPeer.get(peerPubKey);
    if (cached !== undefined) {
      return cached;
    }
    const key = this.directHistoryCursorKey(myPublicKey, peerPubKey);
    const stored = Number.parseInt(localStorage.getItem(key) || '0', 10);
    const cursor = Number.isFinite(stored) && stored > 0 ? stored : 0;
    this.directHistoryCursorByPeer.set(peerPubKey, cursor);
    return cursor;
  }

  private setDirectHistoryCursor(myPublicKey: string, peerPubKey: string, cursor: number) {
    const safeCursor = Math.max(0, cursor);
    this.directHistoryCursorByPeer.set(peerPubKey, safeCursor);
    localStorage.setItem(this.directHistoryCursorKey(myPublicKey, peerPubKey), String(safeCursor));
  }

  private directHistoryCursorKey(myPublicKey: string, peerPubKey: string) {
    return `messk:direct-history-cursor:${encodeURIComponent(myPublicKey)}:${encodeURIComponent(peerPubKey)}`;
  }

  private async syncKnownDirectHistory(myPublicKey: string) {
    try {
      const contacts = await db.contacts.orderBy('lastMessageAt').reverse().limit(20).toArray();
      for (const contact of contacts) {
        if (contact.pubKey && contact.pubKey !== myPublicKey) {
          void this.syncDirectHistory(contact.pubKey);
        }
      }
    } catch (error) {
      console.warn('Failed to schedule direct history sync', error);
    }
  }

  private normalizeHistoryEnvelope(record: DirectHistoryRecord): IncomingEnvelope | null {
    const payload = record.ciphertextPayload;
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload) as IncomingEnvelope;
      } catch {
        return null;
      }
    }
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return {
      ...payload,
      type: payload.type || record.envelopeType,
      msg_id: payload.msg_id || record.msgId,
      sender_pub_key: payload.sender_pub_key || record.senderPubKey,
      recipient_pub_key: payload.recipient_pub_key || record.recipientPubKey,
    };
  }

  private historyStatusFor(record: DirectHistoryRecord, isFromMe: boolean): StoredMessage['status'] {
    if (!isFromMe) {
      return 'delivered';
    }
    if (record.deliveryState === 'read') {
      return 'read';
    }
    if (record.deliveryState === 'delivered') {
      return 'delivered';
    }
    return 'sent';
  }

  private async applyDirectHistoryRecord(record: DirectHistoryRecord, myPublicKey: string): Promise<boolean> {
    const env = this.normalizeHistoryEnvelope(record);
    if (!env) {
      return true;
    }

    const senderPubKey = env.sender_pub_key?.trim();
    const recipientPubKey = env.recipient_pub_key?.trim();
    const msgId = env.msg_id || record.msgId;
    if (!senderPubKey || !recipientPubKey || !msgId) {
      return true;
    }

    const isForMe = recipientPubKey === myPublicKey;
    const isFromMe = senderPubKey === myPublicKey;
    if (!isForMe && !isFromMe) {
      return true;
    }
    if (senderPubKey === recipientPubKey) {
      return true;
    }

    const peerPubKey = isFromMe ? recipientPubKey : senderPubKey;
    if (env.type === 'edit') {
      return this.applyDirectHistoryEdit(env, peerPubKey, isFromMe);
    }
    if (env.type === 'delete') {
      await this.applyDirectHistoryDelete(env, senderPubKey);
      return true;
    }
    if (env.type === 'reaction') {
      await this.applyDirectHistoryReaction(env, senderPubKey);
      return true;
    }
    if (env.type === 'pin' || env.type === 'unpin') {
      await this.handleDirectPinEnvelope(env, myPublicKey);
      return true;
    }
    if (env.type !== 'message' && env.type !== 'offline_message') {
      return true;
    }

    const status = this.historyStatusFor(record, isFromMe);
    const existingMsg = await db.messages.where('msgId').equals(msgId).first();
    if (existingMsg?.id) {
      if (messageStatusRank[status] > messageStatusRank[existingMsg.status]) {
        await updateMessageAndSync(existingMsg.id, { status });
      }
      return true;
    }

    if (isFromMe || !env.data) {
      return true;
    }

    const plaintext = await this.decryptInSession(peerPubKey, env.data, parseEnvelopeX3DH(env.data));
    if (!plaintext) {
      console.warn(`History message ${msgId} from ${senderPubKey.substring(0, 10)}... could not be decrypted yet.`);
      return false;
    }

    const serverTimestamp = Date.parse(record.serverReceivedAt);
    const timestamp = Number.isFinite(serverTimestamp) ? serverTimestamp : Date.now();
    await addMessageAndSync({
      msgId,
      peerPublicKey: peerPubKey,
      senderPublicKey: senderPubKey,
      text: plaintext,
      timestamp,
      status,
      reactions: {}
    });
    await this.upsertDirectContact(peerPubKey, timestamp, { unarchive: true });
    void this.refreshContactProfile(peerPubKey);

    if (this.canSendImmediately()) {
      try {
        this.sendEnvelope({
          type: 'delivery_receipt',
          recipient_pub_key: senderPubKey,
          sender_pub_key: myPublicKey,
          msg_id: msgId,
        });
      } catch (error) {
        console.warn('Failed to send delivery receipt for recovered history message', error);
      }
    }
    return true;
  }

  private async applyDirectHistoryEdit(env: IncomingEnvelope, peerPubKey: string, isFromMe: boolean) {
    const targetMsgId = env.target_msg_id || env.msg_id;
    if (!targetMsgId || !env.data) {
      return true;
    }
    if (isFromMe) {
      return true;
    }

    const existingMsg = await db.messages.where('msgId').equals(targetMsgId).first();
    if (!existingMsg?.id || existingMsg.editedAt) {
      return true;
    }

    const plaintext = await this.decryptInSession(peerPubKey, env.data);
    if (!plaintext) {
      console.warn(`History edit for ${targetMsgId} could not be decrypted yet.`);
      return false;
    }
    await markMessageEdited(targetMsgId, plaintext, env.sender_pub_key);
    return true;
  }

  private async applyDirectHistoryDelete(env: IncomingEnvelope, actorPubKey: string) {
    const targetMsgId = env.target_msg_id || env.msg_id;
    if (!targetMsgId) {
      return;
    }
    await markMessageDeleted(targetMsgId, actorPubKey);
  }

  private async applyDirectHistoryReaction(env: IncomingEnvelope, actorPubKey: string) {
    const targetMsgId = env.target_msg_id || env.msg_id;
    if (!targetMsgId) {
      return;
    }
    await applyMessageReaction(targetMsgId, actorPubKey, env.reaction ?? null);
  }

  private async handleDirectPinEnvelope(env: IncomingEnvelope, myPublicKey: string) {
    const senderPubKey = env.sender_pub_key?.trim();
    const recipientPubKey = env.recipient_pub_key?.trim();
    if (!senderPubKey || !recipientPubKey) {
      return;
    }
    const peerPubKey = senderPubKey === myPublicKey ? recipientPubKey : senderPubKey;
    if (!peerPubKey || peerPubKey === myPublicKey) {
      return;
    }
    const targetMsgId = env.target_msg_id || (env.type === 'pin' ? env.msg_id : null);
    const existingContact = await db.contacts.get(peerPubKey);
    if (!existingContact) {
      return;
    }
    await db.contacts.update(peerPubKey, {
      pinnedMsgId: env.type === 'pin' ? targetMsgId || null : null,
    });
  }

  private async encryptWithSenderKey(senderKeyBase64: string, plaintext: string): Promise<string> {
    const nonce = randomBytes(secretbox.nonceLength);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    let senderKey: Uint8Array | null = null;
    try {
      senderKey = decodeBase64(senderKeyBase64);
      const ciphertext = secretbox(plaintextBytes, nonce, senderKey);
      const packed = new Uint8Array(nonce.length + ciphertext.length);
      packed.set(nonce);
      packed.set(ciphertext, nonce.length);
      return JSON.stringify({
        v: 1,
        mode: 'sender_key_v1',
        ciphertext: encodeBase64(packed),
      } satisfies GroupCipherEnvelope);
    } finally {
      plaintextBytes.fill(0);
      senderKey?.fill(0);
    }
  }

  private async decryptWithSenderKey(senderKeyBase64: string, data: string): Promise<string | null> {
    let senderKey: Uint8Array | null = null;
    let plaintext: Uint8Array | null = null;
    try {
      const envelope = JSON.parse(data) as Partial<GroupCipherEnvelope>;
      if (envelope.mode !== 'sender_key_v1' || envelope.v !== 1 || !envelope.ciphertext) {
        return data;
      }

      const packed = decodeBase64(envelope.ciphertext);
      const nonce = packed.slice(0, secretbox.nonceLength);
      const ciphertext = packed.slice(secretbox.nonceLength);
      senderKey = decodeBase64(senderKeyBase64);
      plaintext = secretbox.open(ciphertext, nonce, senderKey);
      if (!plaintext) {
        return null;
      }
      return new TextDecoder().decode(plaintext);
    } catch {
      return data;
    } finally {
      senderKey?.fill(0);
      plaintext?.fill(0);
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

      let ratchetKP: ReturnType<typeof box.keyPair> | null = null;
      try {
        ratchetKP = box.keyPair();
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
      } finally {
        sharedSecret.fill(0);
        ratchetKP?.secretKey.fill(0);
      }
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
    return ensureGroupSenderKey({
      groupId,
      myPublicKey,
      mySecretKey,
      reportGroupIssue,
      sendEnvelope: (payload) => this.sendEnvelope(payload),
    });
  }

  private async waitForGroupSenderKey(groupId: string, senderPubKey: string, reportTimeout = true) {
    return waitForGroupSenderKey({
      groupId,
      senderPubKey,
      reportTimeout,
      reportGroupIssue,
      ensureGroupThreadAvailable: (targetGroupID) => this.ensureGroupThreadAvailable(targetGroupID),
    });
  }

  private async ensureGroupThreadAvailable(groupId: string) {
    return ensureGroupThreadAvailable(groupId);
  }

  private enqueuePendingGroupEvent(env: IncomingEnvelope) {
    enqueuePendingGroupEvent(this.pendingGroupEvents, env);
  }

  private async flushPendingGroupEvents(groupId: string, senderPubKey: string) {
    const pending = takePendingGroupEvents(this.pendingGroupEvents, groupId, senderPubKey);
    if (!pending.length) {
      return;
    }
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

  private async handleIncomingGroupMessage(env: IncomingEnvelope): Promise<boolean> {
    if (!env.group_id || !env.sender_pub_key || !env.data || !env.msg_id) return false;
    await this.ensureGroupThreadAvailable(env.group_id);

    const existingMsg = await db.messages.where('msgId').equals(env.msg_id).first();
    if (existingMsg) {
      if (existingMsg.id && env.sender_pub_key === useAppStore.getState().myPublicKey && existingMsg.status !== 'delivered') {
        await updateMessageAndSync(existingMsg.id, { status: 'delivered' });
      }
      return true;
    }

    let plaintext = env.data;
    if (parseGroupCipherEnvelope(env.data)) {
      const senderKey = await this.waitForGroupSenderKey(env.group_id, env.sender_pub_key, false);
      if (!senderKey) {
        this.enqueuePendingGroupEvent(env);
        return false;
      }

      const decrypted = await this.decryptWithSenderKey(senderKey.key, env.data);
      if (!decrypted) {
        reportGroupIssue('group-message-decrypt', 'Failed to decrypt a group message.');
        return false;
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
    return true;
  }

  private async enqueueOutgoingGroupEvent(event: OutgoingGroupEvent) {
    await enqueueOutgoingGroupEvent(event);
  }

  private canSendImmediately() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  private sendEnvelope(payload: Record<string, unknown>) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Secure channel is not ready yet');
    }
    sendJsonEnvelope((message) => ws.send(JSON.stringify(message)), payload);
  }

  private acknowledgeOfflineEnvelope(env: IncomingEnvelope) {
    if (!env.msg_id || !this.canSendImmediately()) {
      return;
    }

    try {
      this.sendEnvelope({
        type: 'offline_ack',
        msg_id: env.msg_id,
      });
    } catch (error) {
      console.warn('Failed to acknowledge offline envelope', error);
    }
  }

  private sendSelfSyncDirectMessage(payload: SelfSyncPayload) {
    const { myPublicKey, mySecretKey } = useAppStore.getState();
    if (!this.canSendImmediately() || !myPublicKey || !mySecretKey) {
      return;
    }

    try {
      const encryptedPayload = encryptMessage(JSON.stringify(payload), mySecretKey, myPublicKey);
      sendSelfSyncPayload((message) => this.sendEnvelope(message), {
        msgId: payload.msgId,
        data: encryptedPayload,
        myPublicKey,
      });
    } catch (error) {
      console.warn('Failed to send self-sync payload', error);
    }
  }

  private async upsertDirectContact(peerPubKey: string, timestamp: number, options?: { unarchive?: boolean }) {
    const existingContact = await db.contacts.get(peerPubKey);
    await db.contacts.put({
      pubKey: peerPubKey,
      name: existingContact?.name || `${peerPubKey.substring(0, 8)}...`,
      avatar: existingContact?.avatar,
      username: existingContact?.username,
      lastMessageAt: Math.max(existingContact?.lastMessageAt ?? 0, timestamp),
      pinned: existingContact?.pinned,
      draft: existingContact?.draft,
      archived: options?.unarchive ? false : existingContact?.archived,
      mutedUntil: existingContact?.mutedUntil,
      verifiedIdentityFingerprint: existingContact?.verifiedIdentityFingerprint,
      verifiedIdentityAt: existingContact?.verifiedIdentityAt,
      pinnedMsgId: existingContact?.pinnedMsgId,
    });
  }

  private sendSessionResetNotice(peerPubKey: string, myPublicKey: string) {
    if (!this.canSendImmediately()) {
      return;
    }

    const lastSentAt = this.lastSessionResetNoticeAt.get(peerPubKey) ?? 0;
    const now = Date.now();
    if (now - lastSentAt < SESSION_RESET_COOLDOWN_MS) {
      return;
    }
    this.lastSessionResetNoticeAt.set(peerPubKey, now);

    try {
      this.sendEnvelope({
        type: 'session_reset',
        msg_id: crypto.randomUUID(),
        recipient_pub_key: peerPubKey,
        sender_pub_key: myPublicKey,
      });
    } catch (error) {
      console.warn('Failed to send session reset notice', error);
    }
  }

  private async handlePeerSessionReset(peerPubKey: string) {
    const { myPublicKey, mySecretKey } = useAppStore.getState();
    if (!myPublicKey || !mySecretKey) {
      return;
    }

    await db.sessions.delete(peerPubKey);
    await db.outgoingDirectMessages
      .where('recipientPubKey')
      .equals(peerPubKey)
      .filter((message) => message.senderPubKey === myPublicKey)
      .delete();
    await this.sendSessionRepairEnvelope(peerPubKey, mySecretKey, myPublicKey);

    const resendCandidates = await db.messages
      .where('peerPublicKey')
      .equals(peerPubKey)
      .filter((message) => {
        if (message.senderPublicKey !== myPublicKey) {
          return false;
        }
        return message.status === 'pending' || message.status === 'failed';
      })
      .toArray();

    for (const message of resendCandidates) {
      const encryptedPayload = await this.encryptInSession(peerPubKey, message.text, mySecretKey, myPublicKey);
      await this.enqueueOutgoingDirectMessage({
        id: message.msgId,
        recipientPubKey: peerPubKey,
        senderPubKey: myPublicKey,
        data: encryptedPayload,
        createdAt: message.timestamp,
        attempts: 0,
      });
      if (message.id) {
        await updateMessageAndSync(message.id, { status: 'pending' });
      }
    }

    toast('Secure session refreshed. Retrying undelivered messages.', { icon: '↻' });
    if (this.canSendImmediately()) {
      await this.flushOutgoingDirectMessages();
    }
  }

  private async enqueueOutgoingDirectMessage(message: OutgoingDirectMessage) {
    await enqueueOutgoingDirectMessage(message);
  }

  private scheduleDirectBatchFlush(message: OutgoingDirectMessage) {
    if (!this.canSendImmediately()) {
      return;
    }
    const batchKey = `${message.senderPubKey}:${message.recipientPubKey}`;
    if (this.directBatchTimers.has(batchKey)) {
      return;
    }

    const delayMs = metadataBatchDelayMs(DEFAULT_METADATA_BATCH_POLICY, batchKey, message.id);
    const timer = setTimeout(() => {
      this.directBatchTimers.delete(batchKey);
      void this.flushOutgoingDirectMessages();
    }, delayMs);
    this.directBatchTimers.set(batchKey, timer);
  }

  private sendDirectEnvelope(message: OutgoingDirectMessage) {
    sendDirectEnvelope((payload) => this.sendEnvelope(payload), message);
  }

  private async sendSessionRepairEnvelope(peerPubKey: string, mySecretKey: string, myPublicKey: string) {
    const data = await this.encryptInSession(
      peerPubKey,
      JSON.stringify({ kind: 'session_repair', createdAt: Date.now() }),
      mySecretKey,
      myPublicKey
    );

    this.sendEnvelope({
      type: 'session_repair',
      msg_id: crypto.randomUUID(),
      recipient_pub_key: peerPubKey,
      sender_pub_key: myPublicKey,
      data,
    });
  }

  private sendSelfSyncEnvelope(message: OutgoingDirectMessage) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.canSendImmediately() || !myPublicKey || !message.syncData) {
      return;
    }
    sendSelfSyncEnvelope((payload) => this.sendEnvelope(payload), message, myPublicKey);
  }

  private async markDirectAttempt(message: OutgoingDirectMessage) {
    await markDirectAttempt(message);
  }

  private async migrateLegacyDirectCryptoState(myPublicKey: string) {
    const migrationKey = `messk:direct-crypto-state:v${DIRECT_CRYPTO_STATE_VERSION}:${myPublicKey}`;
    if (localStorage.getItem(migrationKey) === 'done') {
      return;
    }

    await db.sessions.clear();
    await db.outgoingDirectMessages.clear();
    localStorage.setItem(migrationKey, 'done');
  }

  private async handleServerAck(msgId: string) {
    const queued = await db.outgoingDirectMessages.get(msgId);
    if (queued) {
      await db.outgoingDirectMessages.delete(msgId);
    }
    const queuedEvent = await db.outgoingGroupEvents.get(msgId);
    if (queuedEvent) {
      await db.outgoingGroupEvents.delete(msgId);
    }

    const msg = await db.messages.where('msgId').equals(msgId).first();
    if (msg?.id && (msg.status === 'pending' || msg.status === 'failed')) {
      await updateMessageAndSync(msg.id, { status: 'sent' });
      if (queued) {
        this.sendSelfSyncDirectMessage({
          kind: 'direct_message',
          msgId,
          peerPubKey: msg.peerPublicKey,
          senderPubKey: msg.senderPublicKey,
          text: msg.text,
          timestamp: msg.timestamp,
          status: 'sent',
        });
      }
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
          const localMessage = await db.messages.where('msgId').equals(message.id).first();
          if (localMessage?.id && localMessage.status === 'failed') {
            await updateMessageAndSync(localMessage.id, { status: 'pending' });
          }
          this.sendDirectEnvelope(message);
          this.sendSelfSyncEnvelope(message);
          await this.markDirectAttempt(message);
        } catch (error) {
          console.warn('Failed to flush queued direct message', message.id, error);
          await updateMessageByMsgID(message.id, { status: 'failed' });
          break;
        }
      }
    } finally {
      this.flushingDirectOutbox = false;
    }
  }

  async retryDirectMessage(msgId: string) {
    const queuedMessage = await db.outgoingDirectMessages.get(msgId);
    if (!queuedMessage) {
      throw new Error('This message is no longer waiting in the retry queue.');
    }

    await db.outgoingDirectMessages.update(msgId, {
      attempts: 0,
      lastAttemptAt: undefined,
    });
    await updateMessageByMsgID(msgId, { status: 'pending' });

    if (this.canSendImmediately()) {
      await this.flushOutgoingDirectMessages();
      toast.success('Retry started.');
      return;
    }

    toast('Message will retry when the secure channel is back.', { icon: '...' });
  }

  private async flushOutgoingGroupEvents() {
    if (this.flushingGroupOutbox || !this.canSendImmediately()) {
      return;
    }

    const { myPublicKey, mySecretKey } = useAppStore.getState();
    if (!myPublicKey) {
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
          if (event.type === 'group_message' && event.data && mySecretKey) {
            const senderKey = await this.ensureGroupSenderKey(event.groupId, myPublicKey, mySecretKey);
            this.ws?.send(JSON.stringify({
              type: 'group_message',
              msg_id: event.id,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: await this.encryptWithSenderKey(senderKey, event.data),
            }));
          } else if (event.type === 'group_edit' && event.data && event.targetMsgId && mySecretKey) {
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
          } else if (event.type === 'group_reaction' && event.targetMsgId && mySecretKey) {
            const senderKey = await this.ensureGroupSenderKey(event.groupId, myPublicKey, mySecretKey);
            this.ws?.send(JSON.stringify({
              type: 'group_reaction',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: await this.encryptWithSenderKey(senderKey, JSON.stringify({ reaction: event.reaction ?? null } satisfies GroupReactionPayload)),
            }));
          } else if (event.type === 'channel_message' && event.data) {
            this.ws?.send(JSON.stringify({
              type: 'channel_message',
              msg_id: event.id,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: event.data,
            }));
          } else if (event.type === 'channel_edit' && event.data && event.targetMsgId) {
            this.ws?.send(JSON.stringify({
              type: 'channel_edit',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: event.data,
            }));
          } else if (event.type === 'channel_delete' && event.targetMsgId) {
            this.ws?.send(JSON.stringify({
              type: 'channel_delete',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
            }));
          } else if (event.type === 'channel_reaction' && event.targetMsgId) {
            this.ws?.send(JSON.stringify({
              type: 'channel_reaction',
              msg_id: event.id,
              target_msg_id: event.targetMsgId,
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              reaction: event.reaction ?? '',
            }));
          } else if (event.type === 'channel_pin') {
            this.ws?.send(JSON.stringify({
              type: 'channel_pin',
              msg_id: event.id,
              target_msg_id: event.targetMsgId ?? '',
              group_id: event.groupId,
              sender_pub_key: myPublicKey,
              data: '',
            }));
          }

        } catch (error) {
          console.warn('Failed to flush queued group event', event.type, error);
          break;
        }
      }
    } finally {
      this.flushingGroupOutbox = false;
    }
  }

  private async handleIncomingGroupEdit(env: IncomingEnvelope): Promise<boolean> {
    if (!env.group_id || !env.sender_pub_key || !env.target_msg_id || !env.data) return false;
    await this.ensureGroupThreadAvailable(env.group_id);

    const senderKey = await this.waitForGroupSenderKey(env.group_id, env.sender_pub_key, false);
    if (!senderKey) {
      this.enqueuePendingGroupEvent(env);
      return false;
    }

    const plaintext = await this.decryptWithSenderKey(senderKey.key, env.data);
    if (!plaintext) {
      reportGroupIssue('group-edit-decrypt', 'Failed to decrypt a group edit.');
      return false;
    }

    const payload = parseGroupEditPayload(plaintext);
    if (!payload) {
      reportGroupIssue('group-edit-payload', 'Received an invalid group edit payload.');
      return false;
    }

    const msg = await db.messages.where('msgId').equals(env.target_msg_id).first();
    if (msg?.id && msg.peerPublicKey === env.group_id) {
      await updateMessageAndSync(msg.id, {
        text: payload.text,
        editedAt: Date.now(),
        deletedAt: undefined,
      });
      return true;
    }
    return false;
  }

  private async handleIncomingGroupReaction(env: IncomingEnvelope): Promise<boolean> {
    if (!env.group_id || !env.sender_pub_key || !env.target_msg_id || !env.data) return false;
    await this.ensureGroupThreadAvailable(env.group_id);

    const senderKey = await this.waitForGroupSenderKey(env.group_id, env.sender_pub_key, false);
    if (!senderKey) {
      this.enqueuePendingGroupEvent(env);
      return false;
    }

    const plaintext = await this.decryptWithSenderKey(senderKey.key, env.data);
    if (!plaintext) {
      reportGroupIssue('group-reaction-decrypt', 'Failed to decrypt a group reaction.');
      return false;
    }

    const payload = parseGroupReactionPayload(plaintext);
    if (!payload) {
      reportGroupIssue('group-reaction-payload', 'Received an invalid group reaction payload.');
      return false;
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
      return true;
    }
    return false;
  }

  private async handleIncomingChannelMessage(env: IncomingEnvelope): Promise<boolean> {
    return handleIncomingChannelMessageEvent(env);
  }

  private async handleIncomingChannelEdit(env: IncomingEnvelope): Promise<boolean> {
    return handleIncomingChannelEditEvent(env);
  }

  private async handleIncomingChannelDelete(env: IncomingEnvelope): Promise<boolean> {
    return handleIncomingChannelDeleteEvent(env);
  }

  private async handleIncomingChannelReaction(env: IncomingEnvelope): Promise<boolean> {
    return handleIncomingChannelReactionEvent(env);
  }

  private async handleIncomingChannelPin(env: IncomingEnvelope): Promise<boolean> {
    return handleIncomingChannelPinEvent(env);
  }


  private async ensurePreKeys(pubKey: string) {
    const count = await db.prekeys.count();
    if (count < 50) {
      const newKeys = [];
      const pubKeysForUpload = [];
      for (let i = 0; i < 100 - count; i++) {
        const kp = box.keyPair();
        let pkBase64: string;
        let skBase64: string;
        try {
          pkBase64 = encodeBase64(kp.publicKey);
          skBase64 = encodeBase64(kp.secretKey);
        } finally {
          kp.secretKey.fill(0);
        }
        newKeys.push({ publicKey: pkBase64, secretKey: skBase64 });
        pubKeysForUpload.push(pkBase64);
      }
      
      // Save prekeys to DB (clone to avoid in-place mutation)
      await db.prekeys.bulkAdd(newKeys.map(pk => ({ ...pk })));
      this.ws?.send(JSON.stringify({
        type: 'upload_prekeys',
        sender_pub_key: pubKey,
        prekeys: pubKeysForUpload
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

    const decryptAndPersist = async (session: Session, consumedPreKeyId?: number) => {
      const plaintext = await RatchetManager.decrypt(session, ratchetData);
      if (!plaintext) {
        return null;
      }

      await db.sessions.put({ ...session });
      if (consumedPreKeyId !== undefined) {
        await db.prekeys.delete(consumedPreKeyId);
      }
      return plaintext;
    };

    const createX3DHSession = async (): Promise<{ session: Session; consumedPreKeyId?: number } | null> => {
      if (!x3dh?.ephemeralPub) {
        return null;
      }

      const { ephemeralPub, preKeyPubUsed } = x3dh;
      let myPreKeyPriv: string | null = null;
      let consumedPreKeyId: number | undefined;

      if (preKeyPubUsed) {
        const storedPreKey = await db.prekeys.where('publicKey').equals(preKeyPubUsed).first();
        if (storedPreKey) {
          myPreKeyPriv = storedPreKey.secretKey;
          consumedPreKeyId = storedPreKey.id;
        }
      }

      // Create session regardless of whether a prekey was used.
      // x3dhRespond handles null prekey by zeroing the DH components,
      // matching x3dhInitiate's fallback path.
      const sharedSecret = await x3dhRespond(mySecretKey, myPreKeyPriv, null, peerPubKey, ephemeralPub, x3dh.pqcCiphertext ?? null);
      let ratchetKP: ReturnType<typeof box.keyPair> | null = null;
      try {
        ratchetKP = box.keyPair();
        return {
          consumedPreKeyId,
          session: {
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
          }
        };
      } finally {
        sharedSecret.fill(0);
        ratchetKP?.secretKey.fill(0);
      }
    };

    const existingSession = await db.sessions.get(peerPubKey);
    if (existingSession) {
      const plaintext = await decryptAndPersist(existingSession);
      if (plaintext || !x3dh) {
        return plaintext;
      }

      await db.sessions.delete(peerPubKey);
    }

    const fresh = await createX3DHSession();
    if (!fresh) {
      return null;
    }
    return decryptAndPersist(fresh.session, fresh.consumedPreKeyId);
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
    const createdAt = Date.now();
    const queuedMessage: OutgoingDirectMessage = {
      id: msgId,
      recipientPubKey,
      senderPubKey: myPublicKey,
      data: await this.encryptInSession(recipientPubKey, plaintext, mySecretKey, myPublicKey),
      syncData: encryptMessage(JSON.stringify({
        kind: 'direct_message',
        msgId,
        peerPubKey: recipientPubKey,
        senderPubKey: myPublicKey,
        text: plaintext,
        timestamp: createdAt,
        status: 'pending',
      } satisfies SelfSyncDirectMessagePayload), mySecretKey, myPublicKey),
      createdAt,
      attempts: 0,
    };

    await addMessageAndSync({
      msgId,
      peerPublicKey: recipientPubKey,
      senderPublicKey: myPublicKey,
      text: plaintext,
      timestamp: createdAt,
      status: 'pending',
      reactions: {}
    });
    await this.upsertDirectContact(recipientPubKey, createdAt, { unarchive: true });
    void this.refreshContactProfile(recipientPubKey);
    await this.enqueueOutgoingDirectMessage(queuedMessage);

    if (this.canSendImmediately()) {
      this.scheduleDirectBatchFlush(queuedMessage);
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
      status: 'pending',
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

    await applyOptimisticGroupEdit(targetMsgId, plaintext);
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

    await applyOptimisticGroupDelete(targetMsgId);
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

    await applyOptimisticGroupReaction(targetMsgId, myPublicKey, reaction);
  }

  async sendChannelMessage(channelId: string, plaintext: string, myPublicKey: string) {
    const msgId = crypto.randomUUID();
    await addMessageAndSync({
      msgId,
      peerPublicKey: channelId,
      senderPublicKey: myPublicKey,
      text: plaintext,
      timestamp: Date.now(),
      status: 'pending',
      reactions: {}
    });
    await db.channelThreads.update(channelId, { lastActivityAt: Date.now() });

    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: msgId,
        type: 'channel_message',
        groupId: channelId,
        senderPubKey: myPublicKey,
        data: plaintext,
        createdAt: Date.now(),
      });
      toast('Channel post queued for reconnect.', { icon: '⏳' });
      return;
    }

    this.ws?.send(JSON.stringify({
      type: 'channel_message',
      msg_id: msgId,
      group_id: channelId,
      sender_pub_key: myPublicKey,
      data: plaintext,
    }));
  }

  async sendChannelEdit(channelId: string, targetMsgId: string, plaintext: string, myPublicKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'channel_edit',
        groupId: channelId,
        senderPubKey: myPublicKey,
        targetMsgId,
        data: plaintext,
        createdAt: Date.now(),
      });
      toast('Channel edit queued for reconnect.', { icon: '⏳' });
    } else {
      this.ws?.send(JSON.stringify({
        type: 'channel_edit',
        msg_id: eventId,
        target_msg_id: targetMsgId,
        group_id: channelId,
        sender_pub_key: myPublicKey,
        data: plaintext,
      }));
    }

    await applyOptimisticChannelEdit(targetMsgId, plaintext);
  }

  async sendChannelDelete(channelId: string, targetMsgId: string, myPublicKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'channel_delete',
        groupId: channelId,
        senderPubKey: myPublicKey,
        targetMsgId,
        createdAt: Date.now(),
      });
      toast('Channel delete queued for reconnect.', { icon: '⏳' });
    } else {
      this.ws?.send(JSON.stringify({
        type: 'channel_delete',
        msg_id: eventId,
        target_msg_id: targetMsgId,
        group_id: channelId,
        sender_pub_key: myPublicKey,
      }));
    }

    await applyOptimisticChannelDelete(targetMsgId);
  }

  async sendChannelReaction(channelId: string, targetMsgId: string, reaction: string | null, myPublicKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'channel_reaction',
        groupId: channelId,
        senderPubKey: myPublicKey,
        targetMsgId,
        reaction,
        createdAt: Date.now(),
      });
      toast('Channel reaction queued for reconnect.', { icon: '⏳' });
    } else {
      this.ws?.send(JSON.stringify({
        type: 'channel_reaction',
        msg_id: eventId,
        target_msg_id: targetMsgId,
        group_id: channelId,
        sender_pub_key: myPublicKey,
        reaction: reaction ?? '',
      }));
    }

    await applyOptimisticChannelReaction(targetMsgId, myPublicKey, reaction);
  }

  async sendChannelPin(channelId: string, targetMsgId: string | null, myPublicKey: string) {
    const eventId = crypto.randomUUID();
    if (!this.canSendImmediately()) {
      await this.enqueueOutgoingGroupEvent({
        id: eventId,
        type: 'channel_pin',
        groupId: channelId,
        senderPubKey: myPublicKey,
        targetMsgId: targetMsgId ?? undefined,
        createdAt: Date.now(),
      });
      toast('Channel pin change queued for reconnect.', { icon: '⏳' });
    } else {
      this.ws?.send(JSON.stringify({
        type: 'channel_pin',
        msg_id: eventId,
        target_msg_id: targetMsgId ?? '',
        group_id: channelId,
        sender_pub_key: myPublicKey,
        data: '',
      }));
    }

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

    await updateMessageByMsgID(msgId, { status: 'read' });
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

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'edit',
      msg_id: eventId,
      target_msg_id: msgId,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey,
      data: JSON.stringify(ratchetMsg)
    }));

    const editedAt = Date.now();
    const msg = await markMessageEdited(msgId, plaintext);
    if (msg?.id) {
      this.sendSelfSyncDirectMessage({
        kind: 'direct_edit',
        msgId,
        peerPubKey: recipientPubKey,
        text: plaintext,
        editedAt,
      });
    }
  }

  async sendDelete(recipientPubKey: string, msgId: string) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !myPublicKey) return;

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'delete',
      msg_id: eventId,
      target_msg_id: msgId,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey
    }));

    const deletedAt = Date.now();
    const msg = await markMessageDeleted(msgId);
    if (msg?.id) {
      this.sendSelfSyncDirectMessage({
        kind: 'direct_delete',
        msgId,
        peerPubKey: recipientPubKey,
        deletedAt,
      });
    }
  }

  async sendReaction(recipientPubKey: string, msgId: string, reaction: string | null) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !myPublicKey) return;

    const eventId = crypto.randomUUID();
    this.ws.send(JSON.stringify({
      type: 'reaction',
      msg_id: eventId,
      target_msg_id: msgId,
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey,
      reaction: reaction ?? ''
    }));

    const msg = await applyMessageReaction(msgId, myPublicKey, reaction);
    if (msg?.id) {
      this.sendSelfSyncDirectMessage({
        kind: 'direct_reaction',
        msgId,
        peerPubKey: recipientPubKey,
        actorPubKey: myPublicKey,
        reaction,
      });
    }
  }

  async sendDirectPin(recipientPubKey: string, targetMsgId: string | null) {
    const { myPublicKey } = useAppStore.getState();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !myPublicKey) {
      throw new Error('Secure channel is not ready yet');
    }

    this.ws.send(JSON.stringify({
      type: targetMsgId ? 'pin' : 'unpin',
      msg_id: crypto.randomUUID(),
      target_msg_id: targetMsgId ?? '',
      recipient_pub_key: recipientPubKey,
      sender_pub_key: myPublicKey,
    }));
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
