import React, { useDeferredValue, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { socketManager } from '../lib/socket';
import { clearThreadStats, db, syncThreadStats, type StoredMessage } from '../lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { ArrowLeft, ShieldCheck, Trash2, Phone, Video, Pencil, Search, X, Archive, Bell, BellOff, ArrowDownCircle, Users, Crown, WifiOff, Clock3, UserPlus, UserMinus, Shield, Megaphone, Pin, AtSign, Link2 } from 'lucide-react';
import { UserIdentityModal } from '../components/UserIdentityModal';
import { Sidebar } from '../components/Sidebar';
import { encryptFile, decryptFile } from '../lib/attachments';
import { CallOverlay } from '../components/CallOverlay';
import { toast } from 'react-hot-toast';
import { appConfig } from '../lib/config';
import { fetchWithTimeout, toNetworkErrorMessage, UPLOAD_REQUEST_TIMEOUT_MS } from '../lib/http';
import { encodeRichTextMessage, getMessageNotificationPreview, isMentioningPubKey, parseRichTextMessage, type ReplyPreview } from '../lib/message-format';
import { coerceMessageText } from '../lib/protocolContract';
import { deriveMentionHandle, getPublicKeyFingerprint } from '../lib/identity';
import { useI18n } from '../lib/i18n';
import {
  addChannelSubscriber,
  addGroupMember,
  createChannelInviteLink,
  createGroupInviteLink,
  deleteChannel,
  deleteGroup,
  leaveChannel,
  leaveGroup,
  listChannelInviteLinks,
  listChannelModerationAudit,
  listChannelSubscribers,
  listGroupInviteLinks,
  listGroupModerationAudit,
  listGroupMembers,
  removeChannelSubscriber,
  removeGroupMember,
  revokeChannelInviteLink,
  revokeGroupInviteLink,
  transferChannelOwnership,
  transferGroupOwnership,
  updateChannelSettings,
  updateChannelSubscriberRole,
  updateGroupMemberRole,
  updateGroupSettings,
  type InviteLinkRecord
} from '../lib/community';
import { decodeBase64 } from 'tweetnacl-util';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageBubble } from '../components/chat/MessageBubble';
import { fallbackParticipantName, normalizeReactionValue } from '../components/chat/messageUtils';
import { ChatComposer } from '../components/chat/ChatComposer';
import type { MentionSuggestion } from '../components/chat/MentionSuggestions';

const MAX_ATTACHMENT_SIZE_BYTES = 75 * 1024 * 1024;

function safeGroupMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((member): member is string => typeof member === 'string' && member.length > 0);
}

async function loadThreadMessages(threadId: string, limit?: number) {
  const collection = db.messages
    .where('[peerPublicKey+timestamp]')
    .between([threadId, Dexie.minKey], [threadId, Dexie.maxKey]);

  if (!limit || limit <= 0) {
    return collection.toArray();
  }

  const latest = await collection.reverse().limit(limit).toArray();
  return latest.reverse();
}

async function putChannelActivity(
  entry: Omit<import('../lib/db').ChannelActivityEntry, 'id' | 'createdAt'>
) {
  await db.channelActivity.put({
    id: crypto.randomUUID(),
    createdAt: new Date().getTime(),
    ...entry,
  });
}

const INITIAL_MESSAGE_RENDER_LIMIT = 120;
const MESSAGE_RENDER_STEP = 120;
export const Chat: React.FC = () => {
  const {
    myPublicKey,
    mySecretKey,
    activePeerKey,
    activeGroupId,
    activeChannelId,
    setActivePeer,
    setActiveGroup,
    setActiveChannel,
    typingStatus,
    connectionStatus,
    groupSyncStatus,
    channelSyncStatus
  } = useAppStore();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [draftOverrides, setDraftOverrides] = React.useState<Record<string, string>>({});
  const [isUploading, setIsUploading] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);
  const [messageSearch, setMessageSearch] = React.useState('');
  const [mentionFilterActive, setMentionFilterActive] = React.useState(false);
  const [viewedIdentityPubKey, setViewedIdentityPubKey] = React.useState<string | null>(null);
  const [messageRenderLimits, setMessageRenderLimits] = React.useState<Record<string, number>>({});
  const [nowTs, setNowTs] = React.useState(() => Date.now());
  const [groupMemberInput, setGroupMemberInput] = React.useState('');
  const [isAddingMember, setIsAddingMember] = React.useState(false);
  const [groupMembersMeta, setGroupMembersMeta] = React.useState<Array<{ memberPubKey: string; role: string }>>([]);
  const [memberActionPubKey, setMemberActionPubKey] = React.useState<string | null>(null);
  const [channelSubscriberInput, setChannelSubscriberInput] = React.useState('');
  const [isAddingSubscriber, setIsAddingSubscriber] = React.useState(false);
  const [channelSubscribersMeta, setChannelSubscribersMeta] = React.useState<Array<{ subscriberPubKey: string; role: string }>>([]);
  const [subscriberActionPubKey, setSubscriberActionPubKey] = React.useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = React.useState('');
  const [mentionStartIndex, setMentionStartIndex] = React.useState<number | null>(null);
  const [mentionSelectionIndex, setMentionSelectionIndex] = React.useState(0);
  const [activePeerFingerprint, setActivePeerFingerprint] = React.useState('');
  const isRoomSettingsOpen = location.pathname === '/room-settings';
  const [roomSettingsTab, setRoomSettingsTab] = React.useState<'general' | 'members' | 'roles' | 'invites' | 'moderation' | 'danger'>('general');
  const [moderationEntries, setModerationEntries] = React.useState<Array<{ id: number; actorPubKey: string; action: string; target: string; details: string; createdAt: string }>>([]);
  const [inviteTTLMinutes, setInviteTTLMinutes] = React.useState('0');
  const [inviteMaxUses, setInviteMaxUses] = React.useState('0');
  const [invitePassword, setInvitePassword] = React.useState('');
  const [inviteLinks, setInviteLinks] = React.useState<InviteLinkRecord[]>([]);
  const [inviteBusyToken, setInviteBusyToken] = React.useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = React.useState<string | null>(null);
  const [editingDraft, setEditingDraft] = React.useState('');
  const [replyTarget, setReplyTarget] = React.useState<ReplyPreview | null>(null);
  const [isDraggingFile, setIsDraggingFile] = React.useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const messageSearchInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSentRef = useRef(0);
  const caretRef = useRef(0);
  const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredMessageSearch = useDeferredValue(messageSearch.trim().toLowerCase());
  const activeThreadId = activeGroupId ?? activeChannelId ?? activePeerKey;
  const currentMessageRenderLimit = activeThreadId ? (messageRenderLimits[activeThreadId] ?? INITIAL_MESSAGE_RENDER_LIMIT) : INITIAL_MESSAGE_RENDER_LIMIT;

  useEffect(() => {
    if (myPublicKey) {
      socketManager.connect(myPublicKey);
    }
  }, [myPublicKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const messages = useLiveQuery(async () => {
    const threadId = activeGroupId ?? activeChannelId ?? activePeerKey;
    if (!threadId) return [];
    if (deferredMessageSearch) {
      return loadThreadMessages(threadId);
    }
    return loadThreadMessages(threadId, currentMessageRenderLimit);
  }, [activeGroupId, activeChannelId, activePeerKey, currentMessageRenderLimit, deferredMessageSearch]);
  const totalThreadMessageCount = useLiveQuery(() => {
    const threadId = activeGroupId ?? activeChannelId ?? activePeerKey;
    if (!threadId) return 0;
    return db.messages.where('peerPublicKey').equals(threadId).count();
  }, [activeGroupId, activeChannelId, activePeerKey]);
  const unreadIncomingMessages = useLiveQuery(async () => {
    const threadId = activeGroupId ?? activeChannelId ?? activePeerKey;
    if (!threadId || !myPublicKey) return [];

    const threadMessages = await db.messages.where('peerPublicKey').equals(threadId).sortBy('timestamp');
    return threadMessages.filter((msg) => {
      if (msg.status === 'read') {
        return false;
      }
      if (activeGroupId || activeChannelId) {
        return msg.senderPublicKey !== myPublicKey;
      }
      return msg.senderPublicKey === activePeerKey;
    });
  }, [activeChannelId, activeGroupId, activePeerKey, myPublicKey]);

  const activeContact = useLiveQuery(() => {
    if (!activePeerKey) return undefined;
    return db.contacts.get(activePeerKey);
  }, [activePeerKey]);
  const activeGroup = useLiveQuery(() => {
    if (!activeGroupId) return undefined;
    return db.groupThreads.get(activeGroupId);
  }, [activeGroupId]);
  const activeChannel = useLiveQuery(() => {
    if (!activeChannelId) return undefined;
    return db.channelThreads.get(activeChannelId);
  }, [activeChannelId]);
  const channelActivity = useLiveQuery(() => {
    if (!activeChannelId) return [];
    return db.channelActivity
      .where('[channelId+createdAt]')
      .between([activeChannelId, Dexie.minKey], [activeChannelId, Dexie.maxKey])
      .reverse()
      .limit(12)
      .toArray();
  }, [activeChannelId]);
  const activeGroupMembers = React.useMemo(() => safeGroupMembers(activeGroup?.members), [activeGroup?.members]);
  const pinnedChannelMessage = useLiveQuery(() => {
    if (!activeChannelId || !activeChannel?.pinnedMsgId) return undefined;
    return db.messages.where('msgId').equals(activeChannel.pinnedMsgId).first();
  }, [activeChannelId, activeChannel?.pinnedMsgId]);
  const pinnedDirectMessage = useLiveQuery(() => {
    if (!activePeerKey || !activeContact?.pinnedMsgId) return undefined;
    return db.messages.where('msgId').equals(activeContact.pinnedMsgId).first();
  }, [activePeerKey, activeContact?.pinnedMsgId]);
  const pinnedGroupMessage = useLiveQuery(() => {
    if (!activeGroupId || !activeGroup?.pinnedMsgId) return undefined;
    return db.messages.where('msgId').equals(activeGroup.pinnedMsgId).first();
  }, [activeGroupId, activeGroup?.pinnedMsgId]);
  const queuedGroupEvents = useLiveQuery(() => {
    if (!activeGroupId) return [];
    return db.outgoingGroupEvents.where('groupId').equals(activeGroupId).sortBy('createdAt');
  }, [activeGroupId]);
  const queuedDirectMessages = useLiveQuery(() => {
    if (!activePeerKey) return [];
    return db.outgoingDirectMessages.where('recipientPubKey').equals(activePeerKey).sortBy('createdAt');
  }, [activePeerKey]);
  const isChatMuted = Boolean(activeContact?.mutedUntil && activeContact.mutedUntil > nowTs);
  const canManageGroupMembers = activeGroup?.role === 'owner' || activeGroup?.role === 'admin';
  const canManageChannelSubscribers = activeChannel?.role === 'owner' || activeChannel?.role === 'admin';
  const canViewGroupMembers = canManageGroupMembers;
  const canViewChannelSubscribers = canManageChannelSubscribers;
  const canPostInChannel = activeChannel?.role === 'owner' || activeChannel?.role === 'admin' || activeChannel?.role === 'poster';
  const canPinChannelPosts = activeChannel?.role === 'owner' || activeChannel?.role === 'admin';
  const activeGroupMembersKey = activeGroupMembers.join('|');
  const displayedGroupMembers = React.useMemo(() => activeGroupId
    ? (groupMembersMeta.length ? groupMembersMeta : activeGroupMembers.map((memberPubKey) => ({
      memberPubKey,
      role: memberPubKey === myPublicKey ? activeGroup?.role ?? 'member' : 'member',
    })))
    : [], [activeGroup?.role, activeGroupId, activeGroupMembers, groupMembersMeta, myPublicKey]);
  const displayedChannelSubscribers = React.useMemo(() => activeChannelId
    ? (channelSubscribersMeta.length ? channelSubscribersMeta : [])
    : [], [activeChannelId, channelSubscribersMeta]);
  const messageInput = activeThreadId
    ? (draftOverrides[activeThreadId] ?? (activePeerKey ? activeContact?.draft ?? '' : ''))
    : '';
  const filteredMessages = React.useMemo(() => {
    if (!messages) return messages;
    if (!deferredMessageSearch && !mentionFilterActive) return messages;
    return messages.filter((msg) => {
      if (msg.deletedAt) return false;
      let matches = true;
      if (mentionFilterActive && myPublicKey) {
        matches = isMentioningPubKey(msg.text, myPublicKey);
      }
      if (matches && deferredMessageSearch) {
        matches = coerceMessageText(msg.text).toLowerCase().includes(deferredMessageSearch);
      }
      return matches;
    });
  }, [deferredMessageSearch, mentionFilterActive, messages, myPublicKey]);
  const visibleMessages = filteredMessages;
  const hasHiddenMessages = Boolean(
    !deferredMessageSearch &&
    totalThreadMessageCount &&
    visibleMessages &&
    totalThreadMessageCount > visibleMessages.length
  );
  const stableUnreadIncomingMessages = React.useMemo(
    () => unreadIncomingMessages ?? [],
    [unreadIncomingMessages]
  );
  const relevantParticipantKeys = React.useMemo(() => {
    const keys = new Set<string>();

    if (myPublicKey) {
      keys.add(myPublicKey);
    }
    if (activePeerKey) {
      keys.add(activePeerKey);
    }
    activeGroupMembers.forEach((member) => keys.add(member));
    channelSubscribersMeta.forEach((subscriber) => keys.add(subscriber.subscriberPubKey));
    (channelActivity ?? []).forEach((entry) => {
      if (entry.actorPubKey) {
        keys.add(entry.actorPubKey);
      }
      if (entry.targetPubKey) {
        keys.add(entry.targetPubKey);
      }
    });
    (visibleMessages ?? []).forEach((msg) => {
      if (msg.senderPublicKey) {
        keys.add(msg.senderPublicKey);
      }
    });

    return [...keys];
  }, [activeGroupMembers, activePeerKey, channelActivity, channelSubscribersMeta, myPublicKey, visibleMessages]);
  const participantNames = useLiveQuery(async () => {
    if (!relevantParticipantKeys.length) {
      return {};
    }
    const contacts = await db.contacts.bulkGet(relevantParticipantKeys);
    return relevantParticipantKeys.reduce<Record<string, string>>((acc, pubKey, index) => {
      const contact = contacts[index];
      acc[pubKey] = contact?.name || fallbackParticipantName(pubKey);
      return acc;
    }, {});
  }, [relevantParticipantKeys.join('|')]);
  const mentionCandidates = React.useMemo(() => {
    const candidates: MentionSuggestion[] = [];
    const seenPubKeys = new Set<string>();
    const takenHandles = new Set<string>();

    const pushCandidate = (pubKey: string | undefined, fallbackName?: string) => {
      if (!pubKey || seenPubKeys.has(pubKey)) {
        return;
      }
      seenPubKeys.add(pubKey);
      const displayName = participantNames?.[pubKey] || fallbackName || fallbackParticipantName(pubKey);
      const handle = deriveMentionHandle(displayName, pubKey, takenHandles);
      candidates.push({ pubKey, displayName, handle });
    };

    if (activeGroupId) {
      displayedGroupMembers.forEach((member) => pushCandidate(member.memberPubKey));
    } else if (activeChannelId) {
      displayedChannelSubscribers.forEach((subscriber) => pushCandidate(subscriber.subscriberPubKey));
    } else if (activePeerKey) {
      pushCandidate(activePeerKey, activeContact?.name || undefined);
    }

    return candidates;
  }, [
    activeChannelId,
    activeContact?.name,
    activeGroupId,
    activePeerKey,
    displayedChannelSubscribers,
    displayedGroupMembers,
    participantNames
  ]);
  const mentionHandleDirectory = React.useMemo(
    () => Object.fromEntries(mentionCandidates.map((candidate) => [candidate.handle, candidate.pubKey])),
    [mentionCandidates]
  );
  const mentionSuggestions = React.useMemo(() => {
    if (mentionStartIndex === null) {
      return [];
    }
    const query = mentionQuery.trim().toLowerCase();
    const filtered = mentionCandidates.filter((candidate) =>
      candidate.handle.includes(query) || candidate.displayName.toLowerCase().includes(query)
    );
    return filtered.slice(0, 6);
  }, [mentionCandidates, mentionQuery, mentionStartIndex]);
  const isMentionMenuOpen = mentionStartIndex !== null && mentionSuggestions.length > 0;
  const firstUnreadMessageId = deferredMessageSearch ? null : stableUnreadIncomingMessages[0]?.msgId ?? null;
  const unreadCount = deferredMessageSearch ? 0 : stableUnreadIncomingMessages.length;
  const lastVisibleMessageId = visibleMessages?.[visibleMessages.length - 1]?.msgId ?? null;
  const contactAvatar = activeContact?.avatar?.trim() || null;
  const resolveParticipantName = React.useCallback((pubKey: string | undefined) => {
    if (!pubKey) return 'Someone';
    if (pubKey === myPublicKey) return 'You';
    return participantNames?.[pubKey] || fallbackParticipantName(pubKey);
  }, [myPublicKey, participantNames]);
  const getThreadMessagePreview = React.useCallback((msg: StoredMessage | undefined) => {
    if (!msg) return '';
    return getMessageNotificationPreview(msg.text);
  }, []);
  const buildReplyPreview = React.useCallback((msg: StoredMessage): ReplyPreview => ({
    msgId: msg.msgId,
    senderPubKey: msg.senderPublicKey,
    preview: getMessageNotificationPreview(msg.text),
  }), []);
  const queuedDirectById = React.useMemo(
    () => new Map((queuedDirectMessages ?? []).map((message) => [message.id, message] as const)),
    [queuedDirectMessages]
  );

  useEffect(() => {
    if (!activePeerKey) {
      void Promise.resolve().then(() => setActivePeerFingerprint(''));
      return;
    }
    void getPublicKeyFingerprint(activePeerKey)
      .then((fingerprint) => setActivePeerFingerprint(fingerprint))
      .catch(() => setActivePeerFingerprint(''));
  }, [activePeerKey]);

  useEffect(() => {
    if (!activePeerKey || !myPublicKey || !mySecretKey) {
      return;
    }
    void socketManager.syncDirectHistory(activePeerKey);
  }, [activePeerKey, myPublicKey, mySecretKey]);

  useEffect(() => {
    if (!isRoomSettingsOpen) {
      return;
    }
    void Promise.resolve().then(() => setRoomSettingsTab('general'));
  }, [isRoomSettingsOpen, activeGroupId, activeChannelId]);

  useEffect(() => {
    if (!isRoomSettingsOpen || roomSettingsTab !== 'moderation') {
      return;
    }
    if (activeGroupId && canManageGroupMembers) {
      void listGroupModerationAudit(activeGroupId).then((entries) => setModerationEntries(entries)).catch(() => setModerationEntries([]));
      return;
    }
    if (activeChannelId && canManageChannelSubscribers) {
      void listChannelModerationAudit(activeChannelId).then((entries) => setModerationEntries(entries)).catch(() => setModerationEntries([]));
      return;
    }
    void Promise.resolve().then(() => setModerationEntries([]));
  }, [activeChannelId, activeGroupId, canManageChannelSubscribers, canManageGroupMembers, isRoomSettingsOpen, roomSettingsTab]);

  const loadInviteLinks = React.useCallback(async () => {
    try {
      if (activeGroupId && canManageGroupMembers) {
        setInviteLinks(await listGroupInviteLinks(activeGroupId));
        return;
      }
      if (activeChannelId && canManageChannelSubscribers) {
        setInviteLinks(await listChannelInviteLinks(activeChannelId));
        return;
      }
      setInviteLinks([]);
    } catch {
      setInviteLinks([]);
    }
  }, [activeChannelId, activeGroupId, canManageChannelSubscribers, canManageGroupMembers]);

  useEffect(() => {
    if (!isRoomSettingsOpen || roomSettingsTab !== 'invites') return;
    const timer = window.setTimeout(() => {
      void loadInviteLinks();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isRoomSettingsOpen, loadInviteLinks, roomSettingsTab]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      setMentionQuery('');
      setMentionStartIndex(null);
      setMentionSelectionIndex(0);
      setReplyTarget(null);
    });
  }, [activeThreadId]);

  useEffect(() => {
    let newIndex = mentionSelectionIndex;
    if (!mentionSuggestions.length) {
      newIndex = 0;
    } else if (mentionSelectionIndex >= mentionSuggestions.length) {
      newIndex = 0;
    }

    if (newIndex !== mentionSelectionIndex) {
      void Promise.resolve().then(() => setMentionSelectionIndex(newIndex));
    }
  }, [mentionSelectionIndex, mentionSuggestions.length]);

  useEffect(() => {
    if (!lastVisibleMessageId) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastVisibleMessageId]);

  useEffect(() => {
    if (!activeGroupId || !canViewGroupMembers) return;

    void listGroupMembers(activeGroupId)
      .then((members) => setGroupMembersMeta(members))
      .catch((error) => {
        console.warn('Failed to load group members metadata', error);
      });
  }, [activeGroup?.memberCount, activeGroup?.role, activeGroupId, activeGroupMembersKey, canViewGroupMembers]);

  useEffect(() => {
    if (!activeChannelId || !canViewChannelSubscribers) return;

    void listChannelSubscribers(activeChannelId)
      .then((subscribers) => setChannelSubscribersMeta(subscribers))
      .catch((error) => {
        console.warn('Failed to load channel subscribers metadata', error);
      });
  }, [activeChannel?.role, activeChannel?.subscriberCount, activeChannelId, canViewChannelSubscribers]);

  useEffect(() => {
    if (!activePeerKey) return;
    if (draftSyncTimerRef.current) {
      clearTimeout(draftSyncTimerRef.current);
    }

    draftSyncTimerRef.current = setTimeout(() => {
      void db.contacts.update(activePeerKey, { draft: messageInput });
    }, 250);

    return () => {
      if (draftSyncTimerRef.current) {
        clearTimeout(draftSyncTimerRef.current);
      }
    };
  }, [activePeerKey, messageInput]);

  useEffect(() => {
    if (!activePeerKey || !myPublicKey || !messages) return;

    if (!messages.length || !stableUnreadIncomingMessages.length) {
      return;
    }

    void Promise.all(
      stableUnreadIncomingMessages.map((msg) => socketManager.sendReadReceipt(activePeerKey, msg.msgId, myPublicKey))
    );
  }, [activePeerKey, myPublicKey, messages, stableUnreadIncomingMessages]);

  useEffect(() => {
    if (!activeGroupId || !messages?.length || !stableUnreadIncomingMessages.length) return;

    void Promise.all(
      stableUnreadIncomingMessages
        .filter((msg) => msg.id !== undefined)
        .map((msg) => db.messages.update(msg.id!, { status: 'read' }))
    ).then(() => syncThreadStats(activeGroupId));
  }, [activeGroupId, messages, stableUnreadIncomingMessages]);

  useEffect(() => {
    if (!activeChannelId || !messages?.length || !stableUnreadIncomingMessages.length) return;

    void Promise.all(
      stableUnreadIncomingMessages
        .filter((msg) => msg.id !== undefined)
        .map((msg) => db.messages.update(msg.id!, { status: 'read' }))
    ).then(() => syncThreadStats(activeChannelId));
  }, [activeChannelId, messages, stableUnreadIncomingMessages]);

  const closeMentionMenu = React.useCallback(() => {
    setMentionQuery('');
    setMentionStartIndex(null);
    setMentionSelectionIndex(0);
  }, []);

  const handleMentionClick = React.useCallback((pubKey: string) => {
    setViewedIdentityPubKey(pubKey);
  }, []);

  const handleComposerChange = React.useCallback((nextValue: string, caretPosition: number) => {
    if (activeThreadId) {
      setDraftOverrides((current) => ({ ...current, [activeThreadId]: nextValue }));
    }
    caretRef.current = caretPosition;

    const prefix = nextValue.slice(0, caretPosition);
    const mentionMatch = prefix.match(/(^|\s)@([a-z0-9._-]{0,32})$/i);
    if (!mentionMatch) {
      closeMentionMenu();
      return;
    }

    const mentionToken = mentionMatch[2].toLowerCase();
    const mentionStart = caretPosition - mentionToken.length - 1;
    setMentionStartIndex(mentionStart);
    setMentionQuery(mentionToken);
    setMentionSelectionIndex(0);
  }, [activeThreadId, closeMentionMenu]);

  const applyMentionSuggestion = React.useCallback((candidate: { pubKey: string; displayName: string; handle: string }) => {
    if (mentionStartIndex === null || !activeThreadId) {
      return;
    }
    const before = messageInput.slice(0, mentionStartIndex);
    const after = messageInput.slice(caretRef.current);
    const nextValue = `${before}@${candidate.handle} ${after}`;
    const nextCaret = (before.length + candidate.handle.length + 2);
    setDraftOverrides((current) => ({ ...current, [activeThreadId]: nextValue }));
    closeMentionMenu();
    requestAnimationFrame(() => {
      if (messageInputRef.current) {
        messageInputRef.current.selectionStart = nextCaret;
        messageInputRef.current.selectionEnd = nextCaret;
        messageInputRef.current.focus();
      }
      caretRef.current = nextCaret;
    });
  }, [activeThreadId, closeMentionMenu, mentionStartIndex, messageInput]);

  const handleComposerKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isMentionMenuOpen) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setMentionSelectionIndex((current) => (current + 1) % mentionSuggestions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMentionSelectionIndex((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeMentionMenu();
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const selected = mentionSuggestions[mentionSelectionIndex] ?? mentionSuggestions[0];
      if (selected) {
        applyMentionSuggestion(selected);
      }
    }
  }, [applyMentionSuggestion, closeMentionMenu, isMentionMenuOpen, mentionSelectionIndex, mentionSuggestions]);

  const submitCurrentMessage = React.useCallback(async () => {
    if (!messageInput.trim() || !myPublicKey) return;

    const plaintext = encodeRichTextMessage(messageInput.trim(), mentionHandleDirectory, replyTarget);

    try {
      if (activeGroupId && mySecretKey) {
        await socketManager.sendGroupMessage(activeGroupId, plaintext, myPublicKey, mySecretKey);
      } else if (activeChannelId) {
        await socketManager.sendChannelMessage(activeChannelId, plaintext, myPublicKey);
      } else if (activePeerKey && mySecretKey) {
        await socketManager.send(activePeerKey, plaintext, mySecretKey, myPublicKey);
        await db.contacts.update(activePeerKey, { draft: '', lastMessageAt: Date.now() });
        setDraftOverrides((current) => ({ ...current, [activePeerKey]: '' }));
      } else {
        return;
      }

      closeMentionMenu();
      if (activeThreadId) {
        setDraftOverrides((current) => ({ ...current, [activeThreadId]: '' }));
      }
      setReplyTarget(null);
    } catch (err) {
      console.error("Failed to send", err);
      toast.error(err instanceof Error ? err.message : "Failed to send message");
    }
  }, [activeChannelId, activeGroupId, activePeerKey, activeThreadId, closeMentionMenu, mentionHandleDirectory, messageInput, myPublicKey, mySecretKey, replyTarget]);

  const handleSendMessage = React.useCallback((e: React.FormEvent) => {
    e.preventDefault();
    void submitCurrentMessage();
  }, [submitCurrentMessage]);

  const handleDirectTyping = React.useCallback((nextValue: string) => {
    if (activePeerKey && myPublicKey && nextValue.trim()) {
      const now = Date.now();
      if (now - lastTypingSentRef.current > 1500) {
        socketManager.sendTyping(activePeerKey, myPublicKey);
        lastTypingSentRef.current = now;
      }
    }
  }, [activePeerKey, myPublicKey]);

  const handleSelectedFile = React.useCallback(async (file: File) => {
    if (!mySecretKey || !myPublicKey || (!activePeerKey && !activeGroupId && !activeChannelId)) return;
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      toast.error('This file is too large. Please choose a file smaller than 75 MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    try {
      const { encryptedBlob, key } = await encryptFile(file);
      const formData = new FormData();
      formData.append('file', encryptedBlob, file.name);
      if (activeGroupId) {
        formData.append('group_id', activeGroupId);
      } else if (activeChannelId) {
        formData.append('group_id', activeChannelId);
      } else if (activePeerKey) {
        formData.append('recipient_pub_key', activePeerKey);
      }

      const response = await fetchWithTimeout(appConfig.uploadUrl, {
        method: 'POST',
        headers: socketManager.getSessionHeaders(),
        body: formData,
      }, {
        timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
      });

      if (!response.ok) {
        throw new Error(
          response.status === 413
            ? 'This file is too large for upload. Please choose a smaller file.'
            : `Upload failed (${response.status})`
        );
      }
      const { url } = await response.json();

      const fileData = {
        type: 'file',
        url: `${appConfig.backendOrigin}${url}`,
        key,
        name: file.name,
        size: file.size,
        mimeType: file.type
      };

      if (activeGroupId) {
        await socketManager.sendGroupMessage(activeGroupId, JSON.stringify(fileData), myPublicKey, mySecretKey);
      } else if (activeChannelId) {
        await socketManager.sendChannelMessage(activeChannelId, JSON.stringify(fileData), myPublicKey);
      } else if (activePeerKey) {
        await socketManager.send(activePeerKey, JSON.stringify(fileData), mySecretKey, myPublicKey);
      }
    } catch (err) {
      console.error("Upload failed", err);
      toast.error(toNetworkErrorMessage(err, "Failed to upload file"));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [activeChannelId, activeGroupId, activePeerKey, myPublicKey, mySecretKey]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleSelectedFile(file);
  };

  const handleDragOver = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!activeThreadId || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    setIsDraggingFile(true);
  }, [activeThreadId]);

  const handleDragLeave = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDraggingFile(false);
  }, []);

  const handleDrop = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!activeThreadId) return;
    event.preventDefault();
    setIsDraggingFile(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void handleSelectedFile(file);
    }
  }, [activeThreadId, handleSelectedFile]);

  const handleVoiceUpload = async (file: File) => {
    if (!mySecretKey || !myPublicKey || (!activePeerKey && !activeGroupId && !activeChannelId)) return;
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      toast.error('This recording is too large. Please keep voice messages under 75 MB.');
      return;
    }

    setIsUploading(true);
    try {
      const { encryptedBlob, key } = await encryptFile(file);
      const formData = new FormData();
      formData.append('file', encryptedBlob, file.name);
      if (activeGroupId) {
        formData.append('group_id', activeGroupId);
      } else if (activeChannelId) {
        formData.append('group_id', activeChannelId);
      } else if (activePeerKey) {
        formData.append('recipient_pub_key', activePeerKey);
      }

      const response = await fetchWithTimeout(appConfig.uploadUrl, {
        method: 'POST',
        headers: socketManager.getSessionHeaders(),
        body: formData
      }, {
        timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
      });
      if (!response.ok) {
        throw new Error(
          response.status === 413
            ? 'This recording is too large for upload. Please keep it shorter.'
            : `Upload failed (${response.status})`
        );
      }

      const { url } = await response.json();
      const voiceData = { type: 'voice', url: `${appConfig.backendOrigin}${url}`, key, duration: 0 };
      if (activeGroupId) {
        await socketManager.sendGroupMessage(activeGroupId, JSON.stringify(voiceData), myPublicKey, mySecretKey);
      } else if (activeChannelId) {
        await socketManager.sendChannelMessage(activeChannelId, JSON.stringify(voiceData), myPublicKey);
      } else if (activePeerKey) {
        await socketManager.send(activePeerKey, JSON.stringify(voiceData), mySecretKey, myPublicKey);
      }
    } catch (error) {
      toast.error(toNetworkErrorMessage(error, "Failed to upload voice message"));
    } finally {
      setIsUploading(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([audioBlob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
        await handleVoiceUpload(file);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      setIsRecording(true);
    } catch {
      toast.error("Microphone access denied");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  const downloadFile = async (url: string, key: string, name: string) => {
    try {
      const blob = await decryptFile(url, key);
      const downloadUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = name;
      anchor.click();
      window.URL.revokeObjectURL(downloadUrl);
    } catch {
      toast.error("Failed to download file");
    }
  };

  const handleClearChat = async () => {
    if (!activeThreadId) return;
    if (window.confirm("Delete chat history?")) {
      const msgsToDelete = await db.messages.where('peerPublicKey').equals(activeThreadId).primaryKeys();
      await db.messages.bulkDelete(msgsToDelete as number[]);
      await clearThreadStats(activeThreadId);
    }
  };

  const handleToggleMute = async () => {
    if (!activePeerKey) return;
    const mutedUntil = activeContact?.mutedUntil && activeContact.mutedUntil > Date.now()
      ? undefined
      : Date.now() + 8 * 60 * 60 * 1000;
    await db.contacts.update(activePeerKey, { mutedUntil });
  };

  const handleToggleArchive = async () => {
    if (!activePeerKey) return;
    const nextArchived = !activeContact?.archived;
    await db.contacts.update(activePeerKey, {
      archived: nextArchived,
      pinned: nextArchived ? false : activeContact?.pinned,
    });
    if (nextArchived) {
      setActivePeer(null);
    }
  };

  const handleVerifyIdentity = async () => {
    if (!activePeerKey || !activePeerFingerprint) return;
    await db.contacts.update(activePeerKey, {
      verifiedIdentityFingerprint: activePeerFingerprint,
      verifiedIdentityAt: Date.now(),
    });
    toast.success('Contact key fingerprint verified.');
  };

  const handleClearIdentityVerification = async () => {
    if (!activePeerKey) return;
    await db.contacts.update(activePeerKey, {
      verifiedIdentityFingerprint: undefined,
      verifiedIdentityAt: undefined,
    });
    toast('Contact key verification removed.');
  };

  const jumpToFirstUnread = () => {
    if (!firstUnreadMessageId) return;
    const target = document.querySelector<HTMLElement>(`[data-msg-id="${firstUnreadMessageId}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleLoadOlderMessages = () => {
    if (!activeThreadId) return;
    setMessageRenderLimits((current) => ({
      ...current,
      [activeThreadId]: (current[activeThreadId] ?? INITIAL_MESSAGE_RENDER_LIMIT) + MESSAGE_RENDER_STEP,
    }));
  };

  const handleAddGroupMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeGroupId) return;

    const normalized = groupMemberInput.trim();
    if (!normalized) {
      return;
    }

    try {
      const decoded = decodeBase64(normalized);
      if (decoded.length !== 32) {
        toast.error('Member key must be 32 bytes long.');
        return;
      }
    } catch {
      toast.error('Member key must be valid Base64.');
      return;
    }

    setIsAddingMember(true);
    try {
      await addGroupMember(activeGroupId, normalized);
      setGroupMemberInput('');
      toast.success('Member added to group.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add member');
    } finally {
      setIsAddingMember(false);
    }
  };

  const handlePromoteMember = async (memberPubKey: string) => {
    if (!activeGroupId) return;
    setMemberActionPubKey(memberPubKey);
    try {
      await updateGroupMemberRole(activeGroupId, memberPubKey, 'admin');
      setGroupMembersMeta((current) => current.map((member) => member.memberPubKey === memberPubKey ? { ...member, role: 'admin' } : member));
      toast.success('Member promoted to admin.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update member role');
    } finally {
      setMemberActionPubKey(null);
    }
  };

  const handleDemoteMember = async (memberPubKey: string) => {
    if (!activeGroupId) return;
    setMemberActionPubKey(memberPubKey);
    try {
      await updateGroupMemberRole(activeGroupId, memberPubKey, 'member');
      setGroupMembersMeta((current) => current.map((member) => member.memberPubKey === memberPubKey ? { ...member, role: 'member' } : member));
      toast.success('Admin rights removed.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update member role');
    } finally {
      setMemberActionPubKey(null);
    }
  };

  const handleRemoveMember = async (memberPubKey: string) => {
    if (!activeGroupId) return;
    setMemberActionPubKey(memberPubKey);
    try {
      await removeGroupMember(activeGroupId, memberPubKey);
      setGroupMembersMeta((current) => current.filter((member) => member.memberPubKey !== memberPubKey));
      toast.success('Member removed from group.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove member');
    } finally {
      setMemberActionPubKey(null);
    }
  };

  const handleTransferOwnership = async (memberPubKey: string) => {
    if (!activeGroupId) return;
    setMemberActionPubKey(memberPubKey);
    try {
      await transferGroupOwnership(activeGroupId, memberPubKey);
      setGroupMembersMeta((current) =>
        current.map((member) => {
          if (member.memberPubKey === memberPubKey) {
            return { ...member, role: 'owner' };
          }
          if (member.memberPubKey === myPublicKey) {
            return { ...member, role: 'admin' };
          }
          return member;
        })
      );
      toast.success('Ownership transferred.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to transfer ownership');
    } finally {
      setMemberActionPubKey(null);
    }
  };

  const handleLeaveGroup = async () => {
    if (!activeGroupId) return;
    try {
      if (activeGroup?.role === 'owner') {
        const confirmed = window.confirm('Delete this group for all members? This action cannot be undone.');
        if (!confirmed) return;
        await deleteGroup(activeGroupId);
        toast.success('Group deleted.');
      } else {
        await leaveGroup(activeGroupId);
        toast.success('You left the group.');
      }
      setActiveGroup(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update group');
    }
  };

  const handleCopyGroupInviteLink = async () => {
    if (!activeGroupId) return;
    try {
      const ttlMinutes = Number.parseInt(inviteTTLMinutes, 10);
      const maxUses = Number.parseInt(inviteMaxUses, 10);
      const url = await createGroupInviteLink(activeGroupId, {
        ttlMinutes: Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : undefined,
        maxUses: Number.isFinite(maxUses) && maxUses > 0 ? maxUses : undefined,
        password: invitePassword.trim() || undefined,
      });
      await navigator.clipboard.writeText(url);
      toast.success('Group invite link copied.');
      await loadInviteLinks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create group invite link');
    }
  };

  const handleUpdateGroupSettings = async () => {
    if (!activeGroupId || !activeGroup || !canManageGroupMembers) return;
    const nextTitle = window.prompt('Group title', activeGroup.title)?.trim();
    if (!nextTitle) return;
    const nextAvatarRaw = window.prompt('Group avatar URL (leave blank to remove)', activeGroup.avatar ?? '') ?? '';
    const nextAvatar = nextAvatarRaw.trim();
    try {
      await updateGroupSettings(activeGroupId, { title: nextTitle, avatar: nextAvatar || null });
      await db.groupThreads.update(activeGroupId, { title: nextTitle, avatar: nextAvatar || null });
      toast.success('Group settings updated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update group settings');
    }
  };

  const validatePublicKey = (value: string) => {
    try {
      return decodeBase64(value).length === 32;
    } catch {
      return false;
    }
  };

  const handleAddChannelSubscriber = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeChannelId) return;

    const normalized = channelSubscriberInput.trim();
    if (!normalized) return;
    if (!validatePublicKey(normalized)) {
      toast.error('Subscriber public key must be valid Base64 and 32 bytes long.');
      return;
    }

    setIsAddingSubscriber(true);
    try {
      await addChannelSubscriber(activeChannelId, normalized);
      await putChannelActivity({
        channelId: activeChannelId,
        type: 'subscriber_added',
        actorPubKey: myPublicKey ?? normalized,
        targetPubKey: normalized,
      });
      setChannelSubscriberInput('');
      setChannelSubscribersMeta((current) => {
        if (current.some((subscriber) => subscriber.subscriberPubKey === normalized)) {
          return current;
        }
        return [...current, { subscriberPubKey: normalized, role: 'subscriber' }];
      });
      toast.success('Subscriber added to channel.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add subscriber');
    } finally {
      setIsAddingSubscriber(false);
    }
  };

  const handleUpdateChannelRole = async (
    subscriberPubKey: string,
    role: 'admin' | 'poster' | 'subscriber',
    successMessage: string
  ) => {
    if (!activeChannelId) return;
    setSubscriberActionPubKey(subscriberPubKey);
    try {
      await updateChannelSubscriberRole(activeChannelId, subscriberPubKey, role);
      await putChannelActivity({
        channelId: activeChannelId,
        type: 'role_changed',
        actorPubKey: myPublicKey ?? subscriberPubKey,
        targetPubKey: subscriberPubKey,
        details: role,
      });
      setChannelSubscribersMeta((current) =>
        current.map((subscriber) =>
          subscriber.subscriberPubKey === subscriberPubKey ? { ...subscriber, role } : subscriber
        )
      );
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update subscriber role');
    } finally {
      setSubscriberActionPubKey(null);
    }
  };

  const handleRemoveChannelSubscriber = async (subscriberPubKey: string) => {
    if (!activeChannelId) return;
    setSubscriberActionPubKey(subscriberPubKey);
    try {
      await removeChannelSubscriber(activeChannelId, subscriberPubKey);
      await putChannelActivity({
        channelId: activeChannelId,
        type: 'subscriber_removed',
        actorPubKey: myPublicKey ?? subscriberPubKey,
        targetPubKey: subscriberPubKey,
      });
      setChannelSubscribersMeta((current) =>
        current.filter((subscriber) => subscriber.subscriberPubKey !== subscriberPubKey)
      );
      toast.success('Subscriber removed from channel.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove subscriber');
    } finally {
      setSubscriberActionPubKey(null);
    }
  };

  const handleTransferChannelOwner = async (subscriberPubKey: string) => {
    if (!activeChannelId) return;
    setSubscriberActionPubKey(subscriberPubKey);
    try {
      await transferChannelOwnership(activeChannelId, subscriberPubKey);
      await putChannelActivity({
        channelId: activeChannelId,
        type: 'ownership_transferred',
        actorPubKey: myPublicKey ?? subscriberPubKey,
        targetPubKey: subscriberPubKey,
      });
      setChannelSubscribersMeta((current) =>
        current.map((subscriber) => {
          if (subscriber.subscriberPubKey === subscriberPubKey) {
            return { ...subscriber, role: 'owner' };
          }
          if (subscriber.subscriberPubKey === myPublicKey) {
            return { ...subscriber, role: 'admin' };
          }
          return subscriber;
        })
      );
      toast.success('Channel ownership transferred.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to transfer channel ownership');
    } finally {
      setSubscriberActionPubKey(null);
    }
  };

  const handleLeaveChannel = async () => {
    if (!activeChannelId) return;
    try {
      if (activeChannel?.role === 'owner') {
        const confirmed = window.confirm('Delete this channel for all subscribers? This action cannot be undone.');
        if (!confirmed) return;
        await deleteChannel(activeChannelId);
        await putChannelActivity({
          channelId: activeChannelId,
          type: 'channel_deleted',
          actorPubKey: myPublicKey ?? 'unknown',
        });
        toast.success('Channel deleted.');
      } else {
        await leaveChannel(activeChannelId);
        await putChannelActivity({
          channelId: activeChannelId,
          type: 'channel_left',
          actorPubKey: myPublicKey ?? 'unknown',
        });
        toast.success('You left the channel.');
      }
      setActiveChannel(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update channel');
    }
  };

  const handleCopyChannelInviteLink = async () => {
    if (!activeChannelId) return;
    try {
      const ttlMinutes = Number.parseInt(inviteTTLMinutes, 10);
      const maxUses = Number.parseInt(inviteMaxUses, 10);
      const url = await createChannelInviteLink(activeChannelId, {
        ttlMinutes: Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : undefined,
        maxUses: Number.isFinite(maxUses) && maxUses > 0 ? maxUses : undefined,
        password: invitePassword.trim() || undefined,
      });
      await navigator.clipboard.writeText(url);
      toast.success('Channel invite link copied.');
      await loadInviteLinks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create channel invite link');
    }
  };

  const handleRevokeInvite = async (token: string) => {
    setInviteBusyToken(token);
    try {
      if (activeGroupId) {
        await revokeGroupInviteLink(activeGroupId, token);
      } else if (activeChannelId) {
        await revokeChannelInviteLink(activeChannelId, token);
      }
      toast.success('Invite link revoked.');
      await loadInviteLinks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to revoke invite link');
    } finally {
      setInviteBusyToken(null);
    }
  };

  const handleUpdateChannelSettings = async () => {
    if (!activeChannelId || !activeChannel || !canManageChannelSubscribers) return;
    const nextTitle = window.prompt('Channel title', activeChannel.title)?.trim();
    if (!nextTitle) return;
    const nextAvatarRaw = window.prompt('Channel avatar URL (leave blank to remove)', activeChannel.avatar ?? '') ?? '';
    const nextAvatar = nextAvatarRaw.trim();
    try {
      await updateChannelSettings(activeChannelId, { title: nextTitle, avatar: nextAvatar || null });
      await db.channelThreads.update(activeChannelId, { title: nextTitle, avatar: nextAvatar || null });
      toast.success('Channel settings updated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update channel settings');
    }
  };

  const handleToggleChannelPin = async (msg: StoredMessage) => {
    if (!activeChannelId || !myPublicKey || !canPinChannelPosts) return;
    try {
      const nextPinnedMsgId = activeChannel?.pinnedMsgId === msg.msgId ? null : msg.msgId;
      await socketManager.sendChannelPin(activeChannelId, nextPinnedMsgId, myPublicKey);
      toast.success(nextPinnedMsgId ? 'Channel post pinned.' : 'Pinned channel post cleared.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update pinned channel post');
    }
  };

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }

    const handleShortcuts = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        messageSearchInputRef.current?.focus();
        messageSearchInputRef.current?.select();
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (activePeerKey) {
          const mutedUntil = activeContact?.mutedUntil && activeContact.mutedUntil > Date.now()
            ? undefined
            : Date.now() + 8 * 60 * 60 * 1000;
          void db.contacts.update(activePeerKey, { mutedUntil });
        }
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        if (activePeerKey) {
          const nextArchived = !activeContact?.archived;
          void db.contacts.update(activePeerKey, {
            archived: nextArchived,
            pinned: nextArchived ? false : activeContact?.pinned,
          }).then(() => {
            if (nextArchived) {
              setActivePeer(null);
            }
          });
        }
        return;
      }

      if (event.key === 'Escape') {
        if (messageSearch) {
          event.preventDefault();
          setMessageSearch('');
          messageInputRef.current?.focus();
          return;
        }

        event.preventDefault();
        if (activeGroupId) {
          setActiveGroup(null);
        } else if (activeChannelId) {
          setActiveChannel(null);
        } else {
          setActivePeer(null);
        }
      }
    };

    window.addEventListener('keydown', handleShortcuts);
    return () => window.removeEventListener('keydown', handleShortcuts);
  }, [activeChannelId, activeContact, activeGroupId, activePeerKey, activeThreadId, messageSearch, setActiveChannel, setActiveGroup, setActivePeer]);

  const contactName = activeContact?.name || (activePeerKey ? activePeerKey.substring(0, 8) + '...' : '');
  const isSelfCallTarget = Boolean(activePeerKey && myPublicKey && activePeerKey === myPublicKey);
  const triggerCallStart = (video: boolean) => {
    window.dispatchEvent(new CustomEvent('start_call', { detail: { video } }));
  };

  const handleInitEdit = (msg: StoredMessage) => {
    const parsed = parseRichTextMessage(msg.text);
    setEditingMsgId(msg.msgId);
    setEditingDraft(parsed.text);
    const target = document.querySelector<HTMLElement>(`[data-msg-id="${msg.msgId}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleReaction = (msg: StoredMessage, reaction: string) => {
    void handleReactToMessage(msg, reaction);
  };

  const handleReplyMessage = (msg: StoredMessage) => {
    if (msg.deletedAt) return;
    setReplyTarget(buildReplyPreview(msg));
    messageInputRef.current?.focus();
  };

  const handleForwardMessage = (msg: StoredMessage) => {
    if (!activeThreadId || msg.deletedAt) return;
    const parsed = parseRichTextMessage(msg.text);
    const preview = parsed.hasRichPayload ? parsed.text : getMessageNotificationPreview(msg.text);
    const nextValue = `Forwarded: ${preview}`;
    setDraftOverrides((current) => ({ ...current, [activeThreadId]: nextValue }));
    requestAnimationFrame(() => {
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  };

  const handleRetryDirectMessage = async (msg: StoredMessage) => {
    if (!activePeerKey || msg.senderPublicKey !== myPublicKey) return;
    try {
      await socketManager.retryDirectMessage(msg.msgId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to retry message');
    }
  };

  const handleToggleDirectPin = async (msg: StoredMessage) => {
    if (!activePeerKey || msg.deletedAt) return;
    const nextPinnedMsgId = activeContact?.pinnedMsgId === msg.msgId ? null : msg.msgId;
    await db.contacts.update(activePeerKey, { pinnedMsgId: nextPinnedMsgId });
    try {
      await socketManager.sendDirectPin(activePeerKey, nextPinnedMsgId);
    } catch {
      toast('Pinned locally. It will sync when the secure channel is live.');
    }
    toast.success(nextPinnedMsgId ? 'Message pinned.' : 'Pinned message cleared.');
  };

  const handleToggleGroupPin = async (msg: StoredMessage) => {
    if (!activeGroupId || msg.deletedAt || !canManageGroupMembers) return;
    const nextPinnedMsgId = activeGroup?.pinnedMsgId === msg.msgId ? null : msg.msgId;
    await db.groupThreads.update(activeGroupId, { pinnedMsgId: nextPinnedMsgId });
    toast.success(nextPinnedMsgId ? 'Group message pinned locally.' : 'Pinned group message cleared.');
  };

  const handleEditMessage = async (msg: StoredMessage) => {
    if ((!activePeerKey && !activeGroupId && !activeChannelId) || !myPublicKey || msg.deletedAt) return;
    if (activeChannelId && msg.senderPublicKey !== myPublicKey && activeChannel?.role !== 'owner' && activeChannel?.role !== 'admin') {
      toast.error('Only owners, admins or the original author can edit this channel post.');
      return;
    }
    const currentParsed = parseRichTextMessage(msg.text);
    const nextText = editingDraft.trim();
    if (!nextText || nextText === currentParsed.text.trim()) {
      setEditingMsgId(null);
      return;
    }
    const encodedText = encodeRichTextMessage(nextText, mentionHandleDirectory, currentParsed.replyTo);

    try {
      if (activeGroupId) {
        if (!mySecretKey) return;
        await socketManager.sendGroupEdit(activeGroupId, msg.msgId, encodedText, myPublicKey, mySecretKey);
      } else if (activeChannelId) {
        await socketManager.sendChannelEdit(activeChannelId, msg.msgId, encodedText, myPublicKey);
        if (msg.id) {
          await db.messages.update(msg.id, { editedBy: myPublicKey });
          await syncThreadStats(activeChannelId);
        }
      } else if (activePeerKey) {
        if (!mySecretKey) return;
        await socketManager.sendEdit(activePeerKey, msg.msgId, encodedText);
      }
      setEditingMsgId(null);
      setEditingDraft('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to edit message');
    }
  };

  const handleDeleteMessage = async (msg: StoredMessage) => {
    if ((!activePeerKey && !activeGroupId && !activeChannelId) || !myPublicKey || msg.deletedAt) return;
    if (activeGroupId && msg.senderPublicKey !== myPublicKey && activeGroup?.role !== 'owner' && activeGroup?.role !== 'admin') {
      toast.error('Only owners, admins or the original author can delete this group message.');
      return;
    }
    if (activeChannelId && msg.senderPublicKey !== myPublicKey && activeChannel?.role !== 'owner' && activeChannel?.role !== 'admin') {
      toast.error('Only owners, admins or the original author can delete this channel post.');
      return;
    }
    if (!window.confirm('Delete this message for both sides?')) return;

    if (activeGroupId) {
      await socketManager.sendGroupDelete(activeGroupId, msg.msgId, myPublicKey);
    } else if (activeChannelId) {
      await socketManager.sendChannelDelete(activeChannelId, msg.msgId, myPublicKey);
      if (msg.id) {
        await db.messages.update(msg.id, { deletedBy: myPublicKey });
        await syncThreadStats(activeChannelId);
      }
    } else if (activePeerKey) {
      await socketManager.sendDelete(activePeerKey, msg.msgId);
    }
  };

  const handleReactToMessage = async (msg: StoredMessage, reaction: string) => {
    if ((!activePeerKey && !activeGroupId && !activeChannelId) || msg.deletedAt || !myPublicKey) return;
    const currentReaction = normalizeReactionValue(msg.reactions?.[myPublicKey]);
    const targetReaction = normalizeReactionValue(reaction) ?? reaction;
    const nextReaction = currentReaction === targetReaction ? null : targetReaction;
    if (activeGroupId && mySecretKey) {
      await socketManager.sendGroupReaction(activeGroupId, msg.msgId, nextReaction, myPublicKey, mySecretKey);
    } else if (activeChannelId) {
      await socketManager.sendChannelReaction(activeChannelId, msg.msgId, nextReaction, myPublicKey);
    } else if (activePeerKey) {
      await socketManager.sendReaction(activePeerKey, msg.msgId, nextReaction);
    }
  };

  const connectionLabel = connectionStatus === 'connected'
    ? 'Secure channel live'
    : connectionStatus === 'connecting'
      ? 'Connecting secure channel...'
      : connectionStatus === 'reconnecting'
        ? 'Reconnecting... messages may be delayed'
        : 'Offline';

  const connectionTone = connectionStatus === 'connected'
    ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
    : connectionStatus === 'offline'
      ? 'border-red-400/20 bg-red-400/10 text-red-200'
      : 'border-amber-400/20 bg-amber-400/10 text-amber-100';
  const activeCollectionSync = activeGroupId ? groupSyncStatus : activeChannelId ? channelSyncStatus : null;
  const isIdentityVerified = Boolean(
    activeContact?.verifiedIdentityFingerprint &&
    activePeerFingerprint &&
    activeContact.verifiedIdentityFingerprint === activePeerFingerprint
  );
  const hasIdentityKeyMismatch = Boolean(
    activeContact?.verifiedIdentityFingerprint &&
    activePeerFingerprint &&
    activeContact.verifiedIdentityFingerprint !== activePeerFingerprint
  );

  return (
    <div className="messk-shell app-shell-height flex overflow-hidden">
      <Sidebar />
      <CallOverlay />
      {isRoomSettingsOpen && (activeGroup || activeChannel) ? (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur">
          <div className="w-full max-w-xl rounded-3xl border border-white/15 bg-slate-900/95 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="text-lg font-semibold text-white">
                {activeGroup ? 'Group settings' : 'Channel settings'}
              </div>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-xl border border-white/15 p-2 text-white/80 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-3 gap-2">
              {(['general', 'members', 'roles', 'invites', 'moderation', 'danger'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setRoomSettingsTab(tab)}
                  className={`rounded-xl border px-2 py-1.5 text-xs font-medium transition-all ${
                    roomSettingsTab === tab
                      ? 'border-accent/50 bg-accent/20 text-white'
                      : 'border-white/10 bg-white/5 text-text-muted hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="space-y-3 max-h-[62vh] overflow-y-auto custom-scrollbar pr-1">
              {roomSettingsTab === 'general' ? (
                <>
                  {activeGroup && canManageGroupMembers ? (
                    <>
                      <button type="button" onClick={() => void handleUpdateGroupSettings()} className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-left text-sm text-white">
                        Change title/avatar
                      </button>
                      <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-xs text-text-muted">
                        Role: <span className="text-white">{activeGroup.role}</span>
                      </div>
                    </>
                  ) : null}
                  {activeChannel && canManageChannelSubscribers ? (
                    <>
                      <button type="button" onClick={() => void handleUpdateChannelSettings()} className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-left text-sm text-white">
                        Change title/avatar
                      </button>
                      <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-xs text-text-muted">
                        Role: <span className="text-white">{activeChannel.role}</span>
                      </div>
                    </>
                  ) : null}
                </>
              ) : null}

              {roomSettingsTab === 'members' ? (
                <>
                  {activeGroup && canManageGroupMembers ? displayedGroupMembers.map((member) => (
                    <div key={member.memberPubKey} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-white truncate">{resolveParticipantName(member.memberPubKey)}</div>
                        <div className="text-xs text-text-muted">{member.memberPubKey === myPublicKey ? activeGroup.role : member.role}</div>
                      </div>
                      {member.memberPubKey !== myPublicKey && member.role !== 'owner' ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(activeGroup.role === 'owner' || (activeGroup.role === 'admin' && member.role === 'member')) ? (
                            <button type="button" onClick={() => void handleRemoveMember(member.memberPubKey)} className="rounded-lg border border-red-400/30 bg-red-400/10 px-2 py-1 text-xs text-red-100">Remove</button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )) : null}
                  {activeChannel && canManageChannelSubscribers ? displayedChannelSubscribers.map((subscriber) => (
                    <div key={subscriber.subscriberPubKey} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-white truncate">{resolveParticipantName(subscriber.subscriberPubKey)}</div>
                        <div className="text-xs text-text-muted">{subscriber.role}</div>
                      </div>
                      {subscriber.subscriberPubKey !== myPublicKey && subscriber.role !== 'owner' ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(activeChannel.role === 'owner' || (activeChannel.role === 'admin' && subscriber.role !== 'admin')) ? (
                            <button type="button" onClick={() => void handleRemoveChannelSubscriber(subscriber.subscriberPubKey)} className="rounded-lg border border-red-400/30 bg-red-400/10 px-2 py-1 text-xs text-red-100">Remove</button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )) : null}
                </>
              ) : null}

              {roomSettingsTab === 'roles' ? (
                <>
                  {activeGroup && canManageGroupMembers ? displayedGroupMembers.map((member) => (
                    <div key={`role:${member.memberPubKey}`} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className="mb-2 text-sm text-white truncate">{resolveParticipantName(member.memberPubKey)}</div>
                      {member.memberPubKey !== myPublicKey && member.role !== 'owner' && activeGroup.role === 'owner' ? (
                        <div className="flex flex-wrap gap-2">
                          {member.role === 'admin'
                            ? <button type="button" onClick={() => void handleDemoteMember(member.memberPubKey)} className="rounded-lg border border-white/20 px-2 py-1 text-xs text-white">Demote</button>
                            : <button type="button" onClick={() => void handlePromoteMember(member.memberPubKey)} className="rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-white">Promote admin</button>}
                          <button type="button" onClick={() => void handleTransferOwnership(member.memberPubKey)} className="rounded-lg border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-xs text-amber-100">Transfer owner</button>
                        </div>
                      ) : null}
                    </div>
                  )) : null}
                  {activeChannel && canManageChannelSubscribers ? displayedChannelSubscribers.map((subscriber) => (
                    <div key={`role:${subscriber.subscriberPubKey}`} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className="mb-2 text-sm text-white truncate">{resolveParticipantName(subscriber.subscriberPubKey)}</div>
                      {subscriber.subscriberPubKey !== myPublicKey && subscriber.role !== 'owner' && activeChannel.role === 'owner' ? (
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => void handleUpdateChannelRole(subscriber.subscriberPubKey, 'admin', 'Subscriber promoted to admin.')} className="rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-white">Make admin</button>
                          <button type="button" onClick={() => void handleUpdateChannelRole(subscriber.subscriberPubKey, 'poster', 'Subscriber can now post to the channel.')} className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2 py-1 text-xs text-cyan-100">Make poster</button>
                          <button type="button" onClick={() => void handleTransferChannelOwner(subscriber.subscriberPubKey)} className="rounded-lg border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-xs text-amber-100">Transfer owner</button>
                        </div>
                      ) : null}
                    </div>
                  )) : null}
                </>
              ) : null}

              {roomSettingsTab === 'invites' ? (
                <>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-text-muted">Invite settings</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <label className="text-xs text-text-muted">
                        TTL (minutes)
                        <input value={inviteTTLMinutes} onChange={(event) => setInviteTTLMinutes(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-slate-900/70 px-2 py-1 text-sm text-white" placeholder="0 = no expiry" />
                      </label>
                      <label className="text-xs text-text-muted">
                        Max uses
                        <input value={inviteMaxUses} onChange={(event) => setInviteMaxUses(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-slate-900/70 px-2 py-1 text-sm text-white" placeholder="0 = unlimited" />
                      </label>
                      <label className="text-xs text-text-muted">
                        Password
                        <input value={invitePassword} onChange={(event) => setInvitePassword(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-slate-900/70 px-2 py-1 text-sm text-white" placeholder="optional" />
                      </label>
                    </div>
                  </div>
                  {activeGroup && canManageGroupMembers ? (
                    <button type="button" onClick={() => void handleCopyGroupInviteLink()} className="w-full rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-left text-sm text-white">Copy group invite link</button>
                  ) : null}
                  {activeChannel && canManageChannelSubscribers ? (
                    <button type="button" onClick={() => void handleCopyChannelInviteLink()} className="w-full rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-left text-sm text-white">Copy channel invite link</button>
                  ) : null}
                  <div className="space-y-2">
                    {inviteLinks.map((link) => (
                      <div key={link.token} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                        <div className="text-xs text-white break-all">{link.token}</div>
                        <div className="mt-1 text-[11px] text-text-muted">
                          uses: {link.usesCount}{link.maxUses ? `/${link.maxUses}` : ''} • {link.expiresAt ? `expires ${new Date(link.expiresAt).toLocaleString()}` : 'no expiry'} • {link.hasPassword ? 'password' : 'no password'} • {link.revoked ? 'revoked' : 'active'}
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button type="button" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/?invite=${encodeURIComponent(link.token)}`)} className="rounded-lg border border-white/20 px-2 py-1 text-xs text-white">Copy</button>
                          <button type="button" disabled={inviteBusyToken === link.token || link.revoked} onClick={() => void handleRevokeInvite(link.token)} className="rounded-lg border border-red-400/30 bg-red-400/10 px-2 py-1 text-xs text-red-100 disabled:opacity-60">Revoke</button>
                        </div>
                      </div>
                    ))}
                    {inviteLinks.length === 0 ? (
                      <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-xs text-text-muted">No invite links created yet.</div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {roomSettingsTab === 'moderation' ? (
                <>
                  {moderationEntries.length ? moderationEntries.map((entry) => (
                    <div key={entry.id} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className="text-sm text-white">
                        {resolveParticipantName(entry.actorPubKey)}: {entry.action}
                      </div>
                      <div className="mt-1 text-xs text-text-muted">
                        {entry.target ? `target ${entry.target.substring(0, 10)}...` : 'no target'}
                        {entry.details ? ` • ${entry.details}` : ''}
                      </div>
                    </div>
                  )) : (
                    <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-sm text-text-muted">
                      No moderation events yet.
                    </div>
                  )}
                </>
              ) : null}

              {roomSettingsTab === 'danger' ? (
                <>
                  {activeGroup ? (
                    <button type="button" onClick={() => void handleLeaveGroup()} className="w-full rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-left text-sm text-red-100">
                      {activeGroup.role === 'owner' ? 'Delete group' : 'Leave group'}
                    </button>
                  ) : null}
                  {activeChannel ? (
                    <button type="button" onClick={() => void handleLeaveChannel()} className="w-full rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-left text-sm text-red-100">
                      {activeChannel.role === 'owner' ? 'Delete channel' : 'Leave channel'}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className={`
        ${activePeerKey || activeGroupId || activeChannelId ? 'flex' : 'hidden md:flex'}
        chat-stage w-full flex-col flex-1 relative
      `}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFile ? (
          <div className="pointer-events-none absolute inset-4 z-[90] flex items-center justify-center rounded-3xl border-2 border-dashed border-accent/60 bg-slate-950/70 text-sm font-semibold text-white shadow-2xl backdrop-blur">
            Drop file to send
          </div>
        ) : null}
        {activePeerKey ? (
          <>
            <header className="chat-header premium-glass z-20 flex min-h-20 flex-shrink-0 items-center justify-between border-b border-white/5 px-4 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                <button
                  className="md:hidden p-2 -ml-2 text-text-muted hover:text-white"
                  onClick={() => setActivePeer(null)}
                >
                  <ArrowLeft className="w-6 h-6" />
                </button>
                <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                  <div className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 text-white shadow-xl group sm:h-12 sm:w-12">
                    <div className="absolute inset-0 shimmer-bg opacity-30 group-hover:opacity-50 transition-opacity" />
                    {contactAvatar ? (
                      <img
                        src={contactAvatar}
                        alt={contactName}
                        className="relative z-10 h-full w-full object-cover"
                      />
                    ) : (
                      <span className="font-bold text-lg relative z-10">{contactName.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-white truncate">{contactName}</h2>
                    {activePeerKey && typingStatus[activePeerKey] ? (
                      <p className="text-[11px] text-accent font-medium opacity-80">typing...</p>
                    ) : (
                      <p className="text-[11px] text-accent font-medium flex items-center gap-1 opacity-80">
                        <ShieldCheck className="w-3.5 h-3.5" /> E2EE Secure
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-2">
                      {activePeerFingerprint ? (
                        <span className="rounded-full border border-white/15 bg-black/20 px-2 py-0.5 text-[10px] font-medium text-text-muted">
                          FP: {activePeerFingerprint.slice(0, 19)}...
                        </span>
                      ) : null}
                      {isIdentityVerified ? (
                        <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
                          Identity verified
                        </span>
                      ) : null}
                      {isChatMuted ? (
                        <span className="rounded-full border border-blue-300/20 bg-blue-300/10 px-2 py-0.5 text-[10px] font-medium text-blue-200">
                          Muted for 8 hours
                        </span>
                      ) : null}
                      {activeContact?.archived ? (
                        <span className="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                          Archived
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
              <div className="ml-3 flex items-center gap-1 sm:gap-2">
                <button
                  type="button"
                  onClick={() => setMentionFilterActive((prev) => !prev)}
                  className={`hidden xl:flex items-center justify-center rounded-xl p-2 transition-all ${
                    mentionFilterActive 
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' 
                      : 'text-text-muted hover:bg-white/5 hover:text-white border border-transparent'
                  }`}
                  title="Filter messages mentioning me"
                  aria-label="Filter messages mentioning me"
                >
                  <AtSign className="w-5 h-5" />
                </button>
                <div className="relative hidden xl:block">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <input
                    type="text"
                    ref={messageSearchInputRef}
                    value={messageSearch}
                    onChange={(e) => setMessageSearch(e.target.value)}
                    placeholder="Search messages..."
                    className="w-56 rounded-xl border border-white/10 bg-white/5 py-2 pl-9 pr-9 text-sm outline-none transition-all focus:border-accent/40 focus:bg-white/10"
                    aria-label="Search messages in this chat"
                  />
                  {messageSearch ? (
                    <button
                      type="button"
                      onClick={() => setMessageSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-text-muted hover:bg-white/10 hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={isSelfCallTarget}
                  onClick={() => triggerCallStart(false)}
                  className={`rounded-xl p-2 transition-all sm:p-2.5 ${
                    isSelfCallTarget
                      ? 'cursor-not-allowed text-text-muted/40'
                      : 'text-text-muted hover:bg-white/5 hover:text-white'
                  }`}
                  aria-label="Start voice call"
                  title={isSelfCallTarget ? 'You cannot call your own identity on the same device' : 'Start voice call'}
                >
                  <Phone className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  disabled={isSelfCallTarget}
                  onClick={() => triggerCallStart(true)}
                  className={`rounded-xl p-2 transition-all sm:p-2.5 ${
                    isSelfCallTarget
                      ? 'cursor-not-allowed text-text-muted/40'
                      : 'text-text-muted hover:bg-white/5 hover:text-white'
                  }`}
                  aria-label="Start video call"
                  title={isSelfCallTarget ? 'You cannot call your own identity on the same device' : 'Start video call'}
                >
                  <Video className="w-5 h-5" />
                </button>
                <button
                  onClick={isIdentityVerified ? handleClearIdentityVerification : handleVerifyIdentity}
                  className={`rounded-xl p-2 transition-all sm:p-2.5 ${
                    isIdentityVerified
                      ? 'text-emerald-200 hover:bg-emerald-300/10 hover:text-emerald-100'
                      : 'text-text-muted hover:bg-white/5 hover:text-white'
                  }`}
                  title={isIdentityVerified ? 'Remove key verification' : 'Mark current contact key as verified'}
                  aria-label={isIdentityVerified ? 'Remove key verification' : 'Mark contact key as verified'}
                >
                  <ShieldCheck className="w-5 h-5" />
                </button>
                <button
                  onClick={handleToggleMute}
                  className="rounded-xl p-2 text-text-muted transition-all hover:bg-white/5 hover:text-white sm:p-2.5"
                  title={isChatMuted ? 'Unmute chat' : 'Mute chat for 8 hours'}
                  aria-label={isChatMuted ? 'Unmute chat' : 'Mute chat for 8 hours'}
                >
                  {isChatMuted ? (
                    <Bell className="w-5 h-5 text-blue-200" />
                  ) : (
                    <BellOff className="w-5 h-5" />
                  )}
                </button>
                <button
                  onClick={handleToggleArchive}
                  className="rounded-xl p-2 text-text-muted transition-all hover:bg-white/5 hover:text-white sm:p-2.5"
                  title={activeContact?.archived ? 'Restore chat' : 'Archive chat'}
                  aria-label={activeContact?.archived ? 'Restore chat' : 'Archive chat'}
                >
                  <Archive className={`w-5 h-5 ${activeContact?.archived ? 'text-accent' : ''}`} />
                </button>
                <div className="mx-1 hidden h-6 w-px bg-white/10 sm:mx-2 sm:block" />
                <button
                  onClick={handleClearChat}
                  className="hidden rounded-xl p-2 text-text-muted transition-all hover:bg-red-400/10 hover:text-red-400 sm:block sm:p-2.5"
                  title="Clear Chat"
                  aria-label="Clear chat"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </header>

            {connectionStatus !== 'connected' ? (
              <div className={`mx-4 mt-3 rounded-2xl border px-4 py-3 text-sm sm:mx-6 sm:mt-4 ${connectionTone}`}>
                {connectionLabel}
              </div>
            ) : null}

            {hasIdentityKeyMismatch ? (
              <div className="mx-4 mt-3 rounded-2xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100 sm:mx-6 sm:mt-4">
                <div className="font-medium">Contact key changed</div>
                <div className="mt-1 text-xs text-red-100/75">
                  Safety number no longer matches your verified fingerprint. Re-check the contact before trusting new messages.
                </div>
              </div>
            ) : null}

            {(queuedDirectMessages?.length ?? 0) > 0 ? (
              <div className="mx-4 mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100 sm:mx-6 sm:mt-4">
                <div className="flex items-center gap-2 font-medium">
                  {connectionStatus === 'connected' ? <Clock3 className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                  {queuedDirectMessages?.length} message{queuedDirectMessages?.length === 1 ? '' : 's'} waiting for delivery
                </div>
                <div className="mt-1 text-xs text-amber-100/75">
                  Stored locally and on retry queue. Attempts: {queuedDirectMessages?.reduce((total, item) => total + item.attempts, 0) ?? 0}.
                </div>
              </div>
            ) : null}

            {pinnedDirectMessage && !pinnedDirectMessage.deletedAt ? (
              <div className="mx-4 mt-3 rounded-2xl border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-white sm:mx-6 sm:mt-4">
                <div className="flex items-center gap-2 font-medium">
                  <Pin className="h-4 w-4" />
                  Pinned message
                </div>
                <div className="mt-1 truncate text-xs text-white/75">{getThreadMessagePreview(pinnedDirectMessage)}</div>
              </div>
            ) : null}

            <div
              ref={messageListRef}
              className="message-list flex-1 overflow-y-auto bg-black/10 p-3 space-y-4 custom-scrollbar sm:p-6 sm:space-y-6"
              role="log"
              aria-live="polite"
              aria-label={`Messages with ${contactName}`}
            >
              {hasHiddenMessages ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={handleLoadOlderMessages}
                    className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-text-muted transition-all hover:border-white/20 hover:text-white"
                  >
                    Load older messages
                  </button>
                </div>
              ) : null}
              {!messages ? (
                <div className="space-y-4">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div
                      key={index}
                      className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'} animate-pulse`}
                    >
                      <div className="max-w-[70%] rounded-3xl border border-white/5 bg-white/5 px-4 py-3">
                        <div className="h-3.5 w-40 rounded-full bg-white/10" />
                        <div className="mt-2 h-3.5 w-24 rounded-full bg-white/5" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : messages.length === 0 ? (
                <div className="empty-thread-card h-full flex flex-col items-center justify-center text-center">
                  <ShieldCheck className="w-16 h-16 mb-4 text-accent" />
                  <h3 className="text-lg font-medium">New Secure Session</h3>
                  <p className="text-sm max-w-[240px] mt-1">Messages are encrypted before leaving your device.</p>
                </div>
              ) : filteredMessages?.length === 0 ? (
                <div className="empty-thread-card h-full flex flex-col items-center justify-center text-center">
                  <Search className="w-14 h-14 mb-4 text-accent" />
                  <h3 className="text-lg font-medium">No Matches</h3>
                  <p className="text-sm max-w-[260px] mt-1">No messages match "{messageSearch}".</p>
                </div>
              ) : (
                visibleMessages?.map((msg) => (
                  <React.Fragment key={msg.msgId}>
                    {firstUnreadMessageId === msg.msgId ? (
                      <div className="sticky top-2 z-10 flex justify-center">
                        <div className="rounded-full border border-accent/30 bg-slate-950/85 px-3 py-1 text-xs font-medium text-accent shadow-lg backdrop-blur">
                          New messages
                        </div>
                      </div>
                    ) : null}
                    <div data-msg-id={msg.msgId}>
                      <MessageBubble
                        msg={msg}
                        isMine={msg.senderPublicKey === myPublicKey}
                        isGroupMessage={Boolean(activeGroupId)}
                        downloadFile={downloadFile}
                        onEdit={handleInitEdit}
                        onDelete={handleDeleteMessage}
                        onReact={handleReaction}
                        onReply={handleReplyMessage}
                        onForward={handleForwardMessage}
                        onRetry={handleRetryDirectMessage}
                        canPin
                        isPinned={activeContact?.pinnedMsgId === msg.msgId}
                        onPin={handleToggleDirectPin}
                        onMentionClick={handleMentionClick}
                        isEditing={editingMsgId === msg.msgId}
                        editDraft={editingDraft}
                        onEditDraftChange={setEditingDraft}
                        onEditSave={() => void handleEditMessage(msg)}
                        onEditCancel={() => { setEditingMsgId(null); setEditingDraft(''); }}
                        retryDetails={queuedDirectById.get(msg.msgId) ? `Attempts: ${queuedDirectById.get(msg.msgId)?.attempts ?? 0}` : undefined}
                      />
                    </div>
                  </React.Fragment>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={jumpToFirstUnread}
                className="absolute bottom-24 right-4 z-20 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-slate-950/90 px-4 py-2 text-sm font-medium text-white shadow-xl backdrop-blur transition-all hover:border-accent/50 hover:bg-slate-900 sm:bottom-28 sm:right-6"
                aria-label={`Jump to ${unreadCount} unread messages`}
              >
                <ArrowDownCircle className="h-4 w-4 text-accent" />
                {unreadCount} unread
              </button>
            ) : null}

            <div className="chat-composer premium-glass border-t border-white/5 bg-transparent p-3 sm:p-6">
              <ChatComposer
                onSubmit={handleSendMessage}
                onSubmitShortcut={submitCurrentMessage}
                fileInputRef={fileInputRef}
                onFileChange={handleFileChange}
                isUploading={isUploading}
                messageInputRef={messageInputRef}
                messageInput={messageInput}
                onMessageChange={handleComposerChange}
                onTypingChange={handleDirectTyping}
                placeholder="Message..."
                inputAriaLabel="Message input"
                onTextareaKeyDown={handleComposerKeyDown}
                mentionSuggestions={mentionSuggestions}
                mentionSelectionIndex={mentionSelectionIndex}
                isMentionMenuOpen={isMentionMenuOpen}
                onMentionSelect={applyMentionSuggestion}
                isRecording={isRecording}
                onToggleRecording={() => void (isRecording ? stopRecording() : startRecording())}
                attachAriaLabel="Attach file"
                sendAriaLabel="Send message"
                replyTarget={replyTarget}
                onCancelReply={() => setReplyTarget(null)}
              />
            </div>
          </>
        ) : activeGroup ? (
          <>
            <header className="chat-header premium-glass z-20 flex min-h-20 flex-shrink-0 items-center justify-between border-b border-white/5 px-4 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                <button
                  className="md:hidden p-2 -ml-2 text-text-muted hover:text-white"
                  onClick={() => setActiveGroup(null)}
                >
                  <ArrowLeft className="w-6 h-6" />
                </button>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-400/20 to-white/5 border border-white/10 flex items-center justify-center text-white shadow-xl relative overflow-hidden">
                    {activeGroup.avatar ? (
                      <img src={activeGroup.avatar} alt={activeGroup.title} className="h-full w-full object-cover" />
                    ) : (
                      <span className="font-bold text-lg">{activeGroup.title.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-white truncate">{activeGroup.title}</h2>
                    <p className="text-[11px] text-accent font-medium flex items-center gap-1 opacity-80">
                      <Users className="w-3.5 h-3.5" /> {(Number.isFinite(activeGroup.memberCount) ? activeGroup.memberCount : activeGroupMembers.length)} members
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canViewGroupMembers ? (
                  <button
                    type="button"
                    onClick={() => navigate('/room-settings')}
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Room settings
                  </button>
                ) : null}
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100">
                  <Crown className="h-3.5 w-3.5" />
                  {activeGroup?.role}
                </div>
              </div>
            </header>

            <div className="grid flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-h-0 flex-col">
                {activeGroupId && (queuedGroupEvents?.length ?? 0) > 0 ? (
                  <div className="mx-4 mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100 sm:mx-6 sm:mt-4">
                    <div className="flex items-center gap-2 font-medium">
                      {connectionStatus === 'connected' ? <Clock3 className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                      {queuedGroupEvents?.length} queued group event{queuedGroupEvents?.length === 1 ? '' : 's'}
                    </div>
                    <div className="mt-1 text-xs text-amber-100/75">
                      {connectionStatus === 'connected'
                        ? 'Messages are waiting for secure resend and should flush shortly.'
                        : 'Connection is unstable. Group changes will send automatically after reconnect.'}
                    </div>
                  </div>
                ) : null}
                {pinnedGroupMessage && !pinnedGroupMessage.deletedAt ? (
                  <div className="mx-4 mt-3 rounded-2xl border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-white sm:mx-6 sm:mt-4">
                    <div className="flex items-center gap-2 font-medium">
                      <Pin className="h-4 w-4" />
                      Pinned group message
                    </div>
                    <div className="mt-1 truncate text-xs text-white/75">{getThreadMessagePreview(pinnedGroupMessage)}</div>
                  </div>
                ) : null}
                {activeCollectionSync && activeCollectionSync.state !== 'synced' ? (
                  <div className={`mx-4 mt-3 rounded-2xl border px-4 py-3 text-sm sm:mx-6 sm:mt-4 ${
                    activeCollectionSync.state === 'error'
                      ? 'border-red-400/20 bg-red-400/10 text-red-100'
                      : 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                  }`}>
                    <div className="font-medium">
                      {activeCollectionSync.state === 'syncing'
                        ? activeGroupId
                          ? 'Syncing group members and room state...'
                          : 'Syncing channel subscribers and publishing state...'
                        : activeCollectionSync.error || 'Sync status requires attention'}
                    </div>
                    <div className="mt-1 text-xs opacity-80">
                      {activeCollectionSync.state === 'syncing'
                        ? 'You can keep reading the current thread while metadata catches up.'
                        : 'Try refresh after reconnect. If this repeats before release, it should be treated as a blocker.'}
                    </div>
                  </div>
                ) : null}
                <div
                  ref={messageListRef}
                  className="message-list flex-1 overflow-y-auto bg-black/10 p-3 space-y-4 custom-scrollbar sm:p-6 sm:space-y-6"
                  role="log"
                  aria-live="polite"
                  aria-label={`Messages in ${activeGroup.title}`}
                >
                  {hasHiddenMessages ? (
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={handleLoadOlderMessages}
                        className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-text-muted transition-all hover:border-white/20 hover:text-white"
                      >
                        Load older messages
                      </button>
                    </div>
                  ) : null}
                  {messages?.length ? (
                    visibleMessages?.map((msg) => (
                      <React.Fragment key={msg.msgId}>
                        {firstUnreadMessageId === msg.msgId ? (
                          <div className="sticky top-2 z-10 flex justify-center">
                            <div className="rounded-full border border-accent/30 bg-slate-950/85 px-3 py-1 text-xs font-medium text-accent shadow-lg backdrop-blur">
                              New messages
                            </div>
                          </div>
                        ) : null}
                    <div data-msg-id={msg.msgId}>
                        <div className="mb-2 text-xs font-semibold text-text-muted">
                          {resolveParticipantName(msg.senderPublicKey)}
                        </div>
                        <MessageBubble
                          msg={msg}
                          isMine={msg.senderPublicKey === myPublicKey}
                          isGroupMessage
                          downloadFile={downloadFile}
                          onEdit={handleInitEdit}
                          onDelete={handleDeleteMessage}
                          onReact={handleReaction}
                          onReply={handleReplyMessage}
                          onForward={handleForwardMessage}
                          canModerate={activeGroup?.role === 'owner' || activeGroup?.role === 'admin'}
                          canPin={canManageGroupMembers}
                          isPinned={activeGroup?.pinnedMsgId === msg.msgId}
                          onPin={handleToggleGroupPin}
                          onMentionClick={handleMentionClick}
                          isEditing={editingMsgId === msg.msgId}
                          editDraft={editingDraft}
                          onEditDraftChange={setEditingDraft}
                          onEditSave={() => void handleEditMessage(msg)}
                          onEditCancel={() => { setEditingMsgId(null); setEditingDraft(''); }}
                        />
                        </div>
                      </React.Fragment>
                    ))
                  ) : (
                    <div className="empty-thread-card h-full flex flex-col items-center justify-center text-center">
                      <Users className="w-16 h-16 mb-4 text-accent" />
                      <h3 className="text-lg font-medium">Group is ready</h3>
                      <p className="text-sm max-w-[280px] mt-1">Send the first message and bring the whole team into one room.</p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="chat-composer premium-glass border-t border-white/5 bg-transparent p-3 sm:p-6">
                  <ChatComposer
                    onSubmit={handleSendMessage}
                    onSubmitShortcut={submitCurrentMessage}
                    fileInputRef={fileInputRef}
                    onFileChange={handleFileChange}
                    isUploading={isUploading}
                    messageInputRef={messageInputRef}
                    messageInput={messageInput}
                    onMessageChange={handleComposerChange}
                    placeholder="Message the group..."
                    inputAriaLabel="Group message input"
                    onTextareaKeyDown={handleComposerKeyDown}
                    mentionSuggestions={mentionSuggestions}
                    mentionSelectionIndex={mentionSelectionIndex}
                    isMentionMenuOpen={isMentionMenuOpen}
                    onMentionSelect={applyMentionSuggestion}
                    isRecording={isRecording}
                    onToggleRecording={() => void (isRecording ? stopRecording() : startRecording())}
                    attachAriaLabel="Attach file to group"
                    sendAriaLabel="Send group message"
                    replyTarget={replyTarget}
                    onCancelReply={() => setReplyTarget(null)}
                  />
                </div>
              </div>

              {canViewGroupMembers ? (
              <aside className="hidden border-l border-white/5 bg-white/[0.02] p-5 lg:flex lg:flex-col">
                <div className="text-sm font-semibold uppercase tracking-[0.22em] text-text-muted">Members</div>
                {canManageGroupMembers ? (
                  <form onSubmit={handleAddGroupMember} className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-medium text-white">Invite member</div>
                      <button
                        type="button"
                        onClick={() => void handleCopyGroupInviteLink()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-white transition-all hover:border-accent/45 hover:bg-accent/20"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        Copy link
                      </button>
                    </div>
                    <input
                      value={groupMemberInput}
                      onChange={(e) => setGroupMemberInput(e.target.value)}
                      placeholder="Paste public key"
                      className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none transition-all focus:border-accent/40"
                    />
                    <button
                      type="submit"
                      disabled={isAddingMember || !groupMemberInput.trim()}
                      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-medium text-white transition-all hover:border-accent/50 hover:bg-accent/20 disabled:opacity-50"
                    >
                      <UserPlus className="h-4 w-4" />
                      {isAddingMember ? 'Adding...' : 'Add member'}
                    </button>
                  </form>
                ) : null}
                <div className="mt-4 space-y-3 overflow-y-auto custom-scrollbar">
                  {displayedGroupMembers.map((member) => (
                    <div key={member.memberPubKey} className="rounded-2xl border border-white/10 bg-black/10 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10 text-sm font-bold text-white">
                            {member.memberPubKey.substring(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white truncate">{resolveParticipantName(member.memberPubKey)}</div>
                            <div className="text-xs text-text-muted">Group member</div>
                          </div>
                        </div>
                        <div className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-text-muted">
                          {member.memberPubKey === myPublicKey ? activeGroup?.role : member.role}
                        </div>
                      </div>
                      {(isRoomSettingsOpen && canManageGroupMembers) ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {activeGroup?.role === 'owner' ? (
                            <>
                              {member.role === 'admin' ? (
                                <button
                                  type="button"
                                  onClick={() => void handleDemoteMember(member.memberPubKey)}
                                  disabled={memberActionPubKey === member.memberPubKey}
                                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-text-muted transition-all hover:border-white/20 hover:text-white disabled:opacity-50"
                                >
                                  <Shield className="h-3.5 w-3.5" />
                                  Demote to member
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handlePromoteMember(member.memberPubKey)}
                                  disabled={memberActionPubKey === member.memberPubKey}
                                  className="inline-flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-white transition-all hover:border-accent/50 hover:bg-accent/20 disabled:opacity-50"
                                >
                                  <Shield className="h-3.5 w-3.5" />
                                  Promote to admin
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleTransferOwnership(member.memberPubKey)}
                                disabled={memberActionPubKey === member.memberPubKey}
                                className="inline-flex items-center gap-2 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100 transition-all hover:border-amber-300/35 hover:bg-amber-300/15 disabled:opacity-50"
                              >
                                <Crown className="h-3.5 w-3.5" />
                                Transfer ownership
                              </button>
                            </>
                          ) : null}
                          {(activeGroup?.role === 'owner' || (activeGroup?.role === 'admin' && member.role === 'member')) ? (
                            <button
                              type="button"
                              onClick={() => void handleRemoveMember(member.memberPubKey)}
                              disabled={memberActionPubKey === member.memberPubKey}
                              className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200 transition-all hover:border-red-400/35 hover:bg-red-400/15 disabled:opacity-50"
                            >
                              <UserMinus className="h-3.5 w-3.5" />
                              Remove
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </aside>
              ) : null}
            </div>
          </>
        ) : activeChannel ? (
          <>
            <header className="chat-header premium-glass z-20 flex min-h-20 flex-shrink-0 items-center justify-between border-b border-white/5 px-4 py-3 sm:px-6">
              <div className="flex items-center gap-4">
                <button
                  className="md:hidden p-2 -ml-2 text-text-muted hover:text-white"
                  onClick={() => setActiveChannel(null)}
                >
                  <ArrowLeft className="w-6 h-6" />
                </button>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent/20 to-white/5 border border-white/10 flex items-center justify-center text-white shadow-xl relative overflow-hidden">
                    {activeChannel.avatar ? (
                      <img src={activeChannel.avatar} alt={activeChannel.title} className="h-full w-full object-cover" />
                    ) : (
                      <span className="font-bold text-lg">{activeChannel.title.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-white truncate">{activeChannel.title}</h2>
                    <p className="text-[11px] text-accent font-medium flex items-center gap-1 opacity-80">
                      <Megaphone className="w-3.5 h-3.5" /> {activeChannel.subscriberCount} subscribers
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canManageChannelSubscribers || canViewChannelSubscribers ? (
                  <button
                    type="button"
                    onClick={() => navigate('/room-settings')}
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Room settings
                  </button>
                ) : null}
                <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1.5 text-xs font-medium text-white">
                  <Crown className="h-3.5 w-3.5" />
                  {activeChannel?.role}
                </div>
              </div>
            </header>

            <div className="grid flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-h-0 flex-col">
                {pinnedChannelMessage && !pinnedChannelMessage.deletedAt ? (
                  <div className="mx-6 mt-4 rounded-2xl border border-accent/20 bg-accent/10 px-4 py-3 text-sm text-white">
                    <div className="flex items-center gap-2 font-medium">
                      <Pin className="h-4 w-4" />
                      Pinned post
                    </div>
                    <div className="mt-1 text-xs text-white/80">
                      {getThreadMessagePreview(pinnedChannelMessage)}
                    </div>
                  </div>
                ) : null}
                <div
                  ref={messageListRef}
                  className="message-list flex-1 overflow-y-auto bg-black/10 p-3 space-y-4 custom-scrollbar sm:p-6 sm:space-y-6"
                  role="log"
                  aria-live="polite"
                  aria-label={`Posts in ${activeChannel.title}`}
                >
                  {hasHiddenMessages ? (
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={handleLoadOlderMessages}
                        className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-text-muted transition-all hover:border-white/20 hover:text-white"
                      >
                        Load older posts
                      </button>
                    </div>
                  ) : null}
                  {messages?.length ? (
                    visibleMessages?.map((msg) => (
                      <React.Fragment key={msg.msgId}>
                        {firstUnreadMessageId === msg.msgId ? (
                          <div className="sticky top-2 z-10 flex justify-center">
                            <div className="rounded-full border border-accent/30 bg-slate-950/85 px-3 py-1 text-xs font-medium text-white shadow-lg backdrop-blur">
                              New posts
                            </div>
                          </div>
                        ) : null}
                        <div data-msg-id={msg.msgId}>
                          <div className="mb-2 text-xs font-semibold text-text-muted">
                            {resolveParticipantName(msg.senderPublicKey)}
                          </div>
                          <MessageBubble
                            msg={msg}
                            isMine={msg.senderPublicKey === myPublicKey}
                            isGroupMessage
                            downloadFile={downloadFile}
                            onEdit={handleInitEdit}
                            onDelete={handleDeleteMessage}
                            onReact={handleReaction}
                            onReply={handleReplyMessage}
                            onForward={handleForwardMessage}
                            canModerate={activeChannel?.role === 'owner' || activeChannel?.role === 'admin'}
                            canPin={canPinChannelPosts}
                            isPinned={activeChannel?.pinnedMsgId === msg.msgId}
                            onPin={handleToggleChannelPin}
                            onMentionClick={handleMentionClick}
                            isEditing={editingMsgId === msg.msgId}
                            editDraft={editingDraft}
                            onEditDraftChange={setEditingDraft}
                            onEditSave={() => void handleEditMessage(msg)}
                            onEditCancel={() => { setEditingMsgId(null); setEditingDraft(''); }}
                          />
                        </div>
                      </React.Fragment>
                    ))
                  ) : (
                    <div className="empty-thread-card h-full flex flex-col items-center justify-center text-center">
                      <Megaphone className="w-16 h-16 mb-4 text-accent" />
                      <h3 className="text-lg font-medium">Channel is ready</h3>
                      <p className="text-sm max-w-[320px] mt-1">
                        {canPostInChannel
                          ? 'Publish the first update and turn this room into a clean announcement stream.'
                          : 'This is a read-only channel for you right now. Owners, admins and posters can publish updates here.'}
                      </p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="chat-composer premium-glass border-t border-white/5 bg-transparent p-3 sm:p-6">
                  {canPostInChannel ? (
                    <ChatComposer
                      onSubmit={handleSendMessage}
                      onSubmitShortcut={submitCurrentMessage}
                      fileInputRef={fileInputRef}
                      onFileChange={handleFileChange}
                      isUploading={isUploading}
                      messageInputRef={messageInputRef}
                      messageInput={messageInput}
                      onMessageChange={handleComposerChange}
                      placeholder="Publish an update..."
                      inputAriaLabel="Channel post input"
                      onTextareaKeyDown={handleComposerKeyDown}
                      mentionSuggestions={mentionSuggestions}
                      mentionSelectionIndex={mentionSelectionIndex}
                      isMentionMenuOpen={isMentionMenuOpen}
                      onMentionSelect={applyMentionSuggestion}
                      isRecording={isRecording}
                      onToggleRecording={() => void (isRecording ? stopRecording() : startRecording())}
                      attachAriaLabel="Attach file to channel"
                      sendAriaLabel="Publish channel post"
                      replyTarget={replyTarget}
                      onCancelReply={() => setReplyTarget(null)}
                    />
                  ) : (
                    <div className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-text-muted">
                      This channel is read-only for your current role. Ask an owner to promote you to `poster` or `admin` if you need to publish updates.
                    </div>
                  )}
                </div>
              </div>

              {canViewChannelSubscribers ? (
              <aside className="hidden border-l border-white/5 bg-white/[0.02] p-5 lg:flex lg:flex-col">
                <div className="text-sm font-semibold uppercase tracking-[0.22em] text-text-muted">Subscribers</div>
                {canManageChannelSubscribers ? (
                  <form onSubmit={handleAddChannelSubscriber} className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-medium text-white">Invite subscriber</div>
                      <button
                        type="button"
                        onClick={() => void handleCopyChannelInviteLink()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-white transition-all hover:border-accent/45 hover:bg-accent/20"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        Copy link
                      </button>
                    </div>
                    <input
                      value={channelSubscriberInput}
                      onChange={(e) => setChannelSubscriberInput(e.target.value)}
                      placeholder="Paste public key"
                      className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none transition-all focus:border-accent/40"
                    />
                    <button
                      type="submit"
                      disabled={isAddingSubscriber || !channelSubscriberInput.trim()}
                      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-medium text-white transition-all hover:border-accent/50 hover:bg-accent/20 disabled:opacity-50"
                    >
                      <UserPlus className="h-4 w-4" />
                      {isAddingSubscriber ? 'Adding...' : 'Add subscriber'}
                    </button>
                  </form>
                ) : null}

                <div className="mt-4 space-y-3 overflow-y-auto custom-scrollbar">
                  {displayedChannelSubscribers.map((subscriber) => (
                    <div key={subscriber.subscriberPubKey} className="rounded-2xl border border-white/10 bg-black/10 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10 text-sm font-bold text-white">
                            {subscriber.subscriberPubKey.substring(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white truncate">
                              {resolveParticipantName(subscriber.subscriberPubKey)}
                            </div>
                            <div className="text-xs text-text-muted">Channel subscriber</div>
                          </div>
                        </div>
                        <div className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-text-muted">
                          {subscriber.role}
                        </div>
                      </div>

                      {(isRoomSettingsOpen && canManageChannelSubscribers) ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {activeChannel?.role === 'owner' ? (
                            <>
                              {subscriber.role === 'admin' ? (
                                <button
                                  type="button"
                                  onClick={() => void handleUpdateChannelRole(subscriber.subscriberPubKey, 'subscriber', 'Admin rights removed.')}
                                  disabled={subscriberActionPubKey === subscriber.subscriberPubKey}
                                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-text-muted transition-all hover:border-white/20 hover:text-white disabled:opacity-50"
                                >
                                  <Shield className="h-3.5 w-3.5" />
                                  Demote to subscriber
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleUpdateChannelRole(subscriber.subscriberPubKey, 'admin', 'Subscriber promoted to admin.')}
                                  disabled={subscriberActionPubKey === subscriber.subscriberPubKey}
                                  className="inline-flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-white transition-all hover:border-accent/50 hover:bg-accent/20 disabled:opacity-50"
                                >
                                  <Shield className="h-3.5 w-3.5" />
                                  Promote to admin
                                </button>
                              )}
                              {subscriber.role === 'poster' ? null : (
                                <button
                                  type="button"
                                  onClick={() => void handleUpdateChannelRole(subscriber.subscriberPubKey, 'poster', 'Subscriber can now post to the channel.')}
                                  disabled={subscriberActionPubKey === subscriber.subscriberPubKey}
                                  className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs text-cyan-50 transition-all hover:border-cyan-300/50 hover:bg-cyan-300/20 disabled:opacity-50"
                                >
                                  <Megaphone className="h-3.5 w-3.5" />
                                  Make poster
                                </button>
                              )}
                              {subscriber.role === 'poster' ? (
                                <button
                                  type="button"
                                  onClick={() => void handleUpdateChannelRole(subscriber.subscriberPubKey, 'subscriber', 'Poster reverted to subscriber.')}
                                  disabled={subscriberActionPubKey === subscriber.subscriberPubKey}
                                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-text-muted transition-all hover:border-white/20 hover:text-white disabled:opacity-50"
                                >
                                  <Megaphone className="h-3.5 w-3.5" />
                                  Remove poster
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void handleTransferChannelOwner(subscriber.subscriberPubKey)}
                                disabled={subscriberActionPubKey === subscriber.subscriberPubKey}
                                className="inline-flex items-center gap-2 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100 transition-all hover:border-amber-300/35 hover:bg-amber-300/15 disabled:opacity-50"
                              >
                                <Crown className="h-3.5 w-3.5" />
                                Transfer ownership
                              </button>
                            </>
                          ) : null}

                          {(activeChannel?.role === 'owner' || (activeChannel?.role === 'admin' && subscriber.role !== 'admin')) ? (
                            <button
                              type="button"
                              onClick={() => void handleRemoveChannelSubscriber(subscriber.subscriberPubKey)}
                              disabled={subscriberActionPubKey === subscriber.subscriberPubKey}
                              className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200 transition-all hover:border-red-400/35 hover:bg-red-400/15 disabled:opacity-50"
                            >
                              <UserMinus className="h-3.5 w-3.5" />
                              Remove
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="mt-5 border-t border-white/10 pt-4">
                  <div className="text-sm font-semibold uppercase tracking-[0.22em] text-text-muted">Activity</div>
                  <div className="mt-3 space-y-2 overflow-y-auto custom-scrollbar">
                    {(channelActivity ?? []).slice(0, 10).map((entry) => {
                      let text: string;
                      switch (entry.type) {
                        case 'post_edited':
                          text = `${resolveParticipantName(entry.actorPubKey)} edited a post`;
                          break;
                        case 'post_deleted':
                          text = `${resolveParticipantName(entry.actorPubKey)} removed a post`;
                          break;
                        case 'post_pinned':
                          text = `${resolveParticipantName(entry.actorPubKey)} pinned a post`;
                          break;
                        case 'post_unpinned':
                          text = `${resolveParticipantName(entry.actorPubKey)} cleared the pinned post`;
                          break;
                        case 'subscriber_added':
                          text = `${resolveParticipantName(entry.actorPubKey)} added ${resolveParticipantName(entry.targetPubKey)}`;
                          break;
                        case 'subscriber_removed':
                          text = `${resolveParticipantName(entry.actorPubKey)} removed ${resolveParticipantName(entry.targetPubKey)}`;
                          break;
                        case 'role_changed':
                          text = `${resolveParticipantName(entry.actorPubKey)} changed ${resolveParticipantName(entry.targetPubKey)} to ${entry.details}`;
                          break;
                        case 'ownership_transferred':
                          text = `${resolveParticipantName(entry.actorPubKey)} transferred ownership to ${resolveParticipantName(entry.targetPubKey)}`;
                          break;
                        case 'channel_deleted':
                          text = `${resolveParticipantName(entry.actorPubKey)} deleted the channel`;
                          break;
                        case 'channel_left':
                          text = `${resolveParticipantName(entry.actorPubKey)} left the channel`;
                          break;
                        default:
                          text = `${resolveParticipantName(entry.actorPubKey)} updated the channel`;
                      }

                      return (
                        <div key={entry.id} className="rounded-2xl border border-white/10 bg-black/10 px-3 py-3">
                          <div className="text-xs text-white">{text}</div>
                          <div className="mt-1 text-[11px] text-text-muted">
                            {new Date(entry.createdAt).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {(channelActivity?.length ?? 0) === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-black/10 px-3 py-4 text-xs text-text-muted">
                        Channel moderation and publishing activity will appear here.
                      </div>
                    ) : null}
                  </div>
                </div>
              </aside>
              ) : null}
            </div>
          </>
        ) : (
          <div className="chat-empty-state flex-1 flex flex-col items-center justify-center px-6 text-center">
            <div className="empty-orb mb-5 flex h-24 w-24 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <ShieldCheck className="h-12 w-12" />
            </div>
            <p className="text-xl font-medium">{t('emptyTitle')}</p>
          </div>
        )}
      </div>
      {viewedIdentityPubKey && (
        <UserIdentityModal 
          pubKey={viewedIdentityPubKey} 
          onClose={() => setViewedIdentityPubKey(null)} 
        />
      )}
    </div>
  );
};
