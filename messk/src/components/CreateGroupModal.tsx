import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Users, Plus, Upload } from 'lucide-react';
import { createGroup } from '../lib/community';
import { toast } from 'react-hot-toast';
import { decodeBase64 } from 'tweetnacl-util';
import { prepareAvatarDataUrl } from '../lib/images';

type CreateGroupModalProps = {
  onClose: () => void;
  onCreated?: () => void;
};

export const CreateGroupModal: React.FC<CreateGroupModalProps> = ({ onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [memberInput, setMemberInput] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validateMemberKey = (value: string) => {
    try {
      const decoded = decodeBase64(value);
      return decoded.length === 32;
    } catch {
      return false;
    }
  };

  const addMember = () => {
    const normalized = memberInput.trim();
    if (!normalized || members.includes(normalized)) {
      setMemberInput('');
      return;
    }
    if (!validateMemberKey(normalized)) {
      toast.error('Member public key must be valid Base64 and 32 bytes long');
      return;
    }
    setMembers((current) => [...current, normalized]);
    setMemberInput('');
  };

  const removeMember = (pubKey: string) => {
    setMembers((current) => current.filter((member) => member !== pubKey));
  };

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setAvatar(await prepareAvatarDataUrl(file));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to prepare avatar');
    } finally {
      event.target.value = '';
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      toast.error('Group title is required');
      return;
    }

    setIsSubmitting(true);
    try {
      await createGroup({
        title: title.trim(),
        avatar,
        members,
      });
      toast.success('Group created');
      onCreated?.();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-950/80 px-3 py-3 backdrop-blur sm:items-center sm:px-4">
      <div className="max-h-[100dvh] w-full max-w-4xl overflow-y-auto rounded-[28px] border border-white/10 bg-slate-950/95 shadow-[0_30px_100px_rgba(0,0,0,0.45)] sm:rounded-[32px]">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent/80">Groups</div>
            <h2 className="mt-1 text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white">Create a team space</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 p-2 text-text-muted transition-colors hover:border-white/20 hover:text-white"
            aria-label="Close group modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 px-6 py-6 sm:px-8">
          <div className="grid gap-6 lg:grid-cols-[168px_minmax(0,1fr)]">
            <label className="group flex aspect-square cursor-pointer flex-col items-center justify-center rounded-[24px] border border-dashed border-white/15 bg-white/[0.03] text-text-muted transition-all hover:border-accent/40 hover:bg-white/[0.05]">
              <div className="h-20 w-20 overflow-hidden rounded-[20px] border border-white/10 bg-gradient-to-br from-accent/25 via-sky-500/15 to-white/5">
                {avatar ? (
                  <img src={avatar} alt="Group avatar" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Upload className="h-8 w-8" />
                  </div>
                )}
              </div>
              <span className="mt-4 text-sm font-medium text-white">Upload cover</span>
              <span className="mt-1 text-xs text-text-muted">PNG or JPG avatar</span>
              <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
            </label>

            <div className="min-w-0 space-y-5">
              <div>
                <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Group title</label>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Product, Core Team, Weekend Raid..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none transition-all focus:border-accent/40 focus:bg-white/10"
                />
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2 text-white">
                  <Users className="h-4 w-4 text-accent" />
                  <span className="text-base font-semibold tracking-[-0.01em]">Invite members</span>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    value={memberInput}
                    onChange={(event) => setMemberInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addMember();
                      }
                    }}
                    placeholder="Paste public key"
                    className="flex-1 rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm outline-none transition-all focus:border-accent/40"
                  />
                  <button
                    type="button"
                    onClick={addMember}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-medium text-white transition-all hover:border-accent/50 hover:bg-accent/20"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </button>
                </div>

                {members.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {members.map((member) => (
                      <button
                        key={member}
                        type="button"
                        onClick={() => removeMember(member)}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/80 transition-colors hover:bg-red-500/10 hover:text-red-200"
                      >
                        {member.slice(0, 10)}... remove
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-text-muted">Start with just you, or add teammates right away.</p>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-white/[0.02] p-4 xl:grid-cols-3">
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent">Private by default</div>
              <div className="mt-2 text-sm leading-6 text-text-muted">Only invited members will see the room.</div>
            </div>
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent">Ready for roles</div>
              <div className="mt-2 text-sm leading-6 text-text-muted">Owner and member roles already exist on the backend.</div>
            </div>
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent">Expandable</div>
              <div className="mt-2 text-sm leading-6 text-text-muted">This UI is ready for future group E2EE messaging.</div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-text-muted">You can rename and enrich the group later.</p>
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
                {isSubmitting ? 'Creating...' : 'Create group'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
