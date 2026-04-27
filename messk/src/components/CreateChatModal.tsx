import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, UserPlus, X } from 'lucide-react';
import { socketManager } from '../lib/socket';
import { toast } from 'react-hot-toast';

type CreateChatModalProps = {
  onClose: () => void;
  onCreate: (publicKey: string) => Promise<boolean> | boolean;
};

export const CreateChatModal: React.FC<CreateChatModalProps> = ({ onClose, onCreate }) => {
  const [publicKey, setPublicKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const inputStr = publicKey.trim();
    if (!inputStr) {
      return;
    }

    setIsSubmitting(true);
    try {
      let targetPubKey = inputStr;
      
      // If it looks like a username (starts with @ or no spaces and short), try to resolve it
      if (inputStr.startsWith('@') || (inputStr.length <= 32 && !inputStr.includes(' ') && !inputStr.endsWith('='))) {
        const resolved = await socketManager.resolveUsername(inputStr);
        if (resolved && resolved.pubKey) {
          targetPubKey = resolved.pubKey;
        } else if (inputStr.startsWith('@')) {
          toast.error('User not found by that handle.');
          setIsSubmitting(false);
          return;
        }
      }

      const didOpen = await onCreate(targetPubKey);
      if (didOpen) {
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-950/80 px-3 py-3 backdrop-blur sm:items-center sm:px-4">
      <div className="max-h-[100dvh] w-full max-w-2xl overflow-y-auto rounded-[28px] border border-white/10 bg-slate-950/95 shadow-[0_30px_100px_rgba(0,0,0,0.45)] sm:rounded-[32px]">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent/80">Chats</div>
            <h2 className="mt-1 text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white">Start a private chat</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 p-2 text-text-muted transition-colors hover:border-white/20 hover:text-white"
            aria-label="Close chat modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 px-4 py-5 sm:px-6 sm:py-6">
          <div className="rounded-[24px] border border-white/10 bg-gradient-to-br from-white/[0.04] to-white/[0.02] p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                <MessageSquare className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold tracking-[-0.01em] text-white">Paste a contact public key</div>
                <div className="mt-1 text-sm leading-6 text-text-muted">
                  This creates a direct encrypted thread and pulls the contact profile as soon as the connection is available.
                </div>
              </div>
            </div>

            <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              Public key or @username
            </label>
            <textarea
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder="Paste the full Base64 public key or type @handle..."
              rows={4}
              className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm leading-6 outline-none transition-all focus:border-accent/40"
            />
          </div>

          <div className="flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-text-muted">You can rename the contact after the chat appears in your list.</p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-white/10 px-4 py-2.5 text-sm text-text-muted transition-all hover:border-white/20 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !publicKey.trim()}
                className="btn-premium inline-flex items-center gap-2 rounded-2xl px-5 py-2.5 text-sm disabled:opacity-60"
              >
                <UserPlus className="h-4 w-4" />
                {isSubmitting ? 'Opening...' : 'Open chat'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
