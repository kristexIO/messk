import React from 'react';
import { BellOff, Download, KeyRound, Search, ShieldCheck, X } from 'lucide-react';

interface OnboardingModalProps {
  onClose: () => void;
}

const steps = [
  {
    icon: KeyRound,
    title: 'Start Securely',
    body: 'Paste a public key in the sidebar to open your first encrypted chat. Your seed phrase remains the only way to recover your identity.',
  },
  {
    icon: BellOff,
    title: 'Stay Focused',
    body: 'Mute a chat for 8 hours, archive it when you want a cleaner inbox, and jump back into unread messages in one click.',
  },
  {
    icon: Download,
    title: 'Back Up Safely',
    body: 'Export encrypted backups from Settings to keep profile, contacts and history available without exposing your secret keys.',
  },
];

const shortcuts = [
  'Ctrl + F searches inside the active chat',
  'Ctrl + Shift + M mutes or unmutes the active chat',
  'Ctrl + Shift + A archives or restores the active chat',
  'Escape clears chat search or returns to the chat list',
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md">
      <div className="premium-glass relative w-full max-w-4xl overflow-hidden rounded-[36px] border border-white/10 shadow-2xl animate-in fade-in zoom-in duration-300">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -left-10 top-0 h-48 w-48 rounded-full bg-accent/15 blur-[100px]" />
          <div className="absolute bottom-0 right-0 h-56 w-56 rounded-full bg-blue-500/10 blur-[120px]" />
        </div>

        <div className="relative border-b border-white/10 px-8 py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close onboarding"
            className="absolute right-6 top-6 rounded-full p-2 text-text-muted transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent shadow-[0_0_20px_var(--accent-glow)]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent/80">Welcome</p>
              <h2 className="text-2xl font-bold text-white">Your secure workspace is ready</h2>
            </div>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-text-muted">
            Messk is set up for end-to-end encrypted conversations, local vault protection and encrypted backups. Here are the fastest ways to feel at home.
          </p>
        </div>

        <div className="relative grid gap-6 px-8 py-8 md:grid-cols-3">
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-black/20 text-accent">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-text-muted">{step.body}</p>
              </div>
            );
          })}
        </div>

        <div className="relative grid gap-6 border-t border-white/10 px-8 py-6 md:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-white/10 bg-black/20 p-6">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Search className="h-4 w-4 text-accent" />
              Fast shortcuts
            </div>
            <div className="mt-4 grid gap-3 text-sm text-text-muted">
              {shortcuts.map((shortcut) => (
                <div key={shortcut} className="rounded-2xl bg-white/5 px-4 py-3">
                  {shortcut}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <div className="text-sm font-semibold">Release-ready defaults already enabled</div>
            <div className="mt-4 space-y-3 text-sm text-text-muted">
              <div className="rounded-2xl bg-black/20 px-4 py-3">Encrypted local storage for sensitive records</div>
              <div className="rounded-2xl bg-black/20 px-4 py-3">PIN lock support with keyboard unlock flow</div>
              <div className="rounded-2xl bg-black/20 px-4 py-3">Muted, archived and unread-focused chat workflow</div>
            </div>
          </div>
        </div>

        <div className="relative flex flex-col gap-3 border-t border-white/10 px-8 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-text-muted">
            You can reopen guidance later from Settings and keep building from a stable encrypted base.
          </p>
          <button type="button" onClick={onClose} className="btn-premium px-6 py-3">
            Start Messaging
          </button>
        </div>
      </div>
    </div>
  );
};
