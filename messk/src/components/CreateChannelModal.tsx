import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Megaphone, Upload, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { createChannel } from '../lib/community';

type CreateChannelModalProps = {
  onClose: () => void;
  onCreated?: () => void;
};

export const CreateChannelModal: React.FC<CreateChannelModalProps> = ({ onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => setAvatar(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      toast.error('Channel title is required');
      return;
    }

    setIsSubmitting(true);
    try {
      await createChannel({ title: title.trim(), avatar });
      toast.success('Channel created');
      onCreated?.();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create channel');
    } finally {
      setIsSubmitting(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur">
      <div className="w-full max-w-4xl rounded-[32px] border border-white/10 bg-slate-950/95 shadow-[0_30px_100px_rgba(0,0,0,0.45)]">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-200/80">Channels</div>
            <h2 className="mt-1 text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white">Create a broadcast space</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 p-2 text-text-muted transition-colors hover:border-white/20 hover:text-white"
            aria-label="Close channel modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 px-6 py-6 sm:px-8">
          <div className="grid gap-6 lg:grid-cols-[168px_minmax(0,1fr)]">
            <label className="group flex aspect-square cursor-pointer flex-col items-center justify-center rounded-[24px] border border-dashed border-white/15 bg-white/[0.03] text-text-muted transition-all hover:border-cyan-300/40 hover:bg-white/[0.05]">
              <div className="h-20 w-20 overflow-hidden rounded-[20px] border border-white/10 bg-gradient-to-br from-cyan-300/25 via-sky-500/15 to-white/5">
                {avatar ? (
                  <img src={avatar} alt="Channel avatar" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Upload className="h-8 w-8" />
                  </div>
                )}
              </div>
              <span className="mt-4 text-sm font-medium text-white">Upload cover</span>
              <span className="mt-1 text-xs text-text-muted">Optional channel avatar</span>
              <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
            </label>

            <div className="min-w-0 space-y-5">
              <div>
                <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Channel title</label>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Announcements, Releases, Roadmap..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none transition-all focus:border-cyan-300/40 focus:bg-white/10"
                />
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2 text-white">
                  <Megaphone className="h-4 w-4 text-cyan-200" />
                  <span className="text-base font-semibold tracking-[-0.01em]">Channel permissions</span>
                </div>
                <div className="mt-2 text-sm leading-6 text-text-muted">
                  Roles stay readable and stack safely first, then spread into columns on wider layouts.
                </div>
                <div className="mt-4 grid gap-3 xl:grid-cols-3">
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Owner</div>
                    <div className="mt-2 text-sm leading-6 text-text-muted">Full control, transfer ownership, delete the channel.</div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Admin</div>
                    <div className="mt-2 text-sm leading-6 text-text-muted">Manage subscribers and help moderate distribution.</div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Poster</div>
                    <div className="mt-2 text-sm leading-6 text-text-muted">Reserved for read-only channel posting workflows.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-text-muted">Invite subscribers and tune roles after creation.</p>
            <div className="flex items-center gap-3 self-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-white/10 px-4 py-2.5 text-sm text-text-muted transition-all hover:border-white/20 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-premium rounded-2xl px-5 py-2.5 text-sm disabled:opacity-60"
              >
                {isSubmitting ? 'Creating...' : 'Create channel'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
