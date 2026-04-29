import React, { useDeferredValue, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { socketManager } from '../lib/socket';
import { clearThreadStats, db, syncThreadStats, type StoredMessage } from '../lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { Send, ArrowLeft, ShieldCheck, Check, CheckCheck, Trash2, Paperclip, FileIcon, Download, Loader2, Mic, Square, Play, Phone, Video, Pencil, Search, X, Archive, Bell, BellOff, ArrowDownCircle, Users, Crown, WifiOff, Clock3, UserPlus, UserMinus, Shield, Megaphone, Pin, AtSign, Link2 } from 'lucide-react';
import { UserIdentityModal } from '../components/UserIdentityModal';
import { Sidebar } from '../components/Sidebar';
import { encryptFile, decryptFile } from '../lib/attachments';
import { CallOverlay } from '../components/CallOverlay';
import { VoiceWaveform } from '../components/VoiceWaveform';
import { toast } from 'react-hot-toast';
import { appConfig } from '../lib/config';
import { fetchWithTimeout, toNetworkErrorMessage, UPLOAD_REQUEST_TIMEOUT_MS } from '../lib/http';
import { encodeRichTextMessage, isMentioningPubKey, parseRichTextMessage, type MessageMention } from '../lib/message-format';
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
  listChannelSubscribers,
  listGroupMembers,
  removeChannelSubscriber,
  removeGroupMember,
  transferChannelOwnership,
  transferGroupOwnership,
  updateChannelSubscriberRole,
  updateGroupMemberRole
} from '../lib/community';
import { decodeBase64 } from 'tweetnacl-util';

type DownloadFileFn = (url: string, key: string, name: string) => Promise<void>;

type FilePayload = {
  url: string;
  key: string;
  name: string;
  size: number;
};

type VoicePayload = {
  url: string;
  key: string;
};

type ParsedMessageContent =
  | { kind: 'text'; text: string; mentions: MessageMention[] }
  | { kind: 'file'; payload: FilePayload }
  | { kind: 'voice'; payload: VoicePayload };

const MAX_ATTACHMENT_SIZE_BYTES = 75 * 1024 * 1024;

function safeGroupMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((member): member is string => typeof member === 'string' && member.length > 0);
}

function parseMessageContent(text: string): ParsedMessageContent {
  if (text.startsWith('{"type":"file"')) {
    try {
      return {
        kind: 'file',
        payload: JSON.parse(text) as FilePayload,
      };
    } catch {
      return { kind: 'text', text, mentions: [] };
    }
  }

  if (text.startsWith('{"type":"voice"')) {
    try {
      return {
        kind: 'voice',
        payload: JSON.parse(text) as VoicePayload,
      };
    } catch {
      return { kind: 'text', text, mentions: [] };
    }
  }

  const parsedRichText = parseRichTextMessage(text);
  return { kind: 'text', text: parsedRichText.text, mentions: parsedRichText.mentions };
}

function renderTextWithMentions(text: string, mentions: MessageMention[], onMentionClick?: (pubKey: string) => void) {
  if (!mentions.length) {
    return text;
  }

  const mentionByStart = new Map<number, MessageMention>();
  mentions.forEach((mention) => mentionByStart.set(mention.start, mention));
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const mention = mentionByStart.get(cursor);
    if (!mention) {
      let nextCursor = cursor + 1;
      while (nextCursor < text.length && !mentionByStart.has(nextCursor)) {
        nextCursor++;
      }
      parts.push(text.slice(cursor, nextCursor));
      cursor = nextCursor;
      continue;
    }

    const token = text.slice(mention.start, mention.end);
    parts.push(
      <span
        key={`${mention.start}:${mention.handle}`}
        className="font-semibold text-cyan-200 cursor-pointer hover:underline"
        onClick={() => onMentionClick?.(mention.pubKey)}
      >
        {token}
      </span>
    );
    cursor = mention.end;
  }

  return parts;
}

function fallbackParticipantName(pubKey: string) {
  return `${pubKey.substring(0, 12)}...`;
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

const QUICK_REACTIONS = ['👍', '❤️', '🔥'];
const INITIAL_MESSAGE_RENDER_LIMIT = 120;
const MESSAGE_RENDER_STEP = 120;

const VoiceMessage = React.memo(({ voiceData, downloadFile }: { voiceData: VoicePayload; downloadFile: DownloadFileFn }) => {
  const [isPlaying, setIsPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const togglePlay = async () => {
    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    if (!audioRef.current) {
      try {
        const blob = await decryptFile(voiceData.url, voiceData.key);
        const url = URL.createObjectURL(blob);
        audioRef.current = new Audio(url);
        audioRef.current.onended = () => setIsPlaying(false);
      } catch {
        toast.error("Failed to decrypt voice message");
        return;
      }
    }

    await audioRef.current.play();
    setIsPlaying(true);
  };

  return (
    <div className="flex items-center gap-3 p-2 bg-black/10 rounded-2xl min-w-[220px]">
      <button
        onClick={togglePlay}
        className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-white hover:bg-white/30 transition-colors"
      >
        {isPlaying ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-5 h-5 fill-current ml-1" />}
      </button>
      <div className="flex-1">
        <VoiceWaveform />
      </div>
      <button
        onClick={() => downloadFile(voiceData.url, voiceData.key, 'voice.webm')}
        className="p-2 text-white/50 hover:text-white transition-colors"
      >
        <Download className="w-4 h-4" />
      </button>
    </div>
  );
});

const MessageBubble = React.memo(({
  msg,
  isMine,
  isGroupMessage,
  downloadFile,
  onEdit,
  onDelete,
  onReact,
  canPin = false,
  isPinned = false,
  onPin,
  onMentionClick
}: {
  msg: StoredMessage;
  isMine: boolean;
  isGroupMessage?: boolean;
  downloadFile: DownloadFileFn;
  onEdit: (msg: StoredMessage) => void;
  onDelete: (msg: StoredMessage) => void;
  onReact: (msg: StoredMessage, reaction: string) => void;
  canPin?: boolean;
  isPinned?: boolean;
  onPin?: (msg: StoredMessage) => void;
  onMentionClick?: (pubKey: string) => void;
}) => {
  const isDeleted = Boolean(msg.deletedAt);
  const reactionEntries = React.useMemo(
    () => Object.entries(msg.reactions ?? {}),
    [msg.reactions]
  );
  const hasReactions = reactionEntries.length > 0;
  const parsedContent = React.useMemo(
    () => parseMessageContent(msg.text),
    [msg.text]
  );
  const formattedTimestamp = React.useMemo(
    () => new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    [msg.timestamp]
  );

  return (
    <div className={`group flex w-full animate-in slide-in-from-bottom-2 duration-300 ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`
        max-w-[75%] relative ${
          isMine
            ? 'chat-bubble-send'
            : 'chat-bubble-recv'
        }
      `}>
        {!isDeleted ? (
          <div className={`absolute -top-9 ${isMine ? 'right-0' : 'left-0'} flex items-center gap-1 rounded-2xl border border-white/10 bg-slate-950/90 px-2 py-1 opacity-0 shadow-xl transition-opacity group-hover:opacity-100`}>
            {QUICK_REACTIONS.map((reaction) => (
              <button
                key={reaction}
                onClick={() => onReact(msg, reaction)}
                className="rounded-lg px-1.5 py-1 text-sm transition-colors hover:bg-white/10"
                type="button"
              >
                {reaction}
              </button>
            ))}
            {isMine ? (
              <>
                <button
                  type="button"
                  onClick={() => onEdit(msg)}
                  className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(msg)}
                  className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-red-500/20 hover:text-red-300"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            ) : null}
            {canPin && onPin ? (
              <button
                type="button"
                onClick={() => onPin(msg)}
                className={`rounded-lg p-1.5 transition-colors ${isPinned ? 'text-amber-200 hover:bg-amber-400/20' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
              >
                <Pin className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">
          {isDeleted ? (
            <span className="italic text-white/50">Message deleted</span>
          ) : parsedContent.kind === 'file' ? (
            <div className="flex flex-col gap-2">
              <div
                className="flex items-center gap-3 p-3 bg-black/10 rounded-xl border border-white/5 group cursor-pointer"
                onClick={() => downloadFile(parsedContent.payload.url, parsedContent.payload.key, parsedContent.payload.name)}
              >
                <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center text-white/80">
                  <FileIcon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{parsedContent.payload.name}</p>
                  <p className="text-[10px] opacity-60">{(parsedContent.payload.size / 1024).toFixed(1)} KB</p>
                </div>
                <Download className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
          ) : parsedContent.kind === 'voice' ? (
            <VoiceMessage voiceData={parsedContent.payload} downloadFile={downloadFile} />
          ) : (
            renderTextWithMentions(parsedContent.text, parsedContent.mentions, onMentionClick)
          )}
        </div>
        {hasReactions ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {reactionEntries.map(([senderKey, reaction]) => (
              <button
                key={`${msg.msgId}-${senderKey}`}
                type="button"
                onClick={() => onReact(msg, reaction)}
                className="rounded-full border border-white/10 bg-black/15 px-2 py-0.5 text-xs text-white/80 transition-colors hover:bg-black/25"
              >
                {reaction}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-1 mt-2 opacity-60">
          {msg.editedAt && !msg.deletedAt ? (
            <span className="text-[10px] font-medium">
              {msg.editedBy && msg.editedBy !== msg.senderPublicKey ? 'edited by moderator' : 'edited'}
            </span>
          ) : null}
          {msg.deletedAt && msg.deletedBy && msg.deletedBy !== msg.senderPublicKey ? (
            <span className="text-[10px] font-medium">removed by moderator</span>
          ) : null}
          <span className="text-[10px] font-medium">
            {formattedTimestamp}
          </span>
          {isMine && (
            <span className="flex-shrink-0">
              {msg.status === 'pending' ? (
                <Clock3 className="w-3.5 h-3.5 text-amber-200" />
              ) : msg.status === 'read' && !isGroupMessage ? (
                <CheckCheck className="w-3.5 h-3.5 text-emerald-300" />
              ) : msg.status === 'delivered' ? (
                <CheckCheck className="w-3.5 h-3.5 text-blue-200" />
              ) : (
                <Check className="w-3 h-3" />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

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
  const queuedGroupEvents = useLiveQuery(() => {
    if (!activeGroupId) return [];
    return db.outgoingGroupEvents.where('groupId').equals(activeGroupId).sortBy('createdAt');
  }, [activeGroupId]);
  const isChatMuted = Boolean(activeContact?.mutedUntil && activeContact.mutedUntil > nowTs);
  const canManageGroupMembers = activeGroup?.role === 'owner' || activeGroup?.role === 'admin';
  const canManageChannelSubscribers = activeChannel?.role === 'owner' || activeChannel?.role === 'admin';
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
        matches = msg.text.toLowerCase().includes(deferredMessageSearch);
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
    const candidates: Array<{ pubKey: string; displayName: string; handle: string }> = [];
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
    void Promise.resolve().then(() => {
      setMentionQuery('');
      setMentionStartIndex(null);
      setMentionSelectionIndex(0);
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
    if (!activeGroupId) return;

    void listGroupMembers(activeGroupId)
      .then((members) => setGroupMembersMeta(members))
      .catch((error) => {
        console.warn('Failed to load group members metadata', error);
      });
  }, [activeGroupId, activeGroup?.memberCount, activeGroup?.role, activeGroupMembersKey]);

  useEffect(() => {
    if (!activeChannelId) return;

    void listChannelSubscribers(activeChannelId)
      .then((subscribers) => setChannelSubscribersMeta(subscribers))
      .catch((error) => {
        console.warn('Failed to load channel subscribers metadata', error);
      });
  }, [activeChannelId, activeChannel?.subscriberCount, activeChannel?.role]);

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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim() || !myPublicKey) return;

    const plaintext = encodeRichTextMessage(messageInput.trim(), mentionHandleDirectory);

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
    } catch (err) {
      console.error("Failed to send", err);
      toast.error(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !mySecretKey || !myPublicKey || (!activePeerKey && !activeGroupId && !activeChannelId)) return;
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
  };

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
      const url = await createGroupInviteLink(activeGroupId);
      await navigator.clipboard.writeText(url);
      toast.success('Group invite link copied.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create group invite link');
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
      const url = await createChannelInviteLink(activeChannelId);
      await navigator.clipboard.writeText(url);
      toast.success('Channel invite link copied.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create channel invite link');
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
    handleEditMessage(msg);
  };

  const handleReaction = (msg: StoredMessage, reaction: string) => {
    void handleReactToMessage(msg, reaction);
  };
  const handleEditMessage = async (msg: StoredMessage) => {
    if ((!activePeerKey && !activeGroupId && !activeChannelId) || !myPublicKey || msg.deletedAt) return;
    if (activeChannelId && msg.senderPublicKey !== myPublicKey && activeChannel?.role !== 'owner' && activeChannel?.role !== 'admin') {
      toast.error('Only owners, admins or the original author can edit this channel post.');
      return;
    }
    const nextText = window.prompt('Edit message', msg.text);
    if (!nextText || nextText.trim() === msg.text.trim()) return;
    const encodedText = encodeRichTextMessage(nextText.trim(), mentionHandleDirectory);

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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to edit message');
    }
  };

  const handleDeleteMessage = async (msg: StoredMessage) => {
    if ((!activePeerKey && !activeGroupId && !activeChannelId) || !myPublicKey || msg.deletedAt) return;
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
    const currentReaction = msg.reactions?.[myPublicKey];
    const nextReaction = currentReaction === reaction ? null : reaction;
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

  return (
    <div className="messk-shell app-shell-height flex overflow-hidden">
      <Sidebar />
      <CallOverlay />

      <div className={`
        ${activePeerKey || activeGroupId || activeChannelId ? 'flex' : 'hidden md:flex'}
        chat-stage w-full flex-col flex-1 relative
      `}>
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
                        <span className="rounded-full border border-violet-300/20 bg-violet-300/10 px-2 py-0.5 text-[10px] font-medium text-violet-200">
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
                  <Archive className={`w-5 h-5 ${activeContact?.archived ? 'text-violet-300' : ''}`} />
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
                        onMentionClick={handleMentionClick}
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
              <form onSubmit={handleSendMessage} className="mx-auto flex max-w-5xl items-end gap-2 sm:gap-3">
                <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileChange} />

                <div className="composer-input relative flex flex-1 items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-2 transition-all focus-within:border-accent/40 focus-within:bg-white/10">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="p-2 text-text-muted hover:text-white transition-colors"
                    aria-label="Attach file"
                  >
                    {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
                  </button>

                  <textarea
                    ref={messageInputRef}
                    value={messageInput}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      handleComposerChange(nextValue, e.target.selectionStart ?? nextValue.length);
                      if (activePeerKey && myPublicKey && nextValue.trim()) {
                        const now = Date.now();
                        if (now - lastTypingSentRef.current > 1500) {
                          socketManager.sendTyping(activePeerKey, myPublicKey);
                          lastTypingSentRef.current = now;
                        }
                      }
                    }}
                    placeholder={isRecording ? "Listening..." : "Message..."}
                    className="min-h-[44px] max-h-32 flex-1 resize-none border-none bg-transparent px-2 py-2.5 text-[15px] outline-none focus:ring-0"
                    aria-label="Message input"
                    onKeyDown={(e) => {
                      handleComposerKeyDown(e);
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!isMentionMenuOpen) {
                          handleSendMessage(e);
                        }
                      }
                    }}
                  />
                  {isMentionMenuOpen ? (
                    <div className="absolute bottom-16 left-16 z-30 w-64 rounded-2xl border border-white/15 bg-slate-950/95 p-2 shadow-2xl backdrop-blur">
                      {mentionSuggestions.map((candidate, index) => (
                        <button
                          key={candidate.pubKey}
                          type="button"
                          onClick={() => applyMentionSuggestion(candidate)}
                          className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-all ${
                            mentionSelectionIndex === index
                              ? 'bg-accent/20 text-white'
                              : 'text-text-muted hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          <span className="truncate">{candidate.displayName}</span>
                          <span className="ml-2 font-mono text-[11px] text-accent">@{candidate.handle}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {!messageInput.trim() && !isUploading && (
                    <button
                      type="button"
                      onClick={isRecording ? stopRecording : startRecording}
                      className={`p-2.5 rounded-xl transition-all ${isRecording ? 'bg-red-500 text-white animate-pulse' : 'text-text-muted hover:text-accent'}`}
                      aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
                    >
                      {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                    </button>
                  )}
                </div>

                {messageInput.trim() || isUploading ? (
                  <button
                    type="submit"
                    disabled={isUploading}
                    className="btn-premium h-11 w-11 rounded-2xl flex-shrink-0 sm:h-12 sm:w-12"
                    aria-label="Send message"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                ) : null}
              </form>
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
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100">
                <Crown className="h-3.5 w-3.5" />
                {activeGroup.role}
              </div>
            </header>

            <div className="px-4 pt-3 sm:px-6 sm:pt-4">
              <div className="flex flex-wrap gap-2">
                {canManageGroupMembers ? (
                  <button
                    type="button"
                    onClick={() => void handleCopyGroupInviteLink()}
                    className="inline-flex items-center gap-2 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-white transition-all hover:border-accent/45 hover:bg-accent/20"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    Copy invite link
                  </button>
                ) : null}
                {activeGroup.role !== 'owner' ? (
                  <button
                    type="button"
                    onClick={() => void handleLeaveGroup()}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200 transition-all hover:border-red-400/35 hover:bg-red-400/15"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                    Leave group
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleLeaveGroup()}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200 transition-all hover:border-red-400/35 hover:bg-red-400/15"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete group
                  </button>
                )}
              </div>
            </div>

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
                          onMentionClick={handleMentionClick}
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
                  <form onSubmit={handleSendMessage} className="mx-auto flex max-w-5xl items-end gap-2 sm:gap-3">
                    <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileChange} />
                    <div className="composer-input relative flex flex-1 items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-2 transition-all focus-within:border-accent/40 focus-within:bg-white/10">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="p-2 text-text-muted hover:text-white transition-colors"
                        aria-label="Attach file to group"
                      >
                        {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
                      </button>
                      <textarea
                        ref={messageInputRef}
                        value={messageInput}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          handleComposerChange(nextValue, e.target.selectionStart ?? nextValue.length);
                        }}
                        placeholder="Message the group..."
                        className="min-h-[44px] max-h-32 flex-1 resize-none border-none bg-transparent px-2 py-2.5 text-[15px] outline-none focus:ring-0"
                        aria-label="Group message input"
                        onKeyDown={(e) => {
                          handleComposerKeyDown(e);
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (!isMentionMenuOpen) {
                              void handleSendMessage(e);
                            }
                          }
                        }}
                      />
                      {isMentionMenuOpen ? (
                        <div className="absolute bottom-16 left-16 z-30 w-64 rounded-2xl border border-white/15 bg-slate-950/95 p-2 shadow-2xl backdrop-blur">
                          {mentionSuggestions.map((candidate, index) => (
                            <button
                              key={candidate.pubKey}
                              type="button"
                              onClick={() => applyMentionSuggestion(candidate)}
                              className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-all ${
                                mentionSelectionIndex === index
                                  ? 'bg-accent/20 text-white'
                                  : 'text-text-muted hover:bg-white/10 hover:text-white'
                              }`}
                            >
                              <span className="truncate">{candidate.displayName}</span>
                              <span className="ml-2 font-mono text-[11px] text-accent">@{candidate.handle}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {!messageInput.trim() && !isUploading && (
                        <button
                          type="button"
                          onClick={isRecording ? stopRecording : startRecording}
                          className={`p-2.5 rounded-xl transition-all ${isRecording ? 'bg-red-500 text-white animate-pulse' : 'text-text-muted hover:text-accent'}`}
                          aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
                        >
                          {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                        </button>
                      )}
                    </div>

                    {messageInput.trim() || isUploading ? (
                      <button
                        type="submit"
                        disabled={isUploading}
                        className="btn-premium h-11 w-11 rounded-2xl flex-shrink-0 sm:h-12 sm:w-12"
                        aria-label="Send group message"
                      >
                        <Send className="w-5 h-5" />
                      </button>
                    ) : null}
                  </form>
                </div>
              </div>

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
                          {member.memberPubKey === myPublicKey ? activeGroup.role : member.role}
                        </div>
                      </div>
                      {canManageGroupMembers && member.memberPubKey !== myPublicKey && member.role !== 'owner' ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {activeGroup.role === 'owner' ? (
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
                          {(activeGroup.role === 'owner' || (activeGroup.role === 'admin' && member.role === 'member')) ? (
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
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-400/20 to-white/5 border border-white/10 flex items-center justify-center text-white shadow-xl relative overflow-hidden">
                    {activeChannel.avatar ? (
                      <img src={activeChannel.avatar} alt={activeChannel.title} className="h-full w-full object-cover" />
                    ) : (
                      <span className="font-bold text-lg">{activeChannel.title.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-white truncate">{activeChannel.title}</h2>
                    <p className="text-[11px] text-violet-200 font-medium flex items-center gap-1 opacity-80">
                      <Megaphone className="w-3.5 h-3.5" /> {activeChannel.subscriberCount} subscribers
                    </p>
                  </div>
                </div>
              </div>
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-300/10 px-3 py-1.5 text-xs font-medium text-violet-100">
                <Crown className="h-3.5 w-3.5" />
                {activeChannel.role}
              </div>
            </header>

            <div className="px-6 pt-4">
              <div className="flex flex-wrap gap-2">
                {canManageChannelSubscribers ? (
                  <button
                    type="button"
                    onClick={() => void handleCopyChannelInviteLink()}
                    className="inline-flex items-center gap-2 rounded-xl border border-violet-300/25 bg-violet-300/10 px-3 py-2 text-xs text-white transition-all hover:border-violet-300/45 hover:bg-violet-300/20"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    Copy invite link
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleLeaveChannel()}
                  className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200 transition-all hover:border-red-400/35 hover:bg-red-400/15"
                >
                  {activeChannel.role === 'owner' ? <Trash2 className="h-3.5 w-3.5" /> : <UserMinus className="h-3.5 w-3.5" />}
                  {activeChannel.role === 'owner' ? 'Delete channel' : 'Leave channel'}
                </button>
              </div>
            </div>

            <div className="grid flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-h-0 flex-col">
                {pinnedChannelMessage && !pinnedChannelMessage.deletedAt ? (
                  <div className="mx-6 mt-4 rounded-2xl border border-violet-300/20 bg-violet-300/10 px-4 py-3 text-sm text-violet-50">
                    <div className="flex items-center gap-2 font-medium">
                      <Pin className="h-4 w-4" />
                      Pinned post
                    </div>
                    <div className="mt-1 text-xs text-violet-100/80">
                      {pinnedChannelMessage.text.startsWith('{"type":"file"')
                        ? 'Attachment'
                        : pinnedChannelMessage.text.startsWith('{"type":"voice"')
                          ? 'Voice message'
                          : pinnedChannelMessage.text}
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
                            <div className="rounded-full border border-violet-300/30 bg-slate-950/85 px-3 py-1 text-xs font-medium text-violet-100 shadow-lg backdrop-blur">
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
                            canPin={canPinChannelPosts}
                            isPinned={activeChannel?.pinnedMsgId === msg.msgId}
                            onPin={handleToggleChannelPin}
                            onMentionClick={handleMentionClick}
                          />
                        </div>
                      </React.Fragment>
                    ))
                  ) : (
                    <div className="empty-thread-card h-full flex flex-col items-center justify-center text-center">
                      <Megaphone className="w-16 h-16 mb-4 text-violet-200" />
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
                    <form onSubmit={handleSendMessage} className="mx-auto flex max-w-5xl items-end gap-2 sm:gap-3">
                      <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileChange} />
                      <div className="composer-input relative flex flex-1 items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-2 transition-all focus-within:border-violet-300/40 focus-within:bg-white/10">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isUploading}
                          className="p-2 text-text-muted hover:text-white transition-colors"
                          aria-label="Attach file to channel"
                        >
                          {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
                        </button>
                        <textarea
                          ref={messageInputRef}
                          value={messageInput}
                          onChange={(e) => {
                            const nextValue = e.target.value;
                            handleComposerChange(nextValue, e.target.selectionStart ?? nextValue.length);
                          }}
                          placeholder="Publish an update..."
                          className="min-h-[44px] max-h-32 flex-1 resize-none border-none bg-transparent px-2 py-2.5 text-[15px] outline-none focus:ring-0"
                          aria-label="Channel post input"
                          onKeyDown={(e) => {
                            handleComposerKeyDown(e);
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              if (!isMentionMenuOpen) {
                                void handleSendMessage(e);
                              }
                            }
                          }}
                        />
                        {isMentionMenuOpen ? (
                          <div className="absolute bottom-16 left-16 z-30 w-64 rounded-2xl border border-white/15 bg-slate-950/95 p-2 shadow-2xl backdrop-blur">
                            {mentionSuggestions.map((candidate, index) => (
                              <button
                                key={candidate.pubKey}
                                type="button"
                                onClick={() => applyMentionSuggestion(candidate)}
                                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-all ${
                                  mentionSelectionIndex === index
                                    ? 'bg-accent/20 text-white'
                                    : 'text-text-muted hover:bg-white/10 hover:text-white'
                                }`}
                              >
                                <span className="truncate">{candidate.displayName}</span>
                                <span className="ml-2 font-mono text-[11px] text-accent">@{candidate.handle}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {!messageInput.trim() && !isUploading && (
                          <button
                            type="button"
                            onClick={isRecording ? stopRecording : startRecording}
                            className={`p-2.5 rounded-xl transition-all ${isRecording ? 'bg-red-500 text-white animate-pulse' : 'text-text-muted hover:text-violet-200'}`}
                            aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
                          >
                            {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                          </button>
                        )}
                      </div>

                      {messageInput.trim() || isUploading ? (
                        <button
                          type="submit"
                          disabled={isUploading}
                          className="btn-premium h-11 w-11 rounded-2xl flex-shrink-0 sm:h-12 sm:w-12"
                          aria-label="Publish channel post"
                        >
                          <Send className="w-5 h-5" />
                        </button>
                      ) : null}
                    </form>
                  ) : (
                    <div className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-text-muted">
                      This channel is read-only for your current role. Ask an owner to promote you to `poster` or `admin` if you need to publish updates.
                    </div>
                  )}
                </div>
              </div>

              <aside className="hidden border-l border-white/5 bg-white/[0.02] p-5 lg:flex lg:flex-col">
                <div className="text-sm font-semibold uppercase tracking-[0.22em] text-text-muted">Subscribers</div>
                {canManageChannelSubscribers ? (
                  <form onSubmit={handleAddChannelSubscriber} className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-medium text-white">Invite subscriber</div>
                      <button
                        type="button"
                        onClick={() => void handleCopyChannelInviteLink()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300/25 bg-violet-300/10 px-2.5 py-1 text-[11px] font-medium text-white transition-all hover:border-violet-300/45 hover:bg-violet-300/20"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        Copy link
                      </button>
                    </div>
                    <input
                      value={channelSubscriberInput}
                      onChange={(e) => setChannelSubscriberInput(e.target.value)}
                      placeholder="Paste public key"
                      className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none transition-all focus:border-violet-300/40"
                    />
                    <button
                      type="submit"
                      disabled={isAddingSubscriber || !channelSubscriberInput.trim()}
                      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-violet-300/30 bg-violet-300/10 px-3 py-2 text-xs font-medium text-white transition-all hover:border-violet-300/50 hover:bg-violet-300/20 disabled:opacity-50"
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

                      {canManageChannelSubscribers && subscriber.subscriberPubKey !== myPublicKey && subscriber.role !== 'owner' ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {activeChannel.role === 'owner' ? (
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
                                  className="inline-flex items-center gap-2 rounded-xl border border-violet-300/30 bg-violet-300/10 px-3 py-2 text-xs text-white transition-all hover:border-violet-300/50 hover:bg-violet-300/20 disabled:opacity-50"
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

                          {(activeChannel.role === 'owner' || (activeChannel.role === 'admin' && subscriber.role !== 'admin')) ? (
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
                      let text = '';
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
            </div>
          </>
        ) : (
          <div className="chat-empty-state flex-1 flex flex-col items-center justify-center px-6 text-center opacity-80">
            <div className="empty-orb w-32 h-32 rounded-full border-2 border-dashed border-white/20 flex items-center justify-center mb-6">
              <ShieldCheck className="w-16 h-16" />
            </div>
            <p className="text-xl font-medium">{t('emptyTitle')}</p>
            <p className="mt-2 max-w-md text-sm text-text-muted">
              {t('emptySubtitle')}
            </p>
            <div className="mt-6 grid w-full max-w-2xl grid-cols-1 gap-3 md:grid-cols-3">
              <div className="feature-tile rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left">
                <div className="text-xs font-semibold uppercase tracking-wide text-accent">{t('findFaster')}</div>
                <div className="mt-1 text-sm text-text-muted">{t('findFasterText')}</div>
              </div>
              <div className="feature-tile rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left">
                <div className="text-xs font-semibold uppercase tracking-wide text-accent">{t('buildRooms')}</div>
                <div className="mt-1 text-sm text-text-muted">{t('buildRoomsText')}</div>
              </div>
              <div className="feature-tile rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left">
                <div className="text-xs font-semibold uppercase tracking-wide text-accent">{t('recoverSafely')}</div>
                <div className="mt-1 text-sm text-text-muted">{t('recoverSafelyText')}</div>
              </div>
            </div>
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
