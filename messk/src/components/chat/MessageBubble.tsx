import React from 'react';
import { AlertCircle, Check, CheckCheck, Clock3, CornerUpRight, Download, FileIcon, Pencil, Pin, Play, Reply, RotateCcw, Square, Trash2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { decryptFile } from '../../lib/attachments';
import { type StoredMessage } from '../../lib/db';
import { parseRichTextMessage, type MessageMention, type ReplyPreview } from '../../lib/message-format';
import { VoiceWaveform } from '../VoiceWaveform';
import { normalizeReactionValue } from './messageUtils';

export type DownloadFileFn = (url: string, key: string, name: string) => Promise<void>;

type FilePayload = {
  url: string;
  key: string;
  name: string;
  size: number;
  mimeType?: string;
};

type VoicePayload = {
  url: string;
  key: string;
  duration?: number;
};

type ParsedMessageContent =
  | { kind: 'text'; text: string; mentions: MessageMention[]; replyTo?: ReplyPreview }
  | { kind: 'file'; payload: FilePayload }
  | { kind: 'voice'; payload: VoicePayload };

const QUICK_REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F525}'];

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeFilePayload(value: Record<string, unknown>): FilePayload | null {
  const url = typeof value.url === 'string' ? value.url : '';
  const key = typeof value.key === 'string' ? value.key : '';
  if (!url || !key) return null;
  const name =
    typeof value.name === 'string' && value.name.trim()
      ? value.name
      : typeof value.filename === 'string' && value.filename.trim()
        ? value.filename
        : 'attachment.bin';
  const size = typeof value.size === 'number' && Number.isFinite(value.size) ? Math.max(0, value.size) : 0;
  const mimeType =
    typeof value.mimeType === 'string'
      ? value.mimeType
      : typeof value.mime_type === 'string'
        ? value.mime_type
        : typeof value.mime === 'string'
          ? value.mime
          : undefined;
  return { url, key, name, size, mimeType };
}

function normalizeVoicePayload(value: Record<string, unknown>): VoicePayload | null {
  const url = typeof value.url === 'string' ? value.url : '';
  const key = typeof value.key === 'string' ? value.key : '';
  if (!url || !key) return null;
  const duration = typeof value.duration === 'number' && Number.isFinite(value.duration) ? value.duration : undefined;
  return { url, key, duration };
}

function parseMessageContent(text: string): ParsedMessageContent {
  const json = parseJsonObject(text);
  const payloadType = typeof json?.type === 'string' ? json.type.toLowerCase() : '';
  if (json && ['file', 'attachment', 'image', 'video', 'document'].includes(payloadType)) {
    const payload = normalizeFilePayload(json);
    if (payload) {
      return {
        kind: 'file',
        payload,
      };
    }
    return { kind: 'text', text, mentions: [] };
  }

  if (json && ['voice', 'audio', 'voice_message'].includes(payloadType)) {
    const payload = normalizeVoicePayload(json);
    if (payload) {
      return {
        kind: 'voice',
        payload,
      };
    }
    return { kind: 'text', text, mentions: [] };
  }

  const parsedRichText = parseRichTextMessage(text);
  return { kind: 'text', text: parsedRichText.text, mentions: parsedRichText.mentions, replyTo: parsedRichText.replyTo };
}

function findFirstUrl(text: string): URL | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  try {
    return new URL(match[0]);
  } catch {
    return null;
  }
}

function LinkPreview({ text }: { text: string }) {
  const url = React.useMemo(() => findFirstUrl(text), [text]);
  if (!url) return null;

  return (
    <a
      href={url.toString()}
      target="_blank"
      rel="noreferrer"
      className="mt-3 block rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-left transition-colors hover:bg-black/25"
    >
      <div className="text-[11px] font-semibold uppercase text-white/55">{url.hostname.replace(/^www\./, '')}</div>
      <div className="mt-1 truncate text-sm font-medium text-white/90">{url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`}</div>
    </a>
  );
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
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

const VoiceMessage = React.memo(({ voiceData, downloadFile }: { voiceData: VoicePayload; downloadFile: DownloadFileFn }) => {
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [playbackRate, setPlaybackRate] = React.useState<1 | 1.5 | 2>(1);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

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
        audioRef.current.playbackRate = playbackRate;
        audioRef.current.onended = () => setIsPlaying(false);
      } catch {
        toast.error('Failed to decrypt voice message');
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
        type="button"
        onClick={() => setPlaybackRate((current) => (current === 1 ? 1.5 : current === 1.5 ? 2 : 1))}
        className="rounded-lg border border-white/10 px-2 py-1 text-[11px] font-semibold text-white/75 transition-colors hover:bg-white/10 hover:text-white"
        title="Playback speed"
      >
        {playbackRate}x
      </button>
      <button
        onClick={() => downloadFile(voiceData.url, voiceData.key, 'voice.webm')}
        className="p-2 text-white/50 hover:text-white transition-colors"
      >
        <Download className="w-4 h-4" />
      </button>
    </div>
  );
});

type MessageBubbleProps = {
  msg: StoredMessage;
  isMine: boolean;
  isGroupMessage?: boolean;
  downloadFile: DownloadFileFn;
  onEdit: (msg: StoredMessage) => void;
  onDelete: (msg: StoredMessage) => void;
  onReact: (msg: StoredMessage, reaction: string) => void;
  onReply?: (msg: StoredMessage) => void;
  onForward?: (msg: StoredMessage) => void;
  onRetry?: (msg: StoredMessage) => void;
  canModerate?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  onPin?: (msg: StoredMessage) => void;
  onMentionClick?: (pubKey: string) => void;
  isEditing?: boolean;
  editDraft?: string;
  onEditDraftChange?: (value: string) => void;
  onEditSave?: () => void;
  onEditCancel?: () => void;
  retryDetails?: string;
};

export const MessageBubble = React.memo(({
  msg,
  isMine,
  isGroupMessage,
  downloadFile,
  onEdit,
  onDelete,
  onReact,
  onReply,
  onForward,
  onRetry,
  canModerate = false,
  canPin = false,
  isPinned = false,
  onPin,
  onMentionClick,
  isEditing = false,
  editDraft = '',
  onEditDraftChange,
  onEditSave,
  onEditCancel,
  retryDetails,
}: MessageBubbleProps) => {
  const isDeleted = Boolean(msg.deletedAt);
  const reactionEntries = React.useMemo(
    () =>
      Object.entries(msg.reactions ?? {})
        .map(([senderKey, reaction]) => [senderKey, normalizeReactionValue(reaction) ?? reaction] as const),
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

  const editInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    if (!isEditing) return;
    editInputRef.current?.focus();
    editInputRef.current?.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length);
  }, [isEditing]);

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
            {onReply ? (
              <button
                type="button"
                onClick={() => onReply(msg)}
                className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                title="Reply"
              >
                <Reply className="w-3.5 h-3.5" />
              </button>
            ) : null}
            {onForward ? (
              <button
                type="button"
                onClick={() => onForward(msg)}
                className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                title="Forward"
              >
                <CornerUpRight className="w-3.5 h-3.5" />
              </button>
            ) : null}
            {isMine && onRetry && (msg.status === 'pending' || msg.status === 'failed') ? (
              <button
                type="button"
                onClick={() => onRetry(msg)}
                className={`rounded-lg p-1.5 transition-colors ${msg.status === 'failed' ? 'text-red-200 hover:bg-red-500/20' : 'text-amber-100 hover:bg-amber-400/20'}`}
                title={retryDetails || 'Retry send'}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            ) : null}
            {isMine || canModerate ? (
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
        {!isDeleted && parsedContent.kind === 'text' && parsedContent.replyTo ? (
          <div className="mb-2 rounded-xl border-l-2 border-white/35 bg-black/15 px-3 py-2">
            <div className="text-[11px] font-semibold text-white/65">Reply to {parsedContent.replyTo.senderPubKey.slice(0, 8)}...</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-white/75">{parsedContent.replyTo.preview}</div>
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
                  <p className="text-[10px] opacity-60">
                    {[parsedContent.payload.mimeType, formatFileSize(parsedContent.payload.size)].filter(Boolean).join(' - ')}
                  </p>
                </div>
                <Download className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
          ) : parsedContent.kind === 'voice' ? (
            <VoiceMessage voiceData={parsedContent.payload} downloadFile={downloadFile} />
          ) : isEditing ? (
            <div className="space-y-2">
              <textarea
                ref={editInputRef}
                value={editDraft ?? ''}
                onChange={(e) => onEditDraftChange?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    onEditCancel?.();
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onEditSave?.();
                  }
                }}
                className="w-full min-h-[80px] rounded-xl border border-white/15 bg-black/20 px-3 py-2 text-[14px] outline-none"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onEditCancel} className="rounded-lg border border-white/20 px-3 py-1.5 text-xs">Cancel</button>
                <button type="button" onClick={onEditSave} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs text-white">Save</button>
              </div>
            </div>
          ) : (
            <>
              {renderTextWithMentions(parsedContent.text, parsedContent.mentions, onMentionClick)}
              <LinkPreview text={parsedContent.text} />
            </>
          )}
        </div>
        {hasReactions ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {reactionEntries.map(([senderKey, reaction]) => (
              <button
                key={`${msg.msgId}-${senderKey}`}
                type="button"
                onClick={() => onReact(msg, normalizeReactionValue(reaction) ?? reaction)}
                className="rounded-full border border-white/10 bg-black/15 px-2 py-0.5 text-xs text-white/80 transition-colors hover:bg-black/25"
              >
                {normalizeReactionValue(reaction) ?? reaction}
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
          {msg.editedAt && !msg.deletedAt ? (
            <span className="text-[10px] font-medium">
              {new Date(msg.editedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null}
          {msg.deletedAt && msg.deletedBy && msg.deletedBy !== msg.senderPublicKey ? (
            <span className="text-[10px] font-medium">removed by moderator</span>
          ) : null}
          <span className="text-[10px] font-medium">
            {formattedTimestamp}
          </span>
          {isMine && (
            <span className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[10px] font-medium uppercase tracking-wide">
                {msg.status === 'failed'
                  ? 'error'
                  : msg.status === 'pending'
                  ? 'pending'
                  : msg.status === 'read' && !isGroupMessage
                    ? 'read'
                    : msg.status === 'delivered'
                      ? (isGroupMessage ? 'distributed' : 'delivered')
                      : 'sent'}
              </span>
              {msg.status === 'failed' ? (
                <AlertCircle className="w-3.5 h-3.5 text-red-300" />
              ) : msg.status === 'pending' ? (
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
