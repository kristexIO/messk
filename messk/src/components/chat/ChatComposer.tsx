import React from 'react';
import { Loader2, Mic, Paperclip, Send, Square } from 'lucide-react';
import { MentionSuggestions, type MentionSuggestion } from './MentionSuggestions';

type ChatComposerProps = {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void | Promise<void>;
  onSubmitShortcut: () => void | Promise<void>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: React.ChangeEventHandler<HTMLInputElement>;
  isUploading: boolean;
  messageInputRef: React.RefObject<HTMLTextAreaElement | null>;
  messageInput: string;
  onMessageChange: (nextValue: string, caretPosition: number) => void;
  placeholder: string;
  recordingPlaceholder?: string;
  inputAriaLabel: string;
  onTextareaKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  mentionSuggestions: MentionSuggestion[];
  mentionSelectionIndex: number;
  isMentionMenuOpen: boolean;
  onMentionSelect: (candidate: MentionSuggestion) => void;
  isRecording: boolean;
  onToggleRecording: () => void;
  attachAriaLabel: string;
  sendAriaLabel: string;
  accentTone?: 'accent' | 'violet';
  onTypingChange?: (nextValue: string) => void;
};

export function ChatComposer({
  onSubmit,
  onSubmitShortcut,
  fileInputRef,
  onFileChange,
  isUploading,
  messageInputRef,
  messageInput,
  onMessageChange,
  placeholder,
  recordingPlaceholder = 'Listening...',
  inputAriaLabel,
  onTextareaKeyDown,
  mentionSuggestions,
  mentionSelectionIndex,
  isMentionMenuOpen,
  onMentionSelect,
  isRecording,
  onToggleRecording,
  attachAriaLabel,
  sendAriaLabel,
  accentTone = 'accent',
  onTypingChange,
}: ChatComposerProps) {
  const focusAccentClass =
    accentTone === 'violet' ? 'focus-within:border-violet-300/40' : 'focus-within:border-accent/40';
  const voiceHoverClass =
    accentTone === 'violet' ? 'text-text-muted hover:text-violet-200' : 'text-text-muted hover:text-accent';

  return (
    <form onSubmit={onSubmit} className="mx-auto flex max-w-5xl items-end gap-2 sm:gap-3">
      <input type="file" className="hidden" ref={fileInputRef} onChange={onFileChange} />

      <div className={`composer-input relative flex flex-1 items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-2 transition-all ${focusAccentClass} focus-within:bg-white/10`}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="p-2 text-text-muted transition-colors hover:text-white"
          aria-label={attachAriaLabel}
        >
          {isUploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
        </button>

        <textarea
          ref={messageInputRef}
          value={messageInput}
          onChange={(event) => {
            const nextValue = event.target.value;
            onMessageChange(nextValue, event.target.selectionStart ?? nextValue.length);
            onTypingChange?.(nextValue);
          }}
          placeholder={isRecording ? recordingPlaceholder : placeholder}
          className="min-h-[44px] max-h-32 flex-1 resize-none border-none bg-transparent px-2 py-2.5 text-[15px] outline-none focus:ring-0"
          aria-label={inputAriaLabel}
          onKeyDown={(event) => {
            onTextareaKeyDown(event);
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!isMentionMenuOpen) {
                void onSubmitShortcut();
              }
            }
          }}
        />

        {isMentionMenuOpen ? (
          <MentionSuggestions
            suggestions={mentionSuggestions}
            selectedIndex={mentionSelectionIndex}
            onSelect={onMentionSelect}
          />
        ) : null}

        {!messageInput.trim() && !isUploading ? (
          <button
            type="button"
            onClick={onToggleRecording}
            className={`rounded-xl p-2.5 transition-all ${isRecording ? 'animate-pulse bg-red-500 text-white' : voiceHoverClass}`}
            aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
          >
            {isRecording ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
        ) : null}
      </div>

      {messageInput.trim() || isUploading ? (
        <button
          type="submit"
          disabled={isUploading}
          className="btn-premium h-11 w-11 flex-shrink-0 rounded-2xl sm:h-12 sm:w-12"
          aria-label={sendAriaLabel}
        >
          <Send className="h-5 w-5" />
        </button>
      ) : null}
    </form>
  );
}
