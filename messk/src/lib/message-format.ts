import { displayMessageText } from './protocolContract';

export type MessageMention = {
  pubKey: string;
  handle: string;
  start: number;
  end: number;
};

export type ReplyPreview = {
  msgId: string;
  senderPubKey: string;
  preview: string;
};

export type RichTextMessagePayload = {
  type: 'text';
  text: string;
  mentions?: MessageMention[];
  replyTo?: ReplyPreview;
};

export function parseRichTextMessage(value: string): { text: string; mentions: MessageMention[]; replyTo?: ReplyPreview; hasRichPayload: boolean } {
  if (!value.startsWith('{"type":"text"')) {
    return { text: value, mentions: [], hasRichPayload: false };
  }

  try {
    const parsed = JSON.parse(value) as Partial<RichTextMessagePayload>;
    if (parsed.type !== 'text' || typeof parsed.text !== 'string') {
      return { text: value, mentions: [], hasRichPayload: false };
    }
    const mentions = Array.isArray(parsed.mentions)
      ? parsed.mentions.filter((mention): mention is MessageMention =>
          Boolean(
            mention &&
            typeof mention.pubKey === 'string' &&
            typeof mention.handle === 'string' &&
            Number.isInteger(mention.start) &&
            Number.isInteger(mention.end)
          )
        )
      : [];
    const replyTo = normalizeReplyPreview(parsed.replyTo);
    return { text: parsed.text, mentions, replyTo, hasRichPayload: true };
  } catch {
    return { text: value, mentions: [], hasRichPayload: false };
  }
}

export function encodeRichTextMessage(text: string, handleDirectory: Record<string, string>, replyTo?: ReplyPreview | null): string {
  const mentions = extractMentions(text, handleDirectory);
  const payload: RichTextMessagePayload = {
    type: 'text',
    text,
    mentions: mentions.length ? mentions : undefined,
    replyTo: replyTo ?? undefined,
  };
  return JSON.stringify(payload);
}

function normalizeReplyPreview(value: unknown): ReplyPreview | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<ReplyPreview>;
  if (
    typeof candidate.msgId !== 'string' ||
    typeof candidate.senderPubKey !== 'string' ||
    typeof candidate.preview !== 'string'
  ) {
    return undefined;
  }
  return {
    msgId: candidate.msgId,
    senderPubKey: candidate.senderPubKey,
    preview: candidate.preview.slice(0, 160),
  };
}

export function extractMentions(text: string, handleDirectory: Record<string, string>): MessageMention[] {
  const mentions: MessageMention[] = [];
  const mentionRegex = /(^|\s)@([a-z0-9._-]{2,32})/gi;
  let match: RegExpExecArray | null = mentionRegex.exec(text);
  const seen = new Set<string>();

  while (match) {
    const full = match[0];
    const handle = match[2].toLowerCase();
    const pubKey = handleDirectory[handle];
    if (pubKey) {
      const atIndex = match.index + full.lastIndexOf('@');
      const mentionId = `${atIndex}:${handle}`;
      if (!seen.has(mentionId)) {
        seen.add(mentionId);
        mentions.push({
          pubKey,
          handle,
          start: atIndex,
          end: atIndex + handle.length + 1,
        });
      }
    }
    match = mentionRegex.exec(text);
  }

  return mentions;
}

export function getMessageNotificationPreview(rawMessage: string): string {
  return displayMessageText(rawMessage).slice(0, 80) || 'New message';
}

export function isMentioningPubKey(rawMessage: string, pubKey: string): boolean {
  const parsed = parseRichTextMessage(rawMessage);
  return parsed.mentions.some((mention) => mention.pubKey === pubKey);
}
