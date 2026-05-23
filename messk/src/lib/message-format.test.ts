import { describe, expect, it } from 'vitest';
import { getMessageNotificationPreview, parseRichTextMessage } from './message-format';

describe('message-format', () => {
  it('keeps malformed local message records renderable', () => {
    expect(parseRichTextMessage(undefined).text).toBe('');
    expect(parseRichTextMessage({ type: 'text', text: 'object payload' }).text).toBe('object payload');
    expect(getMessageNotificationPreview(undefined)).toBe('New message');
  });
});
